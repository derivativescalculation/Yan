// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal ERC-8004 identity stand-in for tests / local dev.
contract MockRegistry {
    mapping(uint256 => address) public owners;
    mapping(uint256 => address) public wallets;
    mapping(address => uint256) public balanceOf;
    uint256 public next = 1;

    function registerFor(address owner, address wallet) external returns (uint256 id) {
        id = next++;
        owners[id] = owner;
        wallets[id] = wallet;
        balanceOf[owner] += 1;
    }

    function register(string calldata) external returns (uint256 id) {
        id = next++;
        owners[id] = msg.sender;
        wallets[id] = msg.sender;
        balanceOf[msg.sender] += 1;
    }

    function ownerOf(uint256 id) external view returns (address o) {
        o = owners[id];
        require(o != address(0), "nonexistent");
    }

    function getAgentWallet(uint256 id) external view returns (address) {
        return wallets[id];
    }
}
