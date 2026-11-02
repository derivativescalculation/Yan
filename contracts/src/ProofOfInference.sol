// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SuanToken} from "./SuanToken.sol";
import {IERC8004Identity} from "./interfaces/IERC8004Identity.sol";
import {IAggregatorV3} from "./interfaces/IAggregatorV3.sol";

/// @title ProofOfInference - the only mint path for the token
/// @notice An ERC-8004 registered agent pays BNB for inference credit. The payment is valued in USD
///         with the Chainlink BNB/USD feed, mints tokens to the caller at the current epoch rate and
///         books the USD value as credit on the agentId. Only the identity's owner or its registered
///         agent wallet can call. Every EPOCH_SIZE tokens the mint rate is multiplied by
///         decayBps/10000 (7000 = each epoch mints 30% fewer tokens per USD).
///
///         BNB is split in the same transaction: burnBps to the BuybackBurner, the rest to the ops
///         treasury (which pays model bills).
///
///         Utility: tokens are always redeemable for inference credit (`redeem`) at the genesis rate
///         times redeemBps, constant across epochs, so the redemption liability is bounded by
///         redeemBps of all payments.
///
///         The owner can only pause `mine`. Rates, split, feed and destinations are immutable.
contract ProofOfInference is Ownable2Step, Pausable, ReentrancyGuard {
    uint256 public constant EPOCH_SIZE = 100_000_000e18; // rate steps down every 100M tokens
    uint256 public constant MAX_EPOCH = 9; // 10 epochs x 100M = 1B cap
    uint256 public constant BPS = 10_000;

    SuanToken public immutable token;
    IAggregatorV3 public immutable priceFeed;
    uint256 public immutable feedScale; // 10 ** feed decimals
    uint256 public immutable maxPriceAge; // seconds
    IERC8004Identity public immutable registry;
    address public immutable opsTreasury;
    address public immutable burner;
    uint256 public immutable burnBps;
    /// @notice tokens (1e18) minted per 1 USD (1e18) in epoch 0
    uint256 public immutable initialTokensPerUsd;
    /// @notice per-epoch rate multiplier in bps (7000 = x0.7 each epoch, 5000 = halving)
    uint256 public immutable decayBps;
    /// @notice smallest accepted payment, in 1e18 USD
    uint256 public immutable minPaymentUsd;
    /// @notice share of genesis mint value credited when redeeming tokens for compute
    uint256 public immutable redeemBps;

    /// @notice cumulative USD credit (1e18) per agentId. The gateway meters usage off-chain against this.
    mapping(uint256 agentId => uint256 usd) public creditsUsd;
    /// @notice cumulative tokens mined per agentId (leaderboard)
    mapping(uint256 agentId => uint256 amount) public minedByAgent;
    mapping(uint256 agentId => uint256 amount) public redeemedByAgent;
    uint256 public totalUsdPaid;
    uint256 public totalWeiPaid;
    uint256 public totalMinted;
    uint256 public totalRedeemed;
    uint256 public agentCount;
    mapping(uint256 agentId => bool) public seen;

    event Mined(
        uint256 indexed agentId,
        address indexed miner,
        uint256 usdAmount18,
        uint256 tokensMinted,
        uint256 epochAfter,
        uint256 weiPaid
    );
    event Redeemed(uint256 indexed agentId, address indexed redeemer, uint256 tokensBurned, uint256 creditUsd18);

    error NotAgentOperator(uint256 agentId, address caller);
    error BelowMinimum();
    error CapReached();
    error ZeroAddress();
    error BadBps();
    error BadRate();
    error BadPrice();
    error StalePrice();
    error ZeroAmount();
    error TransferFailed();

    constructor(
        address token_,
        address priceFeed_,
        uint256 maxPriceAge_,
        address registry_,
        address opsTreasury_,
        address burner_,
        uint256 burnBps_,
        uint256 initialTokensPerUsd_,
        uint256 decayBps_,
        uint256 minPaymentUsd_,
        uint256 redeemBps_,
        address owner_
    ) Ownable(owner_) {
        if (
            token_ == address(0) || priceFeed_ == address(0) || registry_ == address(0) || opsTreasury_ == address(0)
                || burner_ == address(0)
        ) revert ZeroAddress();
        if (burnBps_ >= BPS || redeemBps_ > BPS || decayBps_ == 0 || decayBps_ >= BPS) revert BadBps();
        if (initialTokensPerUsd_ == 0 || minPaymentUsd_ == 0 || maxPriceAge_ == 0) revert BadRate();
        uint8 dec = IAggregatorV3(priceFeed_).decimals();
        token = SuanToken(token_);
        priceFeed = IAggregatorV3(priceFeed_);
        feedScale = 10 ** dec;
        maxPriceAge = maxPriceAge_;
        registry = IERC8004Identity(registry_);
        opsTreasury = opsTreasury_;
        burner = burner_;
        burnBps = burnBps_;
        initialTokensPerUsd = initialTokensPerUsd_;
        decayBps = decayBps_;
        minPaymentUsd = minPaymentUsd_;
        redeemBps = redeemBps_;
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

    /// @notice USD credit (1e18) that burning `tokens` grants. Constant: genesis rate x redeemBps.
    function quoteRedeem(uint256 tokens) public view returns (uint256 usd18) {
        usd18 = tokens * 1e18 / initialTokensPerUsd * redeemBps / BPS;
    }

    function isOperator(uint256 agentId, address who) public view returns (bool) {
        return registry.ownerOf(agentId) == who || registry.getAgentWallet(agentId) == who;
    }

    // ---------------------------------------------------------------- mining

    /// @notice Pay BNB for inference credit on `agentId`. Caller must be the agent's owner or its
    ///         registered wallet. Mints tokens to the caller.
    function mine(uint256 agentId) external payable whenNotPaused nonReentrant returns (uint256 minted) {
        if (!isOperator(agentId, msg.sender)) revert NotAgentOperator(agentId, msg.sender);
        uint256 usd18 = usdOf(msg.value);
        if (usd18 < minPaymentUsd) revert BelowMinimum();

        uint256 epochAfter;
        (minted, epochAfter) = _emission(usd18, totalMinted);
        if (minted == 0) revert CapReached();

        // account before external calls
        creditsUsd[agentId] += usd18;
        minedByAgent[agentId] += minted;
        totalUsdPaid += usd18;
        totalWeiPaid += msg.value;
        totalMinted += minted;
        _touch(agentId);

        token.mint(msg.sender, minted);

        uint256 toBurn = msg.value * burnBps / BPS;
        _send(burner, toBurn);
        _send(opsTreasury, msg.value - toBurn);

        emit Mined(agentId, msg.sender, usd18, minted, epochAfter, msg.value);
    }

    /// @notice Burn tokens for inference credit on `agentId`. Caller must operate the agent.
    ///         Deliberately not pausable: redemption is the token's floor utility.
    function redeem(uint256 agentId, uint256 tokens) external nonReentrant returns (uint256 usd18) {
        if (!isOperator(agentId, msg.sender)) revert NotAgentOperator(agentId, msg.sender);
        if (tokens == 0) revert ZeroAmount();
        usd18 = quoteRedeem(tokens);
        if (usd18 == 0) revert ZeroAmount();

        token.burnFrom(msg.sender, tokens);

        creditsUsd[agentId] += usd18;
        redeemedByAgent[agentId] += tokens;
        totalRedeemed += tokens;
        _touch(agentId);

        emit Redeemed(agentId, msg.sender, tokens, usd18);
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

    function _touch(uint256 agentId) internal {
        if (!seen[agentId]) {
            seen[agentId] = true;
            agentCount += 1;
        }
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
