// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Chainlink price feed surface.
/// BNB/USD, BSC mainnet: 0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE
/// BNB/USD, BSC testnet: 0x2514895c72f50D8bd4B4F9b1110F0D6bD2c97526
interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
