// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Binance .ai Agent ID registry (SPACE ID "Agent ID", symbol AI). Soulbound, one handle per
///         wallet, issued only through the Binance app's Agentic Wallet flow (registrar signature).
/// BSC mainnet: 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F
interface IAgentIdRegistry {
    /// @notice the .ai handle held by `wallet` (without the ".ai" suffix); empty if none
    function handleOf(address wallet) external view returns (string memory);
    /// @notice the wallet holding `handle`; zero address if unregistered
    function ownerOfHandle(string calldata handle) external view returns (address);
}
