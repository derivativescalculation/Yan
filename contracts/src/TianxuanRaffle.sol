// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IVRFCoordinatorV2Plus, VRFV2PlusClient} from "./interfaces/IVRFCoordinatorV2Plus.sol";

/// @title TianxuanRaffle - three pots of YAN, drawn among holders
/// @notice YAN arrives from every mint (5%) and every sale (the token's 0.5% sell tax). `sync()` splits
///         each inflow 40% / 20% / 40% into three pots that open at 20,000, 100,000 and 1,000,000 YAN.
///
///         When a pot fills, its block is recorded on-chain as the draw's snapshot. The keeper commits
///         the ticket list for that snapshot as a Merkle root: one ticket per 10,000 YAN of each
///         holder's lowest balance in the hour before the snapshot, built off-chain from public
///         balances and published so anyone can rebuild it. Committing requests a Chainlink VRF random
///         word, and the winning ticket is `random % totalTickets`. Anyone can then settle by proving
///         which holder owns that ticket, and the prize is transferred to the holder in the same
///         transaction. The list is locked before the random word exists, so nobody can steer the
///         result.
///
///         Nobody can withdraw from the pots: YAN leaves only as prizes. The owner can only change the
///         keeper and the VRF subscription settings; the coordinator is immutable.
contract TianxuanRaffle is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint256 public constant POTS = 3;
    /// @notice a committed draw whose random word has not arrived can be re-requested after this
    uint256 public constant RETRY_AFTER = 1 days;

    enum Status {
        None,
        Committed,
        Random,
        Settled,
        Void
    }

    struct Pot {
        uint256 balance;
        uint256 threshold;
        uint16 shareBps;
        uint64 fullAtBlock; // snapshot block of the next draw; 0 while the pot is not full
        uint32 opened; // settled draws
        uint64 activeDraw; // draw in progress, 0 if none
    }

    struct Draw {
        uint8 pot;
        Status status;
        uint64 snapshotBlock;
        uint64 committedAt;
        uint256 totalTickets;
        uint256 prize;
        uint256 requestId;
        uint256 random;
        bytes32 root;
        address winner;
    }

    IERC20 public immutable token;
    IVRFCoordinatorV2Plus public immutable coordinator;

    uint256 public subscriptionId;
    bytes32 public keyHash;
    uint32 public callbackGasLimit = 100_000;
    uint16 public requestConfirmations = 3;
    address public keeper;

    Pot[3] public pots;
    mapping(uint256 id => Draw) public draws;
    mapping(uint256 requestId => uint256 id) public drawOfRequest;
    uint256 public drawCount;
    /// @notice YAN held for the pots and for prizes in flight
    uint256 public accounted;
    uint256 public paidOut;

    event Synced(uint256 inflow, uint256 toJade, uint256 toCinnabar, uint256 toGold);
    event PotFull(uint256 indexed pot, uint256 snapshotBlock);
    event DrawCommitted(
        uint256 indexed id, uint256 indexed pot, uint256 snapshotBlock, bytes32 root, uint256 totalTickets, uint256 prize, uint256 requestId
    );
    event DrawVoid(uint256 indexed id, uint256 indexed pot, uint256 snapshotBlock);
    event DrawRandom(uint256 indexed id, uint256 requestId, uint256 random, uint256 winningTicket);
    event DrawRetried(uint256 indexed id, uint256 requestId);
    event DrawSettled(uint256 indexed id, uint256 indexed pot, address indexed winner, uint256 prize, uint256 winningTicket);
    event KeeperSet(address keeper);
    event VrfSet(uint256 subscriptionId, bytes32 keyHash, uint32 callbackGasLimit, uint16 requestConfirmations);

    error ZeroAddress();
    error NotKeeper();
    error OnlyCoordinator(address have, address want);
    error BadPot();
    error NotFull();
    error DrawActive();
    error WrongSnapshot(uint256 expected);
    error BadRoot();
    error NotReady();
    error NotPending();
    error TooEarly();
    error NotWinningTicket();
    error BadProof();

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert NotKeeper();
        _;
    }

    constructor(address token_, address coordinator_, uint256 subId, bytes32 keyHash_, address keeper_, address owner_)
        Ownable(owner_)
    {
        if (token_ == address(0) || coordinator_ == address(0) || keeper_ == address(0)) revert ZeroAddress();
        token = IERC20(token_);
        coordinator = IVRFCoordinatorV2Plus(coordinator_);
        subscriptionId = subId;
        keyHash = keyHash_;
        keeper = keeper_;
        pots[0] = Pot({balance: 0, threshold: 20_000e18, shareBps: 4_000, fullAtBlock: 0, opened: 0, activeDraw: 0});
        pots[1] = Pot({balance: 0, threshold: 100_000e18, shareBps: 2_000, fullAtBlock: 0, opened: 0, activeDraw: 0});
        pots[2] = Pot({balance: 0, threshold: 1_000_000e18, shareBps: 4_000, fullAtBlock: 0, opened: 0, activeDraw: 0});
    }

    // ---------------------------------------------------------------- inflows

    /// @notice Split any YAN that arrived since the last sync into the three pots. Anyone may call;
    ///         the minter calls it on every mint.
    function sync() public {
        uint256 bal = token.balanceOf(address(this));
        if (bal <= accounted) return;
        uint256 inflow = bal - accounted;
        accounted = bal;
        uint256 a = inflow * pots[0].shareBps / BPS;
        uint256 b = inflow * pots[1].shareBps / BPS;
        uint256 c = inflow - a - b;
        _credit(0, a);
        _credit(1, b);
        _credit(2, c);
        emit Synced(inflow, a, b, c);
    }

    function _credit(uint256 i, uint256 amount) internal {
        Pot storage p = pots[i];
        p.balance += amount;
        _markIfFull(i);
    }

    function _markIfFull(uint256 i) internal {
        Pot storage p = pots[i];
        if (p.fullAtBlock == 0 && p.activeDraw == 0 && p.balance >= p.threshold) {
            p.fullAtBlock = uint64(block.number);
            emit PotFull(i, block.number);
        }
    }

    // ---------------------------------------------------------------- draws

    /// @notice Commit the ticket list for pot `i` at its recorded snapshot and request the random word.
    ///         With zero tickets the draw is void and the snapshot restarts at the current block.
    function commit(uint256 i, uint256 snapshotBlock, bytes32 root, uint256 totalTickets)
        external
        onlyKeeper
        returns (uint256 id)
    {
        if (i >= POTS) revert BadPot();
        sync();
        Pot storage p = pots[i];
        if (p.activeDraw != 0) revert DrawActive();
        if (p.fullAtBlock == 0) revert NotFull();
        if (snapshotBlock != p.fullAtBlock) revert WrongSnapshot(p.fullAtBlock);

        id = ++drawCount;
        Draw storage d = draws[id];
        d.pot = uint8(i);
        d.snapshotBlock = uint64(snapshotBlock);
        d.committedAt = uint64(block.timestamp);
        d.totalTickets = totalTickets;

        if (totalTickets == 0) {
            d.status = Status.Void;
            p.fullAtBlock = uint64(block.number);
            emit DrawVoid(id, i, snapshotBlock);
            emit PotFull(i, block.number);
            return id;
        }
        if (root == bytes32(0)) revert BadRoot();

        d.root = root;
        d.prize = p.threshold;
        d.status = Status.Committed;
        p.balance -= p.threshold;
        p.fullAtBlock = 0;
        p.activeDraw = uint64(id);
        d.requestId = _request();
        drawOfRequest[d.requestId] = id;
        emit DrawCommitted(id, i, snapshotBlock, root, totalTickets, d.prize, d.requestId);
    }

    /// @notice Chainlink VRF callback. Stores the random word; settlement happens in `settle`.
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external {
        if (msg.sender != address(coordinator)) revert OnlyCoordinator(msg.sender, address(coordinator));
        uint256 id = drawOfRequest[requestId];
        Draw storage d = draws[id];
        if (id == 0 || d.status != Status.Committed || d.requestId != requestId) return; // superseded request
        d.random = randomWords[0];
        d.status = Status.Random;
        emit DrawRandom(id, requestId, randomWords[0], randomWords[0] % d.totalTickets);
    }

    /// @notice Pay the holder of the winning ticket. `start` and `count` are the holder's ticket range in
    ///         the committed list; anyone may call with the published proof.
    function settle(uint256 id, address winner, uint256 start, uint256 count, bytes32[] calldata proof)
        external
        nonReentrant
    {
        Draw storage d = draws[id];
        if (d.status != Status.Random) revert NotReady();
        uint256 ticket = d.random % d.totalTickets;
        if (ticket < start || ticket >= start + count) revert NotWinningTicket();
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(winner, start, count))));
        if (!MerkleProof.verifyCalldata(proof, d.root, leaf)) revert BadProof();

        d.status = Status.Settled;
        d.winner = winner;
        Pot storage p = pots[d.pot];
        p.activeDraw = 0;
        p.opened += 1;
        accounted -= d.prize;
        paidOut += d.prize;
        _markIfFull(d.pot);

        token.safeTransfer(winner, d.prize);
        emit DrawSettled(id, d.pot, winner, d.prize, ticket);
    }

    /// @notice Re-request the random word for a draw that never received one.
    function retry(uint256 id) external onlyKeeper {
        Draw storage d = draws[id];
        if (d.status != Status.Committed) revert NotPending();
        if (block.timestamp < d.committedAt + RETRY_AFTER) revert TooEarly();
        delete drawOfRequest[d.requestId];
        d.committedAt = uint64(block.timestamp);
        d.requestId = _request();
        drawOfRequest[d.requestId] = id;
        emit DrawRetried(id, d.requestId);
    }

    function _request() internal returns (uint256) {
        return coordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: keyHash,
                subId: subscriptionId,
                requestConfirmations: requestConfirmations,
                callbackGasLimit: callbackGasLimit,
                numWords: 1,
                extraArgs: VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({nativePayment: true}))
            })
        );
    }

    // ---------------------------------------------------------------- views

    /// @notice YAN received but not yet split into the pots
    function pending() external view returns (uint256) {
        uint256 bal = token.balanceOf(address(this));
        return bal > accounted ? bal - accounted : 0;
    }

    // ---------------------------------------------------------------- admin

    function setKeeper(address keeper_) external onlyOwner {
        if (keeper_ == address(0)) revert ZeroAddress();
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    function setVrf(uint256 subId, bytes32 keyHash_, uint32 gasLimit, uint16 confirmations) external onlyOwner {
        subscriptionId = subId;
        keyHash = keyHash_;
        callbackGasLimit = gasLimit;
        requestConfirmations = confirmations;
        emit VrfSet(subId, keyHash_, gasLimit, confirmations);
    }
}
