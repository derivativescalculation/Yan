// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SuanToken} from "./SuanToken.sol";
import {IAgentIdRegistry} from "./interfaces/IAgentIdRegistry.sol";
import {IAggregatorV3} from "./interfaces/IAggregatorV3.sol";

/// @title ProofOfInference - the only mint path for YAN
/// @notice Only wallets holding a Binance .ai Agent ID can mint. An agent pays BNB, either by calling
///         `mine()` or by sending BNB to this contract. The payment is valued in USD with the Chainlink
///         BNB/USD feed, mints YAN to the agent at the current epoch rate and books the USD value as
///         inference credit on the agent's wallet.
///
///         Every EPOCH_SIZE tokens the mint rate is multiplied by decayBps/10000. Each Agent ID can mint
///         at most `maxPerAgentPerEpoch` tokens per epoch (0 = no cap), so every epoch is spread across
///         many agents. One Agent ID exists per Binance user.
///
///         BNB is split in the same transaction: burnBps to the BuybackBurner, the rest to the ops
///         treasury (which pays for the AI compute agents use).
///
///         Utility: YAN is always redeemable for inference credit (`redeem`) at the genesis rate times
///         redeemBps, constant across epochs, so the redemption liability is bounded.
///
///         The owner can only pause minting. Rates, caps, split, feed, registry and destinations are
///         immutable.
contract ProofOfInference is Ownable2Step, Pausable, ReentrancyGuard {
    uint256 public constant EPOCH_SIZE = 100_000_000e18; // rate steps down every 100M tokens
    uint256 public constant MAX_EPOCH = 9; // 10 epochs x 100M = 1B cap
    uint256 public constant BPS = 10_000;

    struct Config {
        address token;
        address priceFeed;
        uint256 maxPriceAge;
        address agentIds;
        address opsTreasury;
        address burner;
        uint256 burnBps;
        uint256 initialTokensPerUsd;
        uint256 decayBps;
        uint256 minPaymentUsd;
        uint256 redeemBps;
        uint256 maxPerAgentPerEpoch;
        address owner;
    }

    SuanToken public immutable token;
    IAggregatorV3 public immutable priceFeed;
    uint256 public immutable feedScale; // 10 ** feed decimals
    uint256 public immutable maxPriceAge; // seconds
    IAgentIdRegistry public immutable agentIds;
    address public immutable opsTreasury;
    address public immutable burner;
    uint256 public immutable burnBps;
    /// @notice tokens (1e18) minted per 1 USD (1e18) in epoch 0
    uint256 public immutable initialTokensPerUsd;
    /// @notice per-epoch rate multiplier in bps (7000 = x0.7 each epoch)
    uint256 public immutable decayBps;
    /// @notice smallest accepted payment, in 1e18 USD
    uint256 public immutable minPaymentUsd;
    /// @notice share of genesis mint value credited when redeeming tokens for compute
    uint256 public immutable redeemBps;
    /// @notice max tokens one Agent ID can mint within one epoch (0 = unlimited)
    uint256 public immutable maxPerAgentPerEpoch;

    /// @notice cumulative USD credit (1e18) per wallet; the gateway meters usage off-chain against this
    mapping(address wallet => uint256 usd) public creditsUsd;
    /// @notice cumulative tokens mined per agent wallet
    mapping(address wallet => uint256 amount) public minedBy;
    /// @notice tokens mined per agent wallet per epoch (for the per-agent cap)
    mapping(address wallet => mapping(uint256 epoch => uint256 amount)) public minedInEpoch;
    mapping(address wallet => uint256 amount) public redeemedBy;
    uint256 public totalUsdPaid;
    uint256 public totalWeiPaid;
    uint256 public totalMinted;
    uint256 public totalRedeemed;
    uint256 public agentCount;
    mapping(address wallet => bool) public seen;

    event Mined(
        address indexed agent,
        string handle,
        uint256 usdAmount18,
        uint256 tokensMinted,
        uint256 epochAfter,
        uint256 weiPaid
    );
    event Redeemed(address indexed wallet, uint256 tokensBurned, uint256 creditUsd18);

    error NotAnAgent(address caller);
    error BelowMinimum();
    error CapReached();
    error AgentEpochCap(uint256 remaining);
    error ZeroAddress();
    error BadBps();
    error BadRate();
    error BadPrice();
    error StalePrice();
    error ZeroAmount();
    error TransferFailed();

    constructor(Config memory c) Ownable(c.owner) {
        if (
            c.token == address(0) || c.priceFeed == address(0) || c.agentIds == address(0)
                || c.opsTreasury == address(0) || c.burner == address(0)
        ) revert ZeroAddress();
        if (c.burnBps >= BPS || c.redeemBps > BPS || c.decayBps == 0 || c.decayBps >= BPS) revert BadBps();
        if (c.initialTokensPerUsd == 0 || c.minPaymentUsd == 0 || c.maxPriceAge == 0) revert BadRate();
        token = SuanToken(c.token);
        priceFeed = IAggregatorV3(c.priceFeed);
        feedScale = 10 ** IAggregatorV3(c.priceFeed).decimals();
        maxPriceAge = c.maxPriceAge;
        agentIds = IAgentIdRegistry(c.agentIds);
        opsTreasury = c.opsTreasury;
        burner = c.burner;
        burnBps = c.burnBps;
        initialTokensPerUsd = c.initialTokensPerUsd;
        decayBps = c.decayBps;
        minPaymentUsd = c.minPaymentUsd;
        redeemBps = c.redeemBps;
        maxPerAgentPerEpoch = c.maxPerAgentPerEpoch;
    }

    // ---------------------------------------------------------------- identity

    /// @notice the .ai handle of `wallet` (without suffix), empty if it holds no Agent ID
    function handleOf(address wallet) public view returns (string memory) {
        return agentIds.handleOf(wallet);
    }

    function isAgent(address wallet) public view returns (bool) {
        return bytes(agentIds.handleOf(wallet)).length != 0;
    }

    // ---------------------------------------------------------------- price

    /// @notice USD (1e18) per 1 BNB from the Chainlink feed. Reverts on a non-positive or stale answer.
    function bnbUsd() public view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = priceFeed.latestRoundData();
        if (answer <= 0 || updatedAt == 0) revert BadPrice();
        if (updatedAt + maxPriceAge < block.timestamp) revert StalePrice();
        return uint256(answer) * 1e18 / feedScale;
    }

    /// @notice USD value (1e18) of `weiAmount` at the current feed price
    function usdOf(uint256 weiAmount) public view returns (uint256) {
        return weiAmount * bnbUsd() / 1e18;
    }

    // ---------------------------------------------------------------- views

    function currentEpoch() public view returns (uint256) {
        return totalMinted / EPOCH_SIZE;
    }

    /// @notice tokens per USD in a given epoch (0 past the last epoch)
    function rateAt(uint256 epoch) public view returns (uint256 r) {
        if (epoch > MAX_EPOCH) return 0;
        r = initialTokensPerUsd;
        for (uint256 i; i < epoch; i++) r = r * decayBps / BPS;
    }

    /// @notice tokens per USD at the current epoch (0 once the cap is reached)
    function tokensPerUsd() public view returns (uint256) {
        return rateAt(currentEpoch());
    }

    /// @notice USD (1e18) needed to mint every remaining token, across all epochs
    function costToCap() public view returns (uint256 usd18) {
        uint256 minted = totalMinted;
        for (uint256 e = minted / EPOCH_SIZE; e <= MAX_EPOCH; e++) {
            uint256 room = (e + 1) * EPOCH_SIZE - minted;
            uint256 rate = rateAt(e);
            usd18 += (room * 1e18 + rate - 1) / rate; // round up: paying costToCap mints to the cap
            minted += room;
        }
    }

    /// @notice wei needed to mint every remaining token at the current feed price (rounded up)
    function costToCapWei() external view returns (uint256) {
        uint256 p = bnbUsd();
        return (costToCap() * 1e18 + p - 1) / p;
    }

    /// @notice tokens that paying `weiAmount` would mint right now, walking across epoch boundaries
    function quote(uint256 weiAmount) external view returns (uint256 tokens) {
        (tokens,) = _emission(usdOf(weiAmount), totalMinted);
    }

    /// @notice tokens that `usd18` of payment would mint right now
    function quoteUsd(uint256 usd18) external view returns (uint256 tokens) {
        (tokens,) = _emission(usd18, totalMinted);
    }

    /// @notice tokens `wallet` may still mint in the current epoch (type(uint256).max when uncapped)
    function remainingThisEpoch(address wallet) public view returns (uint256) {
        if (maxPerAgentPerEpoch == 0) return type(uint256).max;
        uint256 used = minedInEpoch[wallet][currentEpoch()];
        return used >= maxPerAgentPerEpoch ? 0 : maxPerAgentPerEpoch - used;
    }

    /// @notice USD credit (1e18) that burning `tokens` grants. Constant: genesis rate x redeemBps.
    function quoteRedeem(uint256 tokens) public view returns (uint256 usd18) {
        usd18 = tokens * 1e18 / initialTokensPerUsd * redeemBps / BPS;
    }

    // ---------------------------------------------------------------- mining

    /// @notice Pay BNB for inference credit; mints YAN to the caller. Caller must hold a .ai Agent ID.
    function mine() external payable returns (uint256 minted) {
        return _mine();
    }

    /// @notice Sending BNB straight to this contract mines for the sender.
    receive() external payable {
        _mine();
    }

    function _mine() internal whenNotPaused nonReentrant returns (uint256 minted) {
        string memory handle = agentIds.handleOf(msg.sender);
        if (bytes(handle).length == 0) revert NotAnAgent(msg.sender);
        uint256 usd18 = usdOf(msg.value);
        if (usd18 < minPaymentUsd) revert BelowMinimum();

        uint256 epochNow = totalMinted / EPOCH_SIZE;
        uint256 epochAfter;
        (minted, epochAfter) = _emission(usd18, totalMinted);
        if (minted == 0) revert CapReached();
        if (maxPerAgentPerEpoch != 0) {
            uint256 used = minedInEpoch[msg.sender][epochNow];
            if (used + minted > maxPerAgentPerEpoch) {
                revert AgentEpochCap(used >= maxPerAgentPerEpoch ? 0 : maxPerAgentPerEpoch - used);
            }
        }

        // account before external calls
        minedInEpoch[msg.sender][epochNow] += minted;
        creditsUsd[msg.sender] += usd18;
        minedBy[msg.sender] += minted;
        totalUsdPaid += usd18;
        totalWeiPaid += msg.value;
        totalMinted += minted;
        if (!seen[msg.sender]) {
            seen[msg.sender] = true;
            agentCount += 1;
        }

        token.mint(msg.sender, minted);

        uint256 toBurn = msg.value * burnBps / BPS;
        _send(burner, toBurn);
        _send(opsTreasury, msg.value - toBurn);

        emit Mined(msg.sender, handle, usd18, minted, epochAfter, msg.value);
    }

    /// @notice Burn YAN for inference credit on the caller's wallet. Deliberately not pausable:
    ///         redemption is the token's floor utility. Any holder may redeem.
    function redeem(uint256 tokens) external nonReentrant returns (uint256 usd18) {
        if (tokens == 0) revert ZeroAmount();
        usd18 = quoteRedeem(tokens);
        if (usd18 == 0) revert ZeroAmount();

        token.burnFrom(msg.sender, tokens);

        creditsUsd[msg.sender] += usd18;
        redeemedBy[msg.sender] += tokens;
        totalRedeemed += tokens;

        emit Redeemed(msg.sender, tokens, usd18);
    }

    // ---------------------------------------------------------------- admin (pause only)

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ---------------------------------------------------------------- internals

    function _send(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @dev Walk epochs: each epoch has a fixed rate; when a payment crosses a boundary the
    ///      remainder is priced at the next (decayed) rate. Any USD left when the cap is hit is
    ///      simply not minted (caller still pays; quote() lets agents avoid that).
    function _emission(uint256 usd18, uint256 mintedSoFar)
        internal
        view
        returns (uint256 tokens, uint256 epochAfter)
    {
        uint256 minted = mintedSoFar;
        uint256 remaining = usd18;
        uint256 epoch = minted / EPOCH_SIZE;
        while (remaining > 0 && epoch <= MAX_EPOCH) {
            uint256 rate = rateAt(epoch);
            if (rate == 0) break;
            uint256 roomInEpoch = (epoch + 1) * EPOCH_SIZE - minted;
            uint256 want = remaining * rate / 1e18;
            if (want <= roomInEpoch) {
                tokens += want;
                minted += want;
                remaining = 0;
            } else {
                tokens += roomInEpoch;
                minted += roomInEpoch;
                uint256 usdUsed = (roomInEpoch * 1e18 + rate - 1) / rate; // round up, never over-mint
                remaining = usdUsed >= remaining ? 0 : remaining - usdUsed;
                epoch += 1;
            }
        }
        epochAfter = minted / EPOCH_SIZE;
    }
}
