// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Fake Pancake router: takes path[0], pays out `rate` x amountIn of path[last] (which it must hold).
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

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external {
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        uint256 out = amountIn * rate;
        require(out >= amountOutMin, "slippage");
        IERC20(path[path.length - 1]).transfer(to, out);
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory a) {
        a = new uint256[](path.length);
        a[0] = amountIn;
        a[path.length - 1] = amountIn * rate;
    }
}
