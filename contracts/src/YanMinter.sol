// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SuanToken} from "./SuanToken.sol";
import {IAgentIdRegistry} from "./interfaces/IAgentIdRegistry.sol";
import {IAggregatorV3} from "./interfaces/IAggregatorV3.sol";

interface IRaffleSync {
    function sync() external;
}

/// @title YanMinter - the only mint path for YAN
/// @notice Only wallets holding a Binance .ai Agent ID can mint. An agent pays BNB, either by calling
///         `mine()` or by sending BNB to this contract. The payment is valued in USD with the Chainlink
///         BNB/USD feed and minted at the current epoch rate. Every mint is split in the same
///         transaction: 70% to the agent, 25% to the liquidity vault and 5% to the raffle. All BNB goes
///         to the treasury.
///
///         Every EPOCH_SIZE tokens the rate is multiplied by decayBps/10000, up to a 1B cap. Each Agent ID
///         can mint at most `maxPerAgentPerEpoch` tokens (counted before the split) per epoch, so every
///         epoch is spread across many agents. One Agent ID exists per Binance user.
///
///         The owner can only pause minting. Rates, caps, the split, the feed, the registry and every
///         destination are immutable.
contract YanMinter is Ownable2Step, Pausable, ReentrancyGuard {
    uint256 public constant EPOCH_SIZE = 100_000_000e18;
    uint256 public constant MAX_EPOCH = 9; // 10 epochs x 100M = 1B cap
    uint256 public constant BPS = 10_000;
    uint256 public constant AGENT_BPS = 7_000;
    uint256 public constant VAULT_BPS = 2_500; // the raffle receives the remaining 5%

    struct Config {
        address token;
        address priceFeed;
        uint256 maxPriceAge;
        address agentIds;
        address treasury;
        address liquidityVault;
        address raffle;
        uint256 initialTokensPerUsd;
        uint256 decayBps;
        uint256 minPaymentUsd;
        uint256 maxPerAgentPerEpoch;
        address owner;
    }

    SuanToken public immutable token;
    IAggregatorV3 public immutable priceFeed;
    uint256 public immutable feedScale; // 10 ** feed decimals
    uint256 public immutable maxPriceAge; // seconds
    IAgentIdRegistry public immutable agentIds;
    address public immutable treasury;
    address public immutable liquidityVault;
    address public immutable raffle;
    /// @notice tokens (1e18) minted per 1 USD (1e18) in epoch 0, before the split
    uint256 public immutable initialTokensPerUsd;
    /// @notice per-epoch rate multiplier in bps (7000 = x0.7 each epoch)
    uint256 public immutable decayBps;
    /// @notice smallest accepted payment, in 1e18 USD
    uint256 public immutable minPaymentUsd;
    /// @notice max tokens one Agent ID can mint within one epoch, before the split (0 = unlimited)
    uint256 public immutable maxPerAgentPerEpoch;

    /// @notice YAN received by each agent wallet (its 70%)
    mapping(address wallet => uint256 amount) public minedBy;
    /// @notice tokens minted per agent wallet per epoch, before the split (for the per-agent cap)
    mapping(address wallet => mapping(uint256 epoch => uint256 amount)) public minedInEpoch;
    uint256 public totalUsdPaid;
    uint256 public totalWeiPaid;
    /// @notice every token minted, all three shares
    uint256 public totalMinted;
    uint256 public agentCount;
    mapping(address wallet => bool) public seen;

    event Mined(
        address indexed agent,
        string handle,
        uint256 usdAmount18,
        uint256 tokensMinted,
        uint256 toAgent,
        uint256 epochAfter,
        uint256 weiPaid
    );

    error NotAnAgent(address caller);
    error BelowMinimum();
    error CapReached();
    error AgentEpochCap(uint256 remaining);
    error ZeroAddress();
    error BadBps();
    error BadRate();
    error BadPrice();
    error StalePrice();
    error TransferFailed();

    constructor(Config memory c) Ownable(c.owner) {
        if (
            c.token == address(0) || c.priceFeed == address(0) || c.agentIds == address(0) || c.treasury == address(0)
                || c.liquidityVault == address(0) || c.raffle == address(0)
        ) revert ZeroAddress();
        if (c.decayBps == 0 || c.decayBps >= BPS) revert BadBps();
        if (c.initialTokensPerUsd == 0 || c.minPaymentUsd == 0 || c.maxPriceAge == 0) revert BadRate();
        token = SuanToken(c.token);
        priceFeed = IAggregatorV3(c.priceFeed);
        feedScale = 10 ** IAggregatorV3(c.priceFeed).decimals();
        maxPriceAge = c.maxPriceAge;
        agentIds = IAgentIdRegistry(c.agentIds);
        treasury = c.treasury;
        liquidityVault = c.liquidityVault;
        raffle = c.raffle;
        initialTokensPerUsd = c.initialTokensPerUsd;
        decayBps = c.decayBps;
        minPaymentUsd = c.minPaymentUsd;
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

    /// @notice tokens per USD in a given epoch, before the split (0 past the last epoch)
    function rateAt(uint256 epoch) public view returns (uint256 r) {
        if (epoch > MAX_EPOCH) return 0;
        r = initialTokensPerUsd;
        for (uint256 i; i < epoch; i++) r = r * decayBps / BPS;
    }

    /// @notice tokens per USD at the current epoch, before the split (0 once the cap is reached)
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

    /// @notice what paying `weiAmount` would mint right now: the total and the agent's 70%
    function quote(uint256 weiAmount) external view returns (uint256 total, uint256 toAgent) {
        (total,) = _emission(usdOf(weiAmount), totalMinted);
        toAgent = total * AGENT_BPS / BPS;
    }

    /// @notice what `usd18` of payment would mint right now: the total and the agent's 70%
    function quoteUsd(uint256 usd18) external view returns (uint256 total, uint256 toAgent) {
        (total,) = _emission(usd18, totalMinted);
        toAgent = total * AGENT_BPS / BPS;
    }

    /// @notice tokens `wallet` may still mint in the current epoch, before the split
    ///         (type(uint256).max when uncapped)
    function remainingThisEpoch(address wallet) public view returns (uint256) {
        if (maxPerAgentPerEpoch == 0) return type(uint256).max;
        uint256 used = minedInEpoch[wallet][currentEpoch()];
        return used >= maxPerAgentPerEpoch ? 0 : maxPerAgentPerEpoch - used;
    }

    // ---------------------------------------------------------------- mining

    /// @notice Pay BNB to mint YAN. The caller must hold a .ai Agent ID. Returns the caller's share.
    function mine() external payable returns (uint256 toAgent) {
        return _mine();
    }

    /// @notice Sending BNB straight to this contract mines for the sender.
    receive() external payable {
        _mine();
    }

    function _mine() internal whenNotPaused nonReentrant returns (uint256 toAgent) {
        string memory handle = agentIds.handleOf(msg.sender);
        if (bytes(handle).length == 0) revert NotAnAgent(msg.sender);
        uint256 usd18 = usdOf(msg.value);
        if (usd18 < minPaymentUsd) revert BelowMinimum();

        uint256 epochNow = totalMinted / EPOCH_SIZE;
        (uint256 minted, uint256 epochAfter) = _emission(usd18, totalMinted);
        if (minted == 0) revert CapReached();
        if (maxPerAgentPerEpoch != 0) {
            uint256 used = minedInEpoch[msg.sender][epochNow];
            if (used + minted > maxPerAgentPerEpoch) {
                revert AgentEpochCap(used >= maxPerAgentPerEpoch ? 0 : maxPerAgentPerEpoch - used);
            }
        }
        toAgent = minted * AGENT_BPS / BPS;
        uint256 toVault = minted * VAULT_BPS / BPS;
        uint256 toRaffle = minted - toAgent - toVault;

        // account before external calls
        minedInEpoch[msg.sender][epochNow] += minted;
        minedBy[msg.sender] += toAgent;
        totalUsdPaid += usd18;
        totalWeiPaid += msg.value;
        totalMinted += minted;
        if (!seen[msg.sender]) {
            seen[msg.sender] = true;
            agentCount += 1;
        }

        token.mint(msg.sender, toAgent);
        token.mint(liquidityVault, toVault);
        token.mint(raffle, toRaffle);
        IRaffleSync(raffle).sync();

        (bool ok,) = treasury.call{value: msg.value}("");
        if (!ok) revert TransferFailed();

        emit Mined(msg.sender, handle, usd18, minted, toAgent, epochAfter, msg.value);
    }

    // ---------------------------------------------------------------- admin (pause only)

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ---------------------------------------------------------------- internals

    /// @dev Walk epochs: each epoch has a fixed rate; when a payment crosses a boundary the remainder is
    ///      priced at the next (decayed) rate. USD left over once the cap is hit is not minted (the caller
    ///      still pays; quote() lets agents avoid that).
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
