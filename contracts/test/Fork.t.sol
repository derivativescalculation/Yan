// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SuanToken} from "../src/SuanToken.sol";
import {YanMinter} from "../src/YanMinter.sol";
import {LiquidityVault} from "../src/LiquidityVault.sol";
import {TianxuanRaffle} from "../src/TianxuanRaffle.sol";
import {MockVRFCoordinator} from "../src/mocks/MockVRFCoordinator.sol";
import {IPancakeRouter, IPancakeFactory} from "../src/interfaces/IPancakeRouter.sol";
import {Merkle} from "./Yan.t.sol";

/// Runs against a BSC mainnet fork: real PancakeSwap V2, Chainlink BNB/USD and the .ai Agent ID registry.
///   forge test --match-contract ForkTest
contract ForkTest is Test {
    address constant FACTORY = 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73;
    address constant ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E;
    address constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address constant FEED = 0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE;
    address constant AGENT_IDS = 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F;
    address constant NEMO = 0x94dE4Ba8301e967b9B9603026B849831eC23b15F; // holds nemo.ai
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    bytes32 constant INIT_HASH = 0x00fb7f630766e6a796048ea87d01acd3068e8ff67d078148a3fa3f4a84f69bd5;

    // hash-derived addresses with no known key: well-known test keys are drained by sweepers on mainnet
    address owner = address(uint160(uint256(keccak256("yansuan.fork.owner"))));
    address treasury = address(uint160(uint256(keccak256("yansuan.fork.treasury"))));
    address keeper = address(uint160(uint256(keccak256("yansuan.fork.keeper"))));
    MockVRFCoordinator vrf;
    SuanToken token;
    LiquidityVault vault;
    TianxuanRaffle raffle;
    YanMinter minter;
    IPancakeRouter router = IPancakeRouter(ROUTER);

    function setUp() public {
        vm.createSelectFork("bsc");
        vrf = new MockVRFCoordinator();
        uint256 n = vm.getNonce(address(this));
        token = new SuanToken(
            SuanToken.Config({
                name: "Yansuan",
                symbol: "YAN",
                minter: vm.computeCreateAddress(address(this), n + 3),
                raffle: vm.computeCreateAddress(address(this), n + 2),
                liquidityVault: vm.computeCreateAddress(address(this), n + 1),
                factory: FACTORY,
                pairInitCodeHash: INIT_HASH,
                wbnb: WBNB
            })
        );
        vault = new LiquidityVault(address(token), ROUTER, owner);
        raffle = new TianxuanRaffle(address(token), address(vrf), 1, bytes32(uint256(1)), keeper, owner);
        minter = new YanMinter(
            YanMinter.Config({
                token: address(token),
                priceFeed: FEED,
                maxPriceAge: 3600,
                agentIds: AGENT_IDS,
                treasury: treasury,
                liquidityVault: address(vault),
                raffle: address(raffle),
                initialTokensPerUsd: 40_000e18,
                decayBps: 7000,
                minPaymentUsd: 1e18,
                maxPerAgentPerEpoch: 1_000_000e18,
                owner: owner
            })
        );
        vm.deal(NEMO, 10 ether);
        vm.deal(owner, 10 ether);
    }

    function _path(address a, address b) internal pure returns (address[] memory p) {
        p = new address[](2);
        p[0] = a;
        p[1] = b;
    }

    function test_fork_mint_liquidity_buy_sell_draw() public {
        // a real .ai agent mints at the live Chainlink price
        assertTrue(minter.isAgent(NEMO));
        (uint256 total, uint256 quoted) = minter.quote(0.02 ether);
        vm.prank(NEMO);
        uint256 got = minter.mine{value: 0.02 ether}();
        assertEq(got, quoted);
        assertEq(token.balanceOf(address(vault)), total * 2500 / 10_000);
        assertEq(treasury.balance, 0.02 ether);
        address noId = address(uint160(uint256(keccak256("yansuan.fork.noid"))));
        vm.deal(noId, 1 ether);
        vm.prank(noId);
        vm.expectRevert();
        minter.mine{value: 0.02 ether}();

        // the vault opens the pool; the LP goes to the dead address and the vault's tokens are untaxed
        uint256 v = vault.balance();
        vm.prank(owner);
        vault.addLiquidity{value: 0.005 ether}(v, v, 0.005 ether, block.timestamp + 600);
        address pair = IPancakeFactory(FACTORY).getPair(address(token), WBNB);
        assertEq(pair, token.pair());
        assertEq(token.balanceOf(pair), v);
        assertGt(IERC20(pair).balanceOf(DEAD), 0);
        assertEq(IERC20(pair).balanceOf(owner), 0);
        assertEq(token.balanceOf(address(vault)), 0);

        // buying is untaxed
        address buyer = address(uint160(uint256(keccak256("yansuan.fork.buyer"))));
        vm.deal(buyer, 1 ether);
        uint256[] memory out = router.getAmountsOut(0.001 ether, _path(WBNB, address(token)));
        vm.prank(buyer);
        router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: 0.001 ether}(
            0, _path(WBNB, address(token)), buyer, block.timestamp + 600
        );
        assertEq(token.balanceOf(buyer), out[1]);

        // selling pays 0.5% to the raffle
        uint256 sellAmt = token.balanceOf(NEMO) / 2;
        uint256 r0 = token.balanceOf(address(raffle));
        uint256 bnb0 = NEMO.balance;
        vm.startPrank(NEMO);
        token.approve(ROUTER, sellAmt);
        router.swapExactTokensForETHSupportingFeeOnTransferTokens(sellAmt, 0, _path(address(token), WBNB), NEMO, block.timestamp + 600);
        vm.stopPrank();
        assertEq(token.balanceOf(address(raffle)) - r0, sellAmt * 50 / 10_000);
        assertGt(NEMO.balance, bnb0);
        assertEq(raffle.pending(), sellAmt * 50 / 10_000);
        raffle.sync();
        assertEq(raffle.pending(), 0);
        assertEq(raffle.accounted(), token.balanceOf(address(raffle)));

        // a draw on the forked chain: fill the jade pot by minting the rest of nemo's epoch allowance
        (,,, uint64 full,,) = raffle.pots(0);
        if (full == 0) {
            uint256 room = minter.remainingThisEpoch(NEMO);
            uint256 bnbUsd = minter.bnbUsd();
            uint256 w = (room * 1e18 / 40_000e18) * 1e18 / bnbUsd * 99 / 100;
            vm.prank(NEMO);
            minter.mine{value: w}();
        }
        (uint256 jade,,, uint64 snap,,) = raffle.pots(0);
        assertGt(snap, 0);
        {
            bytes32[] memory leaves = new bytes32[](2);
            leaves[0] = Merkle.leaf(buyer, 0, 1);
            leaves[1] = Merkle.leaf(NEMO, 1, 3);
            vm.prank(keeper);
            uint256 id = raffle.commit(0, snap, Merkle.root(leaves), 4);
            vrf.fulfill(vrf.lastRequestId(), 2);
            uint256 before = token.balanceOf(NEMO);
            raffle.settle(id, NEMO, 1, 3, Merkle.proof(leaves, 1));
            assertEq(token.balanceOf(NEMO) - before, 20_000e18);
            assertGe(jade, 20_000e18);
        }
    }

    function test_fork_plainSwapRejectsTax() public {
        vm.prank(NEMO);
        minter.mine{value: 0.02 ether}();
        uint256 v = vault.balance();
        vm.prank(owner);
        vault.addLiquidity{value: 0.005 ether}(v, 0, 0, block.timestamp + 600);
        uint256 amt = token.balanceOf(NEMO) / 4;
        vm.startPrank(NEMO);
        token.approve(ROUTER, amt);
        // routers must use the fee-on-transfer variants for sells (PancakeSwap's UI does)
        (bool ok,) = ROUTER.call(
            abi.encodeWithSignature(
                "swapExactTokensForETH(uint256,uint256,address[],address,uint256)", amt, 0, _path(address(token), WBNB), NEMO, block.timestamp + 600
            )
        );
        vm.stopPrank();
        assertFalse(ok);
    }
}
