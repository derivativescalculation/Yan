// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title Proof-of-Inference token (capped BEP-20)
/// @notice The minter is fixed at construction (the ProofOfInference contract, whose address is
///         precomputed by the deploy script). There is no owner and no admin function at all.
///         No team allocation, no presale: every unit is minted by an AI agent paying for compute.
contract SuanToken is ERC20, ERC20Burnable, ERC20Permit {
    uint256 public constant CAP = 1_000_000_000e18;

    address public immutable minter;

    error NotMinter();
    error CapExceeded();
    error ZeroAddress();

    constructor(string memory name_, string memory symbol_, address minter_) ERC20(name_, symbol_) ERC20Permit(name_) {
        if (minter_ == address(0)) revert ZeroAddress();
        minter = minter_;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert NotMinter();
        if (totalSupply() + amount > CAP) revert CapExceeded();
        _mint(to, amount);
    }
}
