// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {SuanToken} from "../src/SuanToken.sol";
import {YanMinter} from "../src/YanMinter.sol";
import {LiquidityVault} from "../src/LiquidityVault.sol";
import {TianxuanRaffle} from "../src/TianxuanRaffle.sol";
import {MockAgentIdRegistry} from "../src/mocks/MockAgentIdRegistry.sol";
import {MockVRFCoordinator} from "../src/mocks/MockVRFCoordinator.sol";

/// Usage:
///   forge script script/Deploy.s.sol --rpc-url bsc --broadcast --skip-simulation --verify
/// Env:
///   PRIVATE_KEY              deployer (becomes owner of the minter, vault and raffle)
///   TREASURY                 receives all BNB; must not be the deployer on chain 56
///   KEEPER                   commits raffle ticket lists (a separate hot wallet)
///   AGENT_ID_REGISTRY        Binance .ai Agent ID registry (mainnet 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F).
///                            Omit off mainnet to deploy a mock and give TEST_AGENT the handle TEST_HANDLE.
///   PRICE_FEED               Chainlink BNB/USD (mainnet 0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE,
///                            testnet 0x2514895c72f50D8bd4B4F9b1110F0D6bD2c97526)
///   MAX_PRICE_AGE            seconds before the feed counts as stale (default 3600)
///   ROUTER / FACTORY / PAIR_INIT_CODE_HASH   PancakeSwap V2
///   VRF_COORDINATOR          Chainlink VRF v2.5; omit on chain 31337 to deploy a mock
///   VRF_SUB_ID / VRF_KEY_HASH
///   INITIAL_TOKENS_PER_USD   default 40000e18
///   DECAY_BPS                default 7000
///   MIN_PAYMENT_USD          default 1e18
///   MAX_PER_AGENT_PER_EPOCH  default 1000000e18 (0 = uncapped)
///   TOKEN_NAME / TOKEN_SYMBOL
contract Deploy is Script {
    struct P {
        address deployer;
        address treasury;
        address keeper;
        address agentIds;
        address feed;
        uint256 maxPriceAge;
        address router;
        address factory;
        bytes32 initCodeHash;
        address wbnb;
        address vrf;
        uint256 subId;
        bytes32 keyHash;
        uint256 maxPerAgentPerEpoch;
    }

    struct Out {
        address token;
        address vault;
        address raffle;
        address minter;
    }

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        P memory p = _params(vm.addr(pk));

        vm.startBroadcast(pk);
        if (p.agentIds == address(0)) {
            require(block.chainid != 56, "AGENT_ID_REGISTRY required on mainnet");
            MockAgentIdRegistry m = new MockAgentIdRegistry();
            address testAgent = vm.envOr("TEST_AGENT", address(0));
            if (testAgent != address(0)) m.setHandle(testAgent, vm.envOr("TEST_HANDLE", string("genesis")));
            p.agentIds = address(m);
        }
        if (p.vrf == address(0)) {
            require(block.chainid == 31337, "VRF_COORDINATOR required off local chains");
            p.vrf = address(new MockVRFCoordinator());
        }
        Out memory o = _deploy(p);
        vm.stopBroadcast();

        console.log("chain", block.chainid);
        console.log("token", o.token);
        console.log("minter", o.minter);
        console.log("vault", o.vault);
        console.log("raffle", o.raffle);
        console.log("pair", SuanToken(o.token).pair());
        _write(p, o);
    }

    /// token (n), vault (n+1), raffle (n+2), minter (n+3): the token is built with all three addresses
    function _deploy(P memory p) internal returns (Out memory o) {
        uint256 n = vm.getNonce(p.deployer);
        address vaultAt = vm.computeCreateAddress(p.deployer, n + 1);
        address raffleAt = vm.computeCreateAddress(p.deployer, n + 2);
        address minterAt = vm.computeCreateAddress(p.deployer, n + 3);
        o.token = address(
            new SuanToken(
                SuanToken.Config({
                    name: vm.envOr("TOKEN_NAME", string("Yansuan")),
                    symbol: vm.envOr("TOKEN_SYMBOL", string("YAN")),
                    minter: minterAt,
                    raffle: raffleAt,
                    liquidityVault: vaultAt,
                    factory: p.factory,
                    pairInitCodeHash: p.initCodeHash,
                    wbnb: p.wbnb
                })
            )
        );
        o.vault = address(new LiquidityVault(o.token, p.router, p.deployer));
        o.raffle = address(new TianxuanRaffle(o.token, p.vrf, p.subId, p.keyHash, p.keeper, p.deployer));
        o.minter = address(
            new YanMinter(
                YanMinter.Config({
                    token: o.token,
                    priceFeed: p.feed,
                    maxPriceAge: p.maxPriceAge,
                    agentIds: p.agentIds,
                    treasury: p.treasury,
                    liquidityVault: o.vault,
                    raffle: o.raffle,
                    initialTokensPerUsd: vm.envOr("INITIAL_TOKENS_PER_USD", uint256(40_000e18)),
                    decayBps: vm.envOr("DECAY_BPS", uint256(7000)),
                    minPaymentUsd: vm.envOr("MIN_PAYMENT_USD", uint256(1e18)),
                    maxPerAgentPerEpoch: p.maxPerAgentPerEpoch,
                    owner: p.deployer
                })
            )
        );
        require(o.vault == vaultAt && o.raffle == raffleAt && o.minter == minterAt, "address prediction failed");
    }

    function _params(address deployer) internal view returns (P memory p) {
        p.deployer = deployer;
        p.treasury = vm.envAddress("TREASURY");
        p.keeper = vm.envAddress("KEEPER");
        p.agentIds = vm.envOr("AGENT_ID_REGISTRY", address(0));
        p.feed = vm.envAddress("PRICE_FEED");
        p.maxPriceAge = vm.envOr("MAX_PRICE_AGE", uint256(3600));
        p.router = vm.envAddress("ROUTER");
        p.factory = vm.envAddress("FACTORY");
        p.initCodeHash = vm.envBytes32("PAIR_INIT_CODE_HASH");
        p.wbnb = vm.envAddress("WBNB");
        p.vrf = vm.envOr("VRF_COORDINATOR", address(0));
        p.subId = vm.envOr("VRF_SUB_ID", uint256(1));
        p.keyHash = vm.envOr("VRF_KEY_HASH", bytes32(0));
        p.maxPerAgentPerEpoch = vm.envOr("MAX_PER_AGENT_PER_EPOCH", uint256(1_000_000e18));
        require(p.treasury != address(0) && p.keeper != address(0), "TREASURY and KEEPER required");
        if (block.chainid == 56) {
            require(p.treasury != deployer, "TREASURY must not be the deployer on mainnet");
            require(p.keeper != deployer, "KEEPER must not be the deployer on mainnet");
            require(p.keyHash != bytes32(0) && p.subId > 1, "VRF_SUB_ID and VRF_KEY_HASH required on mainnet");
        }
    }

    function _write(P memory p, Out memory o) internal {
        string memory a = string.concat(
            '{"chainId":', vm.toString(block.chainid),
            ',"token":"', vm.toString(o.token),
            '","minter":"', vm.toString(o.minter),
            '","liquidityVault":"', vm.toString(o.vault),
            '","raffle":"', vm.toString(o.raffle),
            '","pair":"', vm.toString(SuanToken(o.token).pair())
        );
        string memory b = string.concat(
            '","priceFeed":"', vm.toString(p.feed),
            '","agentIds":"', vm.toString(p.agentIds),
            '","router":"', vm.toString(p.router),
            '","treasury":"', vm.toString(p.treasury),
            '","keeper":"', vm.toString(p.keeper)
        );
        string memory c = string.concat(
            '","vrfCoordinator":"', vm.toString(p.vrf),
            '","vrfSubId":"', vm.toString(p.subId),
            '","maxPerAgentPerEpoch":"', vm.toString(p.maxPerAgentPerEpoch), '"}'
        );
        vm.writeFile(string.concat("deployments/", vm.toString(block.chainid), ".json"), string.concat(a, b, c));
    }
}
