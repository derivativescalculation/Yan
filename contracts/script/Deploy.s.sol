// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {SuanToken} from "../src/SuanToken.sol";
import {ProofOfInference} from "../src/ProofOfInference.sol";
import {BuybackBurner} from "../src/BuybackBurner.sol";
import {SuanStake} from "../src/SuanStake.sol";
import {MockUSD} from "../src/mocks/MockUSD.sol";

/// Usage:
///   forge script script/Deploy.s.sol --rpc-url bsc_testnet --broadcast --skip-simulation --verify
/// Env:
///   PRIVATE_KEY            deployer
///   STABLE                 stablecoin address (omit on testnet to deploy MockUSD)
///   REGISTRY               ERC-8004 Identity Registry
///   OPS_TREASURY           address that pays model bills; REQUIRED and != deployer on chain 56 (multisig)
///   ROUTER                 PancakeSwap V2 router
///   BURN_BPS               default 2000
///   BURN_MAX_PER_CALL      default 2000e18 (stable units) per buyback call
///   INITIAL_TOKENS_PER_USD default 40000e18
///   DECAY_BPS              default 7000 (rate x0.7 each epoch; 5000 = halving)
///   MIN_PAYMENT_USD        default 1e18
///   REDEEM_BPS             default 1000
///   TOKEN_NAME / TOKEN_SYMBOL
contract Deploy is Script {
    struct Cfg {
        address deployer;
        address stable;
        address registry;
        address ops;
        address router;
        uint256 burnBps;
        uint256 burnMaxPerCall;
        uint256 rate;
        uint256 decay;
        uint256 minPay;
        uint256 redeemBps;
        string name;
        string symbol;
    }

    struct Out {
        address token;
        address burner;
        address poi;
        address stakeC;
    }

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        Cfg memory c = _cfg(vm.addr(pk));

        vm.startBroadcast(pk);
        if (c.stable == address(0)) {
            c.stable = address(new MockUSD("Test USD1", "USD1", 18));
            console.log("MockUSD", c.stable);
        }
        Out memory o = _deploy(c);
        vm.stopBroadcast();

        console.log("chain", block.chainid);
        console.log("token", o.token);
        console.log("poi", o.poi);
        console.log("burner", o.burner);
        console.log("stake", o.stakeC);
        console.log("stable", c.stable);
        _write(c, o);
    }

    function _cfg(address deployer) internal view returns (Cfg memory c) {
        c.deployer = deployer;
        c.stable = vm.envOr("STABLE", address(0));
        c.registry = vm.envAddress("REGISTRY");
        c.ops = vm.envOr("OPS_TREASURY", deployer);
        c.router = vm.envAddress("ROUTER");
        c.burnBps = vm.envOr("BURN_BPS", uint256(2000));
        c.burnMaxPerCall = vm.envOr("BURN_MAX_PER_CALL", uint256(2_000e18));
        c.rate = vm.envOr("INITIAL_TOKENS_PER_USD", uint256(40_000e18));
        c.decay = vm.envOr("DECAY_BPS", uint256(7000));
        c.minPay = vm.envOr("MIN_PAYMENT_USD", uint256(1e18));
        c.redeemBps = vm.envOr("REDEEM_BPS", uint256(1000));
        c.name = vm.envOr("TOKEN_NAME", string("Yansuan"));
        c.symbol = vm.envOr("TOKEN_SYMBOL", string("YAN"));
        if (block.chainid == 56) {
            require(c.ops != deployer && c.ops != address(0), "OPS_TREASURY must be a multisig on mainnet");
            require(c.stable != address(0), "STABLE required on mainnet");
        }
    }

    function _deploy(Cfg memory c) internal returns (Out memory o) {
        // minter fixed at construction: token (n), burner (n+1), poi (n+2)
        address predicted = vm.computeCreateAddress(c.deployer, vm.getNonce(c.deployer) + 2);
        o.token = address(new SuanToken(c.name, c.symbol, predicted));
        o.burner = address(new BuybackBurner(c.stable, o.token, c.router, c.burnMaxPerCall, c.deployer));
        o.poi = address(
            new ProofOfInference(o.token, c.stable, c.registry, c.ops, o.burner, c.burnBps, c.rate, c.decay, c.minPay, c.redeemBps, c.deployer)
        );
        require(o.poi == predicted, "minter prediction failed; nothing broadcast");
        o.stakeC = address(new SuanStake(o.token));
    }

    function _write(Cfg memory c, Out memory o) internal {
        string memory a = string.concat(
            '{"chainId":', vm.toString(block.chainid),
            ',"token":"', vm.toString(o.token),
            '","proofOfInference":"', vm.toString(o.poi),
            '","burner":"', vm.toString(o.burner),
            '","stake":"', vm.toString(o.stakeC)
        );
        string memory b = string.concat(
            '","stable":"', vm.toString(c.stable),
            '","registry":"', vm.toString(c.registry),
            '","router":"', vm.toString(c.router),
            '","opsTreasury":"', vm.toString(c.ops), '"}'
        );
        vm.writeFile(string.concat("deployments/", vm.toString(block.chainid), ".json"), string.concat(a, b));
    }
}
