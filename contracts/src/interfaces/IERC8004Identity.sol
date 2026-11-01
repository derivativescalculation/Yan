// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal view surface of the ERC-8004 Identity Registry (ERC-721 based, "AgentIdentity" v2.0.0).
/// BSC mainnet: 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
/// BSC testnet: 0x8004A818BFB912233c491871b3d84c89A494BD9e
interface IERC8004Identity {
    function ownerOf(uint256 agentId) external view returns (address);
    function getAgentWallet(uint256 agentId) external view returns (address);
    function balanceOf(address owner) external view returns (uint256);
    function register(string calldata agentURI) external returns (uint256 agentId);
    function tokenURI(uint256 agentId) external view returns (string memory);
}
