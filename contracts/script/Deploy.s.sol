// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {SuanToken} from "../src/SuanToken.sol";
import {ProofOfInference} from "../src/ProofOfInference.sol";
import {BuybackBurner} from "../src/BuybackBurner.sol";
import {SuanStake} from "../src/SuanStake.sol";
import {MockAgentIdRegistry} from "../src/mocks/MockAgentIdRegistry.sol";

/// Usage:
///   forge script script/Deploy.s.sol --rpc-url bsc --broadcast --skip-simulation --verify
/// Env:
///   PRIVATE_KEY              deployer
///   AGENT_ID_REGISTRY        Binance .ai Agent ID registry (mainnet 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F).
///                            Omit on testnet to deploy a mock and give TEST_AGENT a handle.
///   TEST_AGENT / TEST_HANDLE testnet only: wallet + handle registered in the mock
///   PRICE_FEED               Chainlink BNB/USD (mainnet 0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE,
///                            testnet 0x2514895c72f50D8bd4B4F9b1110F0D6bD2c97526)
///   MAX_PRICE_AGE            seconds before the feed is stale (default 3600)
///   OPS_TREASURY             receives (1 - burn) of every payment; must not be the deployer on 56
///   ROUTER                   PancakeSwap V2 router
///   BURN_BPS                 default 2000
///   BURN_MAX_PER_CALL        default 5e18 wei per buyback call
///   INITIAL_TOKENS_PER_USD   default 40000e18
///   DECAY_BPS                default 7000
///   MIN_PAYMENT_USD          default 1e18
///   REDEEM_BPS               default 1000
///   MAX_PER_AGENT_PER_EPOCH  default 1000000e18 (0 = uncapped)
///   TOKEN_NAME / TOKEN_SYMBOL
contract Deploy is Script {
    struct Out {
        address token;
        address burner;
        address poi;
        address stakeC;
        address agentIds;
    }

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        ProofOfInference.Config memory c = _cfg(deployer);
        address router = vm.envAddress("ROUTER");
        uint256 burnMax = vm.envOr("BURN_MAX_PER_CALL", uint256(5e18));

        vm.startBroadcast(pk);
        Out memory o;
        if (c.agentIds == address(0)) {
            require(block.chainid != 56, "AGENT_ID_REGISTRY required on mainnet");
            MockAgentIdRegistry m = new MockAgentIdRegistry();
            address testAgent = vm.envOr("TEST_AGENT", address(0));
            if (testAgent != address(0)) m.setHandle(testAgent, vm.envOr("TEST_HANDLE", string("genesis")));
            c.agentIds = address(m);
        }
        o.agentIds = c.agentIds;
        // minter fixed at construction: token (n), burner (n+1), poi (n+2)
        address predicted = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 2);
        o.token = address(new SuanToken(vm.envOr("TOKEN_NAME", string("Yansuan")), vm.envOr("TOKEN_SYMBOL", string("YAN")), predicted));
        o.burner = address(new BuybackBurner(o.token, router, burnMax, deployer));
        c.token = o.token;
        c.burner = o.burner;
        o.poi = address(new ProofOfInference(c));
        require(o.poi == predicted, "minter prediction failed; nothing broadcast");
        o.stakeC = address(new SuanStake(o.token));
        vm.stopBroadcast();

        console.log("chain", block.chainid);
        console.log("token", o.token);
        console.log("poi", o.poi);
        console.log("burner", o.burner);
        console.log("stake", o.stakeC);
        console.log("agentIds", o.agentIds);
        _write(c, o, router);
    }

    function _cfg(address deployer) internal view returns (ProofOfInference.Config memory c) {
        c.priceFeed = vm.envAddress("PRICE_FEED");
        c.maxPriceAge = vm.envOr("MAX_PRICE_AGE", uint256(3600));
        c.agentIds = vm.envOr("AGENT_ID_REGISTRY", address(0));
        c.opsTreasury = vm.envOr("OPS_TREASURY", deployer);
        c.burnBps = vm.envOr("BURN_BPS", uint256(2000));
        c.initialTokensPerUsd = vm.envOr("INITIAL_TOKENS_PER_USD", uint256(40_000e18));
        c.decayBps = vm.envOr("DECAY_BPS", uint256(7000));
        c.minPaymentUsd = vm.envOr("MIN_PAYMENT_USD", uint256(1e18));
        c.redeemBps = vm.envOr("REDEEM_BPS", uint256(1000));
        c.maxPerAgentPerEpoch = vm.envOr("MAX_PER_AGENT_PER_EPOCH", uint256(1_000_000e18));
        c.owner = deployer;
        if (block.chainid == 56) {
            require(c.opsTreasury != deployer && c.opsTreasury != address(0), "OPS_TREASURY must not be the deployer on mainnet");
        }
    }

    function _write(ProofOfInference.Config memory c, Out memory o, address router) internal {
        string memory a = string.concat(
            '{"chainId":', vm.toString(block.chainid),
            ',"token":"', vm.toString(o.token),
            '","proofOfInference":"', vm.toString(o.poi),
            '","burner":"', vm.toString(o.burner),
            '","stake":"', vm.toString(o.stakeC)
        );
        string memory b = string.concat(
            '","priceFeed":"', vm.toString(c.priceFeed),
            '","agentIds":"', vm.toString(o.agentIds),
            '","router":"', vm.toString(router),
            '","opsTreasury":"', vm.toString(c.opsTreasury),
            '","maxPerAgentPerEpoch":"', vm.toString(c.maxPerAgentPerEpoch), '"}'
        );
        vm.writeFile(string.concat("deployments/", vm.toString(block.chainid), ".json"), string.concat(a, b));
    }
}
