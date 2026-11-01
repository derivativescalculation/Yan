// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Testnet stablecoin stand-in. Anyone can mint.
contract MockUSD is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory n, string memory s, uint8 dec) ERC20(n, s) {
        _dec = dec;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
