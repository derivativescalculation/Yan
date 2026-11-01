// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {SuanToken} from "./SuanToken.sol";
import {IPancakeRouter} from "./interfaces/IPancakeRouter.sol";

/// @title BuybackBurner
/// @notice Receives the burn share of every mining payment in stablecoin. A keeper swaps it for
///         the token on PancakeSwap and burns it. Stablecoin can never leave except via a swap whose
///         output is burned. Paths are restricted to stable->token or stable->WBNB->token.
contract BuybackBurner is Ownable2Step {
    using SafeERC20 for IERC20;

    IERC20 public immutable stable;
    SuanToken public immutable token;
    IPancakeRouter public immutable router;
    address public immutable wbnb;

    /// @notice max slippage vs the router's spot quote, in bps (hard cap on keeper discretion)
    uint256 public constant MAX_SLIPPAGE_BPS = 300;
    /// @notice max stablecoin per call, so a sandwich can only touch a slice
    uint256 public immutable maxPerCall;

    mapping(address => bool) public keepers;
    uint256 public totalStableSpent;
    uint256 public totalBurned;

    event KeeperSet(address indexed keeper, bool allowed);
    event Burned(uint256 stableIn, uint256 tokensBurned);

    error NotKeeper();
    error NothingToBurn();
    error SlippageTooLoose();

    constructor(address stable_, address token_, address router_, uint256 maxPerCall_, address owner_) Ownable(owner_) {
        maxPerCall = maxPerCall_;
        stable = IERC20(stable_);
        token = SuanToken(token_);
        router = IPancakeRouter(router_);
        wbnb = IPancakeRouter(router_).WETH();
        keepers[owner_] = true;
    }

    function setKeeper(address keeper, bool allowed) external onlyOwner {
        keepers[keeper] = allowed;
        emit KeeperSet(keeper, allowed);
    }

    /// @param amountIn stablecoin to spend (0 = whole balance)
    /// @param minOut slippage floor in tokens; must be >= 97% of the router quote
    /// @param viaWbnb route through WBNB when there is no direct stable/token pool
    function buybackAndBurn(uint256 amountIn, uint256 minOut, bool viaWbnb) external returns (uint256 burned) {
        if (!keepers[msg.sender]) revert NotKeeper();
        uint256 bal = stable.balanceOf(address(this));
        if (amountIn == 0 || amountIn > bal) amountIn = bal;
        if (amountIn > maxPerCall) amountIn = maxPerCall;
        if (amountIn == 0) revert NothingToBurn();

        address[] memory path;
        if (viaWbnb) {
            path = new address[](3);
            path[0] = address(stable);
            path[1] = wbnb;
            path[2] = address(token);
        } else {
            path = new address[](2);
            path[0] = address(stable);
            path[1] = address(token);
        }

        // keeper's minOut may not be looser than MAX_SLIPPAGE_BPS below the router's own quote
        uint256[] memory quoted = router.getAmountsOut(amountIn, path);
        uint256 floor = quoted[quoted.length - 1] * (10_000 - MAX_SLIPPAGE_BPS) / 10_000;
        if (minOut < floor) revert SlippageTooLoose();

        stable.forceApprove(address(router), amountIn);
        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
            amountIn, minOut, path, address(this), block.timestamp
        );

        burned = token.balanceOf(address(this));
        if (burned == 0) revert NothingToBurn();
        token.burn(burned);

        totalStableSpent += amountIn;
        totalBurned += burned;
        emit Burned(amountIn, burned);
    }
}
