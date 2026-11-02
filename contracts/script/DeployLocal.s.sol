// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {SuanToken} from "../src/SuanToken.sol";
import {ProofOfInference} from "../src/ProofOfInference.sol";
import {BuybackBurner} from "../src/BuybackBurner.sol";
import {SuanStake} from "../src/SuanStake.sol";
import {MockAgentIdRegistry} from "../src/mocks/MockAgentIdRegistry.sol";
import {MockRouter} from "../src/mocks/MockRouter.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";

/// Local anvil stack: mock price feed ($700/BNB), mock Agent ID registry, mock router.
/// Gives the deployer (anvil account 0) the handle "genesis".
contract DeployLocal is Script {
    struct Out {
        address feed;
        address ids;
        address router;
        address token;
        address burner;
        address poi;
        address stakeC;
        address deployer;
    }

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        Out memory o;
        o.deployer = vm.addr(pk);
        vm.startBroadcast(pk);
        o = _deploy(o);
        vm.stopBroadcast();
        _write(o);
    }

    function _deploy(Out memory o) internal returns (Out memory) {
        o.feed = address(new MockAggregator(700e8, 8));
        o.ids = address(new MockAgentIdRegistry());
        o.router = address(new MockRouter(address(0xB4B)));
        address predicted = vm.computeCreateAddress(o.deployer, vm.getNonce(o.deployer) + 2);
        o.token = address(new SuanToken("Yansuan", "YAN", predicted));
        o.burner = address(new BuybackBurner(o.token, o.router, 5e18, o.deployer));
        ProofOfInference.Config memory c = ProofOfInference.Config({
            token: o.token,
            priceFeed: o.feed,
            maxPriceAge: 365 days,
            agentIds: o.ids,
            opsTreasury: o.deployer,
            burner: o.burner,
            burnBps: 2000,
            initialTokensPerUsd: 40_000e18,
            decayBps: 7000,
            minPaymentUsd: 1e18,
            redeemBps: 1000,
            maxPerAgentPerEpoch: 1_000_000e18,
            owner: o.deployer
        });
        o.poi = address(new ProofOfInference(c));
        require(o.poi == predicted, "minter prediction failed");
        o.stakeC = address(new SuanStake(o.token));
        MockAgentIdRegistry(o.ids).setHandle(o.deployer, "genesis");
        return o;
    }

    function _write(Out memory o) internal {
        string memory a = string.concat(
            '{"chainId":', vm.toString(block.chainid),
            ',"token":"', vm.toString(o.token),
            '","proofOfInference":"', vm.toString(o.poi),
            '","burner":"', vm.toString(o.burner),
            '","stake":"', vm.toString(o.stakeC)
        );
        string memory b = string.concat(
            '","priceFeed":"', vm.toString(o.feed),
            '","agentIds":"', vm.toString(o.ids),
            '","router":"', vm.toString(o.router),
            '","opsTreasury":"', vm.toString(o.deployer),
            '","maxPerAgentPerEpoch":"1000000000000000000000000"}'
        );
        vm.writeFile(string.concat("deployments/", vm.toString(block.chainid), ".json"), string.concat(a, b));
        console.log("local stack written");
    }
}
