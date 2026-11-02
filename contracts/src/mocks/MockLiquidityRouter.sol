// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Fake PancakeSwap router for vault unit tests: takes all the tokens, uses `useBps` of the BNB
///         and refunds the rest to the caller.
contract MockLiquidityRouter {
    uint256 public useBps = 8_000;
    address public lastTo;
    uint256 public lastTokenAmount;

    function setUseBps(uint256 b) external {
        useBps = b;
    }

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256, uint256, uint256) {
        require(block.timestamp <= deadline, "expired");
        require(IERC20(token).transferFrom(msg.sender, address(this), amountTokenDesired), "pull");
        uint256 used = msg.value * useBps / 10_000;
        require(amountTokenDesired >= amountTokenMin && used >= amountETHMin, "slippage");
        lastTo = to;
        lastTokenAmount = amountTokenDesired;
        (bool ok,) = msg.sender.call{value: msg.value - used}("");
        require(ok, "refund");
        return (amountTokenDesired, used, 1e18);
    }
}
