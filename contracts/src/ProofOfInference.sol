// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SuanToken} from "./SuanToken.sol";
import {IERC8004Identity} from "./interfaces/IERC8004Identity.sol";

/// @title ProofOfInference - the only mint path for the token
/// @notice An ERC-8004 registered agent pays stablecoin for inference credit at the gateway.
///         The payment mints tokens to the agent at the current epoch rate. Humans cannot call this
///         unless they own or operate a registered agent. Every EPOCH_SIZE tokens the mint rate is
///         multiplied by decayBps/10000 (e.g. 7000 = each epoch mints 30% fewer tokens per USD).
///         Stablecoin is split: burnBps -> BuybackBurner, remainder -> ops treasury (pays model bills).
///
///         Utility: tokens are always redeemable for inference credit (`redeem`). Redemption burns
///         the tokens and credits USD at the *genesis* (epoch 0) rate times redeemBps. The rate is
///         constant so the protocol's redemption liability is bounded by redeemBps of all mining revenue.
///
///         The owner can only pause `mine`. Rates, split and destinations are immutable.
contract ProofOfInference is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant EPOCH_SIZE = 100_000_000e18; // rate steps down every 100M tokens
    uint256 public constant MAX_EPOCH = 9; // 10 epochs x 100M = 1B cap
    uint256 public constant BPS = 10_000;

    SuanToken public immutable token;
    IERC20 public immutable stable;
    uint256 public immutable stableScale; // 10 ** (18 - stableDecimals)
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
    uint256 public totalMinted;
    uint256 public totalRedeemed;
    uint256 public agentCount;
    mapping(uint256 agentId => bool) public seen;

    event Mined(
        uint256 indexed agentId, address indexed miner, uint256 usdAmount18, uint256 tokensMinted, uint256 epochAfter
    );
    event Redeemed(uint256 indexed agentId, address indexed redeemer, uint256 tokensBurned, uint256 creditUsd18);

    error NotAgentOperator(uint256 agentId, address caller);
    error BelowMinimum();
    error CapReached();
    error ZeroAddress();
    error BadBps();
    error BadDecimals();
    error BadRate();
    error ZeroAmount();

    constructor(
        address token_,
        address stable_,
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
            token_ == address(0) || stable_ == address(0) || registry_ == address(0) || opsTreasury_ == address(0)
                || burner_ == address(0)
        ) revert ZeroAddress();
        if (burnBps_ >= BPS || redeemBps_ > BPS || decayBps_ == 0 || decayBps_ >= BPS) revert BadBps();
        if (initialTokensPerUsd_ == 0 || minPaymentUsd_ == 0) revert BadRate();
        uint8 dec = IERC20Metadata(stable_).decimals();
        if (dec > 18) revert BadDecimals();
        token = SuanToken(token_);
        stable = IERC20(stable_);
        stableScale = 10 ** (18 - dec);
        registry = IERC8004Identity(registry_);
        opsTreasury = opsTreasury_;
        burner = burner_;
        burnBps = burnBps_;
        initialTokensPerUsd = initialTokensPerUsd_;
        decayBps = decayBps_;
        minPaymentUsd = minPaymentUsd_;
        redeemBps = redeemBps_;
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
    function costToCap() external view returns (uint256 usd18) {
        uint256 minted = totalMinted;
        for (uint256 e = minted / EPOCH_SIZE; e <= MAX_EPOCH; e++) {
            uint256 room = (e + 1) * EPOCH_SIZE - minted;
            uint256 rate = rateAt(e);
            usd18 += (room * 1e18 + rate - 1) / rate; // round up: paying costToCap mints to the cap
            minted += room;
        }
    }

    /// @notice Tokens that `usdAmount` (in the stablecoin's own units) would mint right now,
    ///         walking across halving boundaries.
    function quote(uint256 usdAmount) external view returns (uint256 tokens) {
        (tokens,) = _emission(usdAmount * stableScale, totalMinted);
    }

    /// @notice USD credit (1e18) that burning `tokens` grants. Constant: genesis rate x redeemBps.
    function quoteRedeem(uint256 tokens) public view returns (uint256 usd18) {
        usd18 = tokens * 1e18 / initialTokensPerUsd * redeemBps / BPS;
    }

    function isOperator(uint256 agentId, address who) public view returns (bool) {
        return registry.ownerOf(agentId) == who || registry.getAgentWallet(agentId) == who;
    }

    // ---------------------------------------------------------------- mining

    /// @notice Pay `usdAmount` stablecoin (caller must have approved) on behalf of `agentId`.
    ///         Caller must be the agent's owner or its registered wallet. Mints tokens to caller.
    function mine(uint256 agentId, uint256 usdAmount) external whenNotPaused nonReentrant returns (uint256 minted) {
        if (!isOperator(agentId, msg.sender)) revert NotAgentOperator(agentId, msg.sender);
        uint256 usd18 = usdAmount * stableScale;
        if (usd18 < minPaymentUsd) revert BelowMinimum();

        uint256 epochAfter;
        (minted, epochAfter) = _emission(usd18, totalMinted);
        if (minted == 0) revert CapReached();

        // pull + split
        uint256 toBurn = usdAmount * burnBps / BPS;
        if (toBurn > 0) stable.safeTransferFrom(msg.sender, burner, toBurn);
        stable.safeTransferFrom(msg.sender, opsTreasury, usdAmount - toBurn);

        // account
        creditsUsd[agentId] += usd18;
        minedByAgent[agentId] += minted;
        totalUsdPaid += usd18;
        totalMinted += minted;
        _touch(agentId);

        token.mint(msg.sender, minted);
        emit Mined(agentId, msg.sender, usd18, minted, epochAfter);
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
