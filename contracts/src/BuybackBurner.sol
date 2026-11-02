// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SuanToken} from "./SuanToken.sol";
import {IPancakeRouter} from "./interfaces/IPancakeRouter.sol";

/// @title BuybackBurner
/// @notice Receives the burn share of every mining payment in BNB. A keeper swaps it for the token on
///         PancakeSwap (WBNB -> token) and burns the output. BNB can never leave except via a swap
///         whose entire output is burned. The keeper's slippage floor is bounded on-chain and each
///         call is capped, so a sandwich can only touch a slice.
contract BuybackBurner is Ownable2Step, ReentrancyGuard {
    SuanToken public immutable token;
    IPancakeRouter public immutable router;
    address public immutable wbnb;

    /// @notice max slippage vs the router's spot quote, in bps (hard cap on keeper discretion)
    uint256 public constant MAX_SLIPPAGE_BPS = 300;
    /// @notice max BNB (wei) per call
    uint256 public immutable maxPerCall;

    mapping(address => bool) public keepers;
    uint256 public totalWeiSpent;
    uint256 public totalBurned;

    event KeeperSet(address indexed keeper, bool allowed);
    event Burned(uint256 weiIn, uint256 tokensBurned);

    error NotKeeper();
    error NothingToBurn();
    error SlippageTooLoose();

    constructor(address token_, address router_, uint256 maxPerCall_, address owner_) Ownable(owner_) {
        token = SuanToken(token_);
        router = IPancakeRouter(router_);
        wbnb = IPancakeRouter(router_).WETH();
        maxPerCall = maxPerCall_;
        keepers[owner_] = true;
    }

    receive() external payable {}

    function setKeeper(address keeper, bool allowed) external onlyOwner {
        keepers[keeper] = allowed;
        emit KeeperSet(keeper, allowed);
    }

    /// @param amountIn BNB (wei) to spend (0 = whole balance), capped at maxPerCall
    /// @param minOut slippage floor in tokens; must be >= 97% of the router quote
    function buybackAndBurn(uint256 amountIn, uint256 minOut) external nonReentrant returns (uint256 burned) {
        if (!keepers[msg.sender]) revert NotKeeper();
        uint256 bal = address(this).balance;
        if (amountIn == 0 || amountIn > bal) amountIn = bal;
        if (amountIn > maxPerCall) amountIn = maxPerCall;
        if (amountIn == 0) revert NothingToBurn();

        address[] memory path = new address[](2);
        path[0] = wbnb;
        path[1] = address(token);

        uint256[] memory quoted = router.getAmountsOut(amountIn, path);
        uint256 floor = quoted[quoted.length - 1] * (10_000 - MAX_SLIPPAGE_BPS) / 10_000;
        if (minOut < floor) revert SlippageTooLoose();

        router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: amountIn}(
            minOut, path, address(this), block.timestamp
        );

        burned = token.balanceOf(address(this));
        if (burned == 0) revert NothingToBurn();
        token.burn(burned);

        totalWeiSpent += amountIn;
        totalBurned += burned;
        emit Burned(amountIn, burned);
    }
}
