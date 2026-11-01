// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title SuanStake - stake tokens against an ERC-8004 agentId
/// @notice Staked balance is read by the inference gateway to set the agent's tier:
///         request priority, rate limits and per-token price discount. No rewards are paid by
///         this contract; the utility is service level. Unstaking has a 7 day cooldown.
contract SuanStake is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant COOLDOWN = 7 days;

    IERC20 public immutable token;

    mapping(uint256 agentId => uint256) public staked;
    mapping(uint256 agentId => mapping(address staker => uint256)) public stakedBy;
    mapping(uint256 agentId => mapping(address staker => uint256)) public unlockAt;
    mapping(uint256 agentId => mapping(address staker => uint256)) public pending;
    uint256 public totalStaked;

    event Staked(uint256 indexed agentId, address indexed staker, uint256 amount);
    event UnstakeRequested(uint256 indexed agentId, address indexed staker, uint256 amount, uint256 unlockAt);
    event Withdrawn(uint256 indexed agentId, address indexed staker, uint256 amount);

    error ZeroAmount();
    error Insufficient();
    error Locked();

    constructor(address token_) {
        token = IERC20(token_);
    }

    function stake(uint256 agentId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        token.safeTransferFrom(msg.sender, address(this), amount);
        staked[agentId] += amount;
        stakedBy[agentId][msg.sender] += amount;
        totalStaked += amount;
        emit Staked(agentId, msg.sender, amount);
    }

    function requestUnstake(uint256 agentId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (stakedBy[agentId][msg.sender] < amount) revert Insufficient();
        stakedBy[agentId][msg.sender] -= amount;
        staked[agentId] -= amount;
        totalStaked -= amount;
        pending[agentId][msg.sender] += amount;
        uint256 t = block.timestamp + COOLDOWN;
        unlockAt[agentId][msg.sender] = t;
        emit UnstakeRequested(agentId, msg.sender, amount, t);
    }

    function withdraw(uint256 agentId) external nonReentrant {
        uint256 amount = pending[agentId][msg.sender];
        if (amount == 0) revert ZeroAmount();
        if (block.timestamp < unlockAt[agentId][msg.sender]) revert Locked();
        pending[agentId][msg.sender] = 0;
        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(agentId, msg.sender, amount);
    }
}
