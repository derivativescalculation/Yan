// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Fake Pancake router: pays out `rate` x msg.value of path[last] (which it must hold).
contract MockRouter {
    address public immutable wbnbAddr;
    uint256 public rate = 2;

    constructor(address wbnb_) {
        wbnbAddr = wbnb_;
    }

    function WETH() external view returns (address) {
        return wbnbAddr;
    }

    function setRate(uint256 r) external {
        rate = r;
    }

    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external payable {
        uint256 out = msg.value * rate;
        require(out >= amountOutMin, "slippage");
        require(IERC20(path[path.length - 1]).transfer(to, out), "transfer");
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory a) {
        a = new uint256[](path.length);
        a[0] = amountIn;
        a[path.length - 1] = amountIn * rate;
    }
}
