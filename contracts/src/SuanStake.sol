// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title SuanStake - stake YAN from an agent wallet for a gateway tier
/// @notice Staked balance is read by the inference gateway to set the wallet's tier: request priority,
///         rate limits and a discount on the markup. No rewards are paid by this contract; the utility is
///         service level. Unstaking has a 7 day cooldown.
contract SuanStake is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant COOLDOWN = 7 days;

    IERC20 public immutable token;

    mapping(address wallet => uint256) public staked;
    mapping(address wallet => uint256) public pending;
    mapping(address wallet => uint256) public unlockAt;
    uint256 public totalStaked;

    event Staked(address indexed wallet, uint256 amount);
    event UnstakeRequested(address indexed wallet, uint256 amount, uint256 unlockAt);
    event Withdrawn(address indexed wallet, uint256 amount);

    error ZeroAmount();
    error Insufficient();
    error Locked();

    constructor(address token_) {
        token = IERC20(token_);
    }

    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        token.safeTransferFrom(msg.sender, address(this), amount);
        staked[msg.sender] += amount;
        totalStaked += amount;
        emit Staked(msg.sender, amount);
    }

    /// @notice moves `amount` from staked to pending; the whole pending balance unlocks COOLDOWN later
    function requestUnstake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (staked[msg.sender] < amount) revert Insufficient();
        staked[msg.sender] -= amount;
        totalStaked -= amount;
        pending[msg.sender] += amount;
        uint256 t = block.timestamp + COOLDOWN;
        unlockAt[msg.sender] = t;
        emit UnstakeRequested(msg.sender, amount, t);
    }

    function withdraw() external nonReentrant {
        uint256 amount = pending[msg.sender];
        if (amount == 0) revert ZeroAmount();
        if (block.timestamp < unlockAt[msg.sender]) revert Locked();
        pending[msg.sender] = 0;
        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }
}
