// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SuanToken} from "../src/SuanToken.sol";
import {ProofOfInference} from "../src/ProofOfInference.sol";
import {BuybackBurner} from "../src/BuybackBurner.sol";
import {SuanStake} from "../src/SuanStake.sol";
import {MockUSD} from "../src/mocks/MockUSD.sol";
import {MockRegistry} from "../src/mocks/MockRegistry.sol";
import {MockRouter} from "../src/mocks/MockRouter.sol";

contract ProofOfInferenceTest is Test {
    uint256 constant RATE = 10_000e18; // tokens per USD, epoch 0
    uint256 constant MIN = 1e18; // $1
    uint256 constant BURN_BPS = 3000;
    uint256 constant REDEEM_BPS = 5000;
    uint256 constant DECAY = 5000; // halving in the base suite

    address owner = makeAddr("owner");
    address ops = makeAddr("ops");
    address agentOwner = makeAddr("agentOwner");
    address agentWallet = makeAddr("agentWallet");
    address human = makeAddr("human");
    address wbnb = makeAddr("wbnb");

    SuanToken token;
    MockUSD usd;
    MockRegistry reg;
    MockRouter router;
    BuybackBurner burner;
    ProofOfInference poi;
    SuanStake stakeC;
    uint256 agentId;

    function setUp() public {
        _deploy(18);
    }

    function _deploy(uint8 dec) internal {
        _deployWith(dec, DECAY);
    }

    function _deployWith(uint8 dec, uint256 decay) internal {
        usd = new MockUSD("USD1", "USD1", dec);
        reg = new MockRegistry();
        router = new MockRouter(wbnb);
        // minter is fixed at construction: predict the ProofOfInference address (token, burner, poi)
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);
        token = new SuanToken("Yansuan", "YAN", predicted);
        burner = new BuybackBurner(address(usd), address(token), address(router), 10_000e18, owner);
        poi = new ProofOfInference(
            address(token), address(usd), address(reg), ops, address(burner), BURN_BPS, RATE, decay, MIN, REDEEM_BPS, owner
        );
        assertEq(address(poi), predicted, "minter prediction");
        stakeC = new SuanStake(address(token));
        agentId = reg.registerFor(agentOwner, agentWallet);
    }

    function _fund(address who, uint256 amount) internal {
        usd.mint(who, amount);
        vm.prank(who);
        usd.approve(address(poi), type(uint256).max);
    }

    // ------------------------------------------------------------ gating

    function test_humanCannotMine() public {
        _fund(human, 100e18);
        vm.expectRevert(abi.encodeWithSelector(ProofOfInference.NotAgentOperator.selector, agentId, human));
        vm.prank(human);
        poi.mine(agentId, 10e18);
    }

    function test_agentOwnerAndWalletCanMine() public {
        _fund(agentOwner, 100e18);
        _fund(agentWallet, 100e18);
        vm.prank(agentOwner);
        uint256 a = poi.mine(agentId, 10e18);
        vm.prank(agentWallet);
        uint256 b = poi.mine(agentId, 10e18);
        assertEq(a, 100_000e18);
        assertEq(b, 100_000e18);
        assertEq(token.balanceOf(agentOwner), a);
        assertEq(token.balanceOf(agentWallet), b);
        assertEq(poi.minedByAgent(agentId), a + b);
        assertEq(poi.creditsUsd(agentId), 20e18);
        assertEq(poi.agentCount(), 1);
    }

    function test_onlyMinterCanMint() public {
        vm.expectRevert(SuanToken.NotMinter.selector);
        token.mint(human, 1);
        assertEq(token.minter(), address(poi));
    }

    function test_redeemWorksWhilePaused() public {
        _fund(agentOwner, 100e18);
        vm.prank(agentOwner);
        uint256 m = poi.mine(agentId, 10e18);
        vm.prank(owner);
        poi.pause();
        vm.startPrank(agentOwner);
        token.approve(address(poi), m);
        assertGt(poi.redeem(agentId, m), 0);
        vm.stopPrank();
    }

    function test_badParamsRejected() public {
        vm.expectRevert(ProofOfInference.BadRate.selector);
        new ProofOfInference(address(token), address(usd), address(reg), ops, address(burner), BURN_BPS, 0, DECAY, MIN, REDEEM_BPS, owner);
        vm.expectRevert(ProofOfInference.BadBps.selector);
        new ProofOfInference(address(token), address(usd), address(reg), ops, address(burner), 10_000, RATE, DECAY, MIN, REDEEM_BPS, owner);
    }

    // ---------------------------------------------------------------- solvency of the DEPLOY parameters
    // Worst case: every agent spends all credit at the best tier discount and redeems every token.
    // Treasury share must cover the raw model bill: (1-burn) * (1 + markup*(1-dMax)) >= 1 + redeem.
    // These constants mirror script/Deploy.s.sol defaults and gateway/src/pricing.ts.
    uint256 constant DEPLOY_BURN_BPS = 2000;
    uint256 constant DEPLOY_REDEEM_BPS = 1000;
    uint256 constant GATEWAY_MARKUP_BPS = 7500;
    uint256 constant GATEWAY_MAX_DISCOUNT_BPS = 2500;

    function test_deployParamsSolvent() public pure {
        uint256 effMarkup = GATEWAY_MARKUP_BPS * (10_000 - GATEWAY_MAX_DISCOUNT_BPS) / 10_000;
        uint256 revenue = (10_000 - DEPLOY_BURN_BPS) * (10_000 + effMarkup); // x1e8
        uint256 liability = (10_000 + DEPLOY_REDEEM_BPS) * 10_000; // x1e8
        // require at least a 10% gross margin on the worst case
        assertGe(revenue * 100, liability * 110, "deploy params insolvent at best tier");
    }

    function test_belowMinimum() public {
        _fund(agentOwner, 100e18);
        vm.prank(agentOwner);
        vm.expectRevert(ProofOfInference.BelowMinimum.selector);
        poi.mine(agentId, 0.5e18);
    }

    function test_pause() public {
        _fund(agentOwner, 100e18);
        vm.prank(owner);
        poi.pause();
        vm.prank(agentOwner);
        vm.expectRevert();
        poi.mine(agentId, 10e18);
        vm.prank(owner);
        poi.unpause();
        vm.prank(agentOwner);
        poi.mine(agentId, 10e18);
    }

    // ------------------------------------------------------------ split

    function test_splitBurnAndOps() public {
        _fund(agentOwner, 100e18);
        vm.prank(agentOwner);
        poi.mine(agentId, 100e18);
        assertEq(usd.balanceOf(address(burner)), 30e18);
        assertEq(usd.balanceOf(ops), 70e18);
        assertEq(poi.totalUsdPaid(), 100e18);
    }

    function test_sixDecimalStable() public {
        _deploy(6);
        _fund(agentOwner, 100e6);
        vm.prank(agentOwner);
        uint256 minted = poi.mine(agentId, 10e6);
        assertEq(minted, 100_000e18);
        assertEq(poi.creditsUsd(agentId), 10e18);
        assertEq(usd.balanceOf(address(burner)), 3e6);
        assertEq(usd.balanceOf(ops), 7e6);
    }

    // ------------------------------------------------------------ emission

    function test_quoteMatchesMine() public {
        _fund(agentOwner, 1e24);
        uint256 q = poi.quote(12_345e18);
        vm.prank(agentOwner);
        assertEq(poi.mine(agentId, 12_345e18), q);
    }

    function test_halvingBoundary() public {
        // epoch 0 holds 100M tokens = $10,000 at 10k/USD. Pay $10,001 -> 100M + 5,000 (half rate).
        _fund(agentOwner, 1e24);
        vm.prank(agentOwner);
        uint256 minted = poi.mine(agentId, 10_001e18);
        assertEq(minted, 100_000_000e18 + 5_000e18);
        assertEq(poi.currentEpoch(), 1);
        assertEq(poi.tokensPerUsd(), RATE / 2);
    }

    function test_decay70() public {
        _deployWith(18, 7000);
        assertEq(poi.rateAt(0), 100_000e18 / 10);
        assertEq(poi.rateAt(1), 7_000e18);
        assertEq(poi.rateAt(2), 4_900e18);
        assertEq(poi.rateAt(9), 40_353_607e18 / 100_000); // 10k * 0.7^9 = 403.53607
        assertEq(poi.rateAt(10), 0);
        // paying exactly costToCap() mints the entire cap
        uint256 expected = poi.costToCap();
        _fund(agentOwner, 1e30);
        vm.prank(agentOwner);
        uint256 minted = poi.mine(agentId, expected);
        assertEq(minted, token.CAP());
        assertEq(poi.costToCap(), 0);
    }

    function test_badDecayRejected() public {
        vm.expectRevert(ProofOfInference.BadBps.selector);
        new ProofOfInference(address(token), address(usd), address(reg), ops, address(burner), BURN_BPS, RATE, 10_000, MIN, REDEEM_BPS, owner);
    }

    function test_capReached() public {
        // total cost of all 10 epochs: 10k * (1+2+4+...+512) = 10,230,000 USD
        _fund(agentOwner, 1e30);
        vm.prank(agentOwner);
        uint256 minted = poi.mine(agentId, 10_230_000e18);
        assertEq(minted, token.CAP());
        assertEq(poi.tokensPerUsd(), 0);
        vm.prank(agentOwner);
        vm.expectRevert(ProofOfInference.CapReached.selector);
        poi.mine(agentId, 100e18);
    }

    function testFuzz_neverExceedsCap(uint256 a, uint256 b, uint256 c) public {
        a = bound(a, 1e18, 5_000_000e18);
        b = bound(b, 1e18, 5_000_000e18);
        c = bound(c, 1e18, 5_000_000e18);
        _fund(agentOwner, 1e30);
        vm.startPrank(agentOwner);
        poi.mine(agentId, a);
        poi.mine(agentId, b);
        poi.mine(agentId, c);
        vm.stopPrank();
        assertLe(token.totalSupply(), token.CAP());
        assertEq(poi.totalMinted(), token.totalSupply());
    }

    function testFuzz_monotoneRate(uint256 a) public {
        a = bound(a, 1e18, 20_000e18);
        _fund(agentOwner, 1e30);
        uint256 r0 = poi.tokensPerUsd();
        vm.prank(agentOwner);
        poi.mine(agentId, a);
        assertLe(poi.tokensPerUsd(), r0);
    }

    // ------------------------------------------------------------ redeem utility

    function test_redeemBurnsAndCredits() public {
        _fund(agentOwner, 100e18);
        vm.startPrank(agentOwner);
        uint256 minted = poi.mine(agentId, 10e18); // 100k tokens
        token.approve(address(poi), minted);
        uint256 credit = poi.redeem(agentId, minted);
        vm.stopPrank();
        // 100k tokens / 10k per USD = $10 * 50% = $5
        assertEq(credit, 5e18);
        assertEq(poi.creditsUsd(agentId), 15e18);
        assertEq(token.balanceOf(agentOwner), 0);
        assertEq(token.totalSupply(), 0);
        assertEq(poi.totalRedeemed(), minted);
    }

    function test_redeemConstantAcrossHalving() public {
        _fund(agentOwner, 1e24);
        vm.startPrank(agentOwner);
        poi.mine(agentId, 10e18); // 100k tokens, epoch 0
        uint256 before = poi.quoteRedeem(100_000e18);
        poi.mine(agentId, 10_000e18); // pushes into epoch 1
        uint256 later = poi.quoteRedeem(100_000e18);
        vm.stopPrank();
        assertEq(later, before);
        assertEq(later, 5e18); // 100k / 10k per USD = $10 x 50%
    }

    /// Worst case: an agent spends all credit AND redeems every token. Redemption credit must stay
    /// bounded by redeemBps of what was paid so the gateway margin can be sized against it.
    function testFuzz_redeemLiabilityBounded(uint256 a) public {
        a = bound(a, 1e18, 1_000_000e18);
        _fund(agentOwner, 1e30);
        vm.startPrank(agentOwner);
        uint256 minted = poi.mine(agentId, a);
        token.approve(address(poi), minted);
        uint256 credit = poi.redeem(agentId, minted);
        vm.stopPrank();
        assertLe(credit, a * REDEEM_BPS / 10_000);
    }

    function test_humanCannotRedeem() public {
        vm.prank(human);
        vm.expectRevert(abi.encodeWithSelector(ProofOfInference.NotAgentOperator.selector, agentId, human));
        poi.redeem(agentId, 1e18);
    }

    // ------------------------------------------------------------ burner

    function test_buybackAndBurn() public {
        _fund(agentOwner, 200e18);
        vm.prank(agentOwner);
        poi.mine(agentId, 100e18); // burner holds 30 USD
        // seed the fake router with tokens (as if a pool existed): mine more and send to router
        vm.prank(agentOwner);
        uint256 m = poi.mine(agentId, 100e18);
        vm.prank(agentOwner);
        token.transfer(address(router), m);
        uint256 supplyBefore = token.totalSupply();
        vm.prank(owner);
        vm.expectRevert(BuybackBurner.SlippageTooLoose.selector);
        burner.buybackAndBurn(0, 1, false);
        vm.prank(owner);
        uint256 burned = burner.buybackAndBurn(0, 60e18 * 2 * 97 / 100, false);
        assertEq(burned, 60e18 * 2);
        assertEq(token.totalSupply(), supplyBefore - burned);
        assertEq(usd.balanceOf(address(burner)), 0);
        assertEq(burner.totalBurned(), burned);
    }

    function test_burnerOnlyKeeper() public {
        vm.prank(human);
        vm.expectRevert(BuybackBurner.NotKeeper.selector);
        burner.buybackAndBurn(0, 0, false);
    }

    // ------------------------------------------------------------ staking

    function test_stakeCooldown() public {
        _fund(agentOwner, 100e18);
        vm.startPrank(agentOwner);
        uint256 m = poi.mine(agentId, 10e18);
        token.approve(address(stakeC), m);
        stakeC.stake(agentId, m);
        assertEq(stakeC.staked(agentId), m);
        stakeC.requestUnstake(agentId, m);
        assertEq(stakeC.staked(agentId), 0);
        vm.expectRevert(SuanStake.Locked.selector);
        stakeC.withdraw(agentId);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        stakeC.withdraw(agentId);
        vm.stopPrank();
        assertEq(token.balanceOf(agentOwner), m);
    }
}
