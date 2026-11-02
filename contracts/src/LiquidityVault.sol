// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPancakeRouter} from "./interfaces/IPancakeRouter.sol";

/// @title LiquidityVault - holds the 25% of every mint reserved for liquidity
/// @notice The YAN here can only ever become PancakeSwap liquidity. The owner chooses when and how much,
///         supplies the BNB side, and the LP tokens are sent straight to the dead address, so the
///         liquidity can never be pulled. There is no function that moves YAN anywhere else.
contract LiquidityVault is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant LP_BURN = 0x000000000000000000000000000000000000dEaD;

    IERC20 public immutable token;
    IPancakeRouter public immutable router;

    uint256 public totalTokenAdded;
    uint256 public totalBnbAdded;

    event LiquidityAdded(uint256 tokenAmount, uint256 bnbAmount, uint256 liquidity);

    error ZeroAddress();
    error ZeroAmount();
    error OnlyRouter();
    error TransferFailed();

    constructor(address token_, address router_, address owner_) Ownable(owner_) {
        if (token_ == address(0) || router_ == address(0)) revert ZeroAddress();
        token = IERC20(token_);
        router = IPancakeRouter(router_);
    }

    /// @notice Pair `tokenAmount` YAN from the vault with the BNB sent, add it to the YAN/WBNB pool and
    ///         burn the LP. Unused BNB is returned to the owner.
    function addLiquidity(uint256 tokenAmount, uint256 tokenMin, uint256 bnbMin, uint256 deadline)
        external
        payable
        onlyOwner
        nonReentrant
        returns (uint256 amountToken, uint256 amountBnb, uint256 liquidity)
    {
        if (tokenAmount == 0 || msg.value == 0) revert ZeroAmount();
        token.forceApprove(address(router), tokenAmount);
        (amountToken, amountBnb, liquidity) =
            router.addLiquidityETH{value: msg.value}(address(token), tokenAmount, tokenMin, bnbMin, LP_BURN, deadline);
        token.forceApprove(address(router), 0);
        totalTokenAdded += amountToken;
        totalBnbAdded += amountBnb;

        uint256 refund = address(this).balance;
        if (refund != 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert TransferFailed();
        }
        emit LiquidityAdded(amountToken, amountBnb, liquidity);
    }

    /// @notice YAN waiting to become liquidity
    function balance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    /// @dev only the router's refund of unused BNB
    receive() external payable {
        if (msg.sender != address(router)) revert OnlyRouter();
    }
}
