// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IPancakeRouter {
    function WETH() external pure returns (address);
    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable;
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory);
}
