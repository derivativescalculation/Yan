// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title YAN (capped BEP-20)
/// @notice Minted only by the YanMinter, fixed at construction. There is no owner and no admin function.
///         Selling into the PancakeSwap V2 YAN/WBNB pair pays a fixed 0.5% of the amount, in YAN, to the
///         raffle. Buys, wallet transfers and every other venue are untaxed, and the liquidity vault is
///         exempt so adding liquidity is never taxed. The rate, the pair and the recipients are immutable.
contract SuanToken is ERC20, ERC20Burnable, ERC20Permit {
    uint256 public constant CAP = 1_000_000_000e18;
    uint256 public constant SELL_TAX_BPS = 50;
    uint256 private constant BPS = 10_000;

    struct Config {
        string name;
        string symbol;
        address minter;
        address raffle;
        address liquidityVault;
        address factory;
        bytes32 pairInitCodeHash;
        address wbnb;
    }

    address public immutable minter;
    address public immutable raffle;
    address public immutable liquidityVault;
    /// @notice the PancakeSwap V2 YAN/WBNB pair, derived with CREATE2 (it may not exist yet)
    address public immutable pair;

    error NotMinter();
    error CapExceeded();
    error ZeroAddress();

    constructor(Config memory c) ERC20(c.name, c.symbol) ERC20Permit(c.name) {
        if (
            c.minter == address(0) || c.raffle == address(0) || c.liquidityVault == address(0)
                || c.factory == address(0) || c.wbnb == address(0)
        ) revert ZeroAddress();
        minter = c.minter;
        raffle = c.raffle;
        liquidityVault = c.liquidityVault;
        (address t0, address t1) = address(this) < c.wbnb ? (address(this), c.wbnb) : (c.wbnb, address(this));
        pair = address(
            uint160(uint256(keccak256(abi.encodePacked(hex"ff", c.factory, keccak256(abi.encodePacked(t0, t1)), c.pairInitCodeHash))))
        );
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert NotMinter();
        if (totalSupply() + amount > CAP) revert CapExceeded();
        _mint(to, amount);
    }

    /// @dev A transfer into the pair from anyone but the liquidity vault is a sale.
    function _update(address from, address to, uint256 value) internal override {
        if (to == pair && from != liquidityVault && from != address(0)) {
            uint256 tax = value * SELL_TAX_BPS / BPS;
            if (tax != 0) {
                super._update(from, raffle, tax);
                value -= tax;
            }
        }
        super._update(from, to, value);
    }
}
