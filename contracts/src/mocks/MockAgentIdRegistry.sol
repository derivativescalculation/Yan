// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Stand-in for the Binance .ai Agent ID registry in tests, local chains and testnet.
contract MockAgentIdRegistry {
    mapping(address => string) public handleOf;
    mapping(bytes32 => address) private holder;

    function setHandle(address wallet, string calldata handle) external {
        require(bytes(handleOf[wallet]).length == 0, "has handle");
        require(holder[keccak256(bytes(handle))] == address(0), "taken");
        handleOf[wallet] = handle;
        holder[keccak256(bytes(handle))] = wallet;
    }

    function ownerOfHandle(string calldata handle) external view returns (address) {
        return holder[keccak256(bytes(handle))];
    }
}
