// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {SuanToken} from "../src/SuanToken.sol";
import {ProofOfInference} from "../src/ProofOfInference.sol";
import {BuybackBurner} from "../src/BuybackBurner.sol";
import {SuanStake} from "../src/SuanStake.sol";
import {MockRegistry} from "../src/mocks/MockRegistry.sol";
import {MockRouter} from "../src/mocks/MockRouter.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";

/// Local anvil stack with a mock price feed ($700/BNB), registry and router.
/// Registers agent #1 for the deployer.
contract DeployLocal is Script {
    struct Out {
        address feed;
        address reg;
        address router;
        address token;
        address burner;
        address poi;
        address stakeC;
        address deployer;
        uint256 agentId;
    }

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        Out memory o;
        o.deployer = vm.addr(pk);
        vm.startBroadcast(pk);
        o = _deploy(o);
        vm.stopBroadcast();
        console.log("agentId", o.agentId);
        _write(o);
    }

    function _deploy(Out memory o) internal returns (Out memory) {
        o.feed = address(new MockAggregator(700e8, 8));
        o.reg = address(new MockRegistry());
        o.router = address(new MockRouter(address(0xB4B)));
        address predicted = vm.computeCreateAddress(o.deployer, vm.getNonce(o.deployer) + 2);
        o.token = address(new SuanToken("Yansuan", "YAN", predicted));
        o.burner = address(new BuybackBurner(o.token, o.router, 5e18, o.deployer));
        o.poi = address(
            new ProofOfInference(o.token, o.feed, 365 days, o.reg, o.deployer, o.burner, 2000, 40_000e18, 7000, 1e18, 1000, o.deployer)
        );
        require(o.poi == predicted, "minter prediction failed");
        o.stakeC = address(new SuanStake(o.token));
        o.agentId = MockRegistry(o.reg).register("http://localhost/agent.json");
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
            '","registry":"', vm.toString(o.reg),
            '","router":"', vm.toString(o.router),
            '","opsTreasury":"', vm.toString(o.deployer),
            '","agentId":', vm.toString(o.agentId), '}'
        );
        vm.writeFile(string.concat("deployments/", vm.toString(block.chainid), ".json"), string.concat(a, b));
    }
}
