// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice PancakeSwap V2 router surface.
/// BSC mainnet: 0x10ED43C718714eb63d5aA57B78B54704E256024E (factory 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73)
/// BSC testnet: 0xD99D1c33F9fC3444f8101754aBC46c52416550D1 (factory 0x6725F303b657a9451d8BA641348b6761A6CC7a17)
interface IPancakeRouter {
    function factory() external pure returns (address);
    function WETH() external pure returns (address);
    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);
    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable;
    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory);
}

interface IPancakeFactory {
    function getPair(address a, address b) external view returns (address);
    function INIT_CODE_PAIR_HASH() external view returns (bytes32);
}
