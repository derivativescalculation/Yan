// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SuanToken} from "../src/SuanToken.sol";
import {ProofOfInference} from "../src/ProofOfInference.sol";
import {BuybackBurner} from "../src/BuybackBurner.sol";
import {SuanStake} from "../src/SuanStake.sol";
import {MockRegistry} from "../src/mocks/MockRegistry.sol";
import {MockRouter} from "../src/mocks/MockRouter.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";

contract RevertingReceiver {
    receive() external payable {
        revert("no");
    }
}

contract ProofOfInferenceTest is Test {
    uint256 constant RATE = 10_000e18; // tokens per USD, epoch 0
    uint256 constant MIN = 1e18; // $1
    uint256 constant BURN_BPS = 3000;
    uint256 constant REDEEM_BPS = 5000;
    uint256 constant DECAY = 5000; // halving in the base suite
    int256 constant PRICE = 500e8; // $500 per BNB, 8 decimals
    uint256 constant MAX_AGE = 3600;

    address owner = makeAddr("owner");
    address ops = makeAddr("ops");
    address agentOwner = makeAddr("agentOwner");
    address agentWallet = makeAddr("agentWallet");
    address human = makeAddr("human");
    address wbnb = makeAddr("wbnb");

    SuanToken token;
    MockAggregator feed;
    MockRegistry reg;
    MockRouter router;
    BuybackBurner burner;
    ProofOfInference poi;
    SuanStake stakeC;
    uint256 agentId;

    function setUp() public {
        _deployWith(DECAY, PRICE, 8);
    }

    function _deployWith(uint256 decay, int256 price, uint8 dec) internal {
        feed = new MockAggregator(price, dec);
        reg = new MockRegistry();
        router = new MockRouter(wbnb);
        // minter fixed at construction: token (n), burner (n+1), poi (n+2)
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);
        token = new SuanToken("Yansuan", "YAN", predicted);
        burner = new BuybackBurner(address(token), address(router), 100 ether, owner);
        poi = new ProofOfInference(
            address(token), address(feed), MAX_AGE, address(reg), ops, address(burner), BURN_BPS, RATE, decay, MIN, REDEEM_BPS, owner
        );
        assertEq(address(poi), predicted, "minter prediction");
        stakeC = new SuanStake(address(token));
        agentId = reg.registerFor(agentOwner, agentWallet);
    }

    /// wei for `usd18` dollars at the feed price
    function _wei(uint256 usd18) internal view returns (uint256) {
        return usd18 * 1e18 / poi.bnbUsd();
    }

    // ------------------------------------------------------------ gating

    function test_humanCannotMine() public {
        vm.deal(human, 10 ether);
        vm.expectRevert(abi.encodeWithSelector(ProofOfInference.NotAgentOperator.selector, agentId, human));
        vm.prank(human);
        poi.mine{value: 0.02 ether}(agentId);
    }

    function test_agentOwnerAndWalletCanMine() public {
        vm.deal(agentOwner, 1 ether);
        vm.deal(agentWallet, 1 ether);
        vm.prank(agentOwner);
        uint256 a = poi.mine{value: 0.02 ether}(agentId); // $10
        vm.prank(agentWallet);
        uint256 b = poi.mine{value: 0.02 ether}(agentId);
        assertEq(a, 100_000e18);
        assertEq(b, 100_000e18);
        assertEq(token.balanceOf(agentOwner), a);
        assertEq(token.balanceOf(agentWallet), b);
        assertEq(poi.minedByAgent(agentId), a + b);
        assertEq(poi.creditsUsd(agentId), 20e18);
        assertEq(poi.totalWeiPaid(), 0.04 ether);
        assertEq(poi.agentCount(), 1);
    }

    function test_onlyMinterCanMint() public {
        vm.expectRevert(SuanToken.NotMinter.selector);
        token.mint(human, 1);
        assertEq(token.minter(), address(poi));
    }

    function test_belowMinimum() public {
        vm.deal(agentOwner, 1 ether);
        vm.prank(agentOwner);
        vm.expectRevert(ProofOfInference.BelowMinimum.selector);
        poi.mine{value: 0.001 ether}(agentId); // $0.50
    }

    function test_pause() public {
        vm.deal(agentOwner, 1 ether);
        vm.prank(owner);
        poi.pause();
        vm.prank(agentOwner);
        vm.expectRevert();
        poi.mine{value: 0.02 ether}(agentId);
        vm.prank(owner);
        poi.unpause();
        vm.prank(agentOwner);
        poi.mine{value: 0.02 ether}(agentId);
    }

    // ------------------------------------------------------------ price feed

    function test_stalePriceReverts() public {
        vm.deal(agentOwner, 1 ether);
        vm.warp(vm.getBlockTimestamp() + MAX_AGE + 1);
        vm.prank(agentOwner);
        vm.expectRevert(ProofOfInference.StalePrice.selector);
        poi.mine{value: 0.02 ether}(agentId);
    }

    function test_badPriceReverts() public {
        vm.deal(agentOwner, 1 ether);
        feed.set(0);
        vm.prank(agentOwner);
        vm.expectRevert(ProofOfInference.BadPrice.selector);
        poi.mine{value: 0.02 ether}(agentId);
        feed.set(-1);
        vm.prank(agentOwner);
        vm.expectRevert(ProofOfInference.BadPrice.selector);
        poi.mine{value: 0.02 ether}(agentId);
    }

    function test_priceMovesUsdValue() public {
        vm.deal(agentOwner, 1 ether);
        feed.set(1000e8); // BNB doubles
        vm.prank(agentOwner);
        uint256 m = poi.mine{value: 0.02 ether}(agentId); // now $20
        assertEq(m, 200_000e18);
        assertEq(poi.creditsUsd(agentId), 20e18);
    }

    function test_feedDecimalsScaled() public {
        _deployWith(DECAY, 500e18, 18);
        vm.deal(agentOwner, 1 ether);
        vm.prank(agentOwner);
        assertEq(poi.mine{value: 0.02 ether}(agentId), 100_000e18);
    }

    // ------------------------------------------------------------ split

    function test_splitBurnAndOps() public {
        vm.deal(agentOwner, 10 ether);
        vm.prank(agentOwner);
        poi.mine{value: 1 ether}(agentId);
        assertEq(address(burner).balance, 0.3 ether);
        assertEq(ops.balance, 0.7 ether);
        assertEq(address(poi).balance, 0);
        assertEq(poi.totalUsdPaid(), 500e18);
    }

    function test_revertingTreasuryBlocksMine() public {
        RevertingReceiver bad = new RevertingReceiver();
        MockAggregator f = new MockAggregator(PRICE, 8);
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);
        SuanToken t = new SuanToken("Y", "Y", predicted);
        BuybackBurner bb = new BuybackBurner(address(t), address(router), 1 ether, owner);
        ProofOfInference p = new ProofOfInference(
            address(t), address(f), MAX_AGE, address(reg), address(bad), address(bb), BURN_BPS, RATE, DECAY, MIN, REDEEM_BPS, owner
        );
        vm.deal(agentOwner, 1 ether);
        vm.prank(agentOwner);
        vm.expectRevert(ProofOfInference.TransferFailed.selector);
        p.mine{value: 0.02 ether}(agentId);
    }

    // ------------------------------------------------------------ emission

    function test_quoteMatchesMine() public {
        vm.deal(agentOwner, 1_000 ether);
        uint256 q = poi.quote(24.69 ether);
        vm.prank(agentOwner);
        assertEq(poi.mine{value: 24.69 ether}(agentId), q);
    }

    function test_halvingBoundary() public {
        // epoch 0 holds 100M tokens = $10,000 at 10k/USD. Pay $10,001 -> 100M + 5,000 (half rate).
        vm.deal(agentOwner, 1_000 ether);
        uint256 w = _wei(10_001e18);
        vm.prank(agentOwner);
        uint256 minted = poi.mine{value: w}(agentId);
        assertEq(minted, 100_000_000e18 + 5_000e18);
        assertEq(poi.currentEpoch(), 1);
        assertEq(poi.tokensPerUsd(), RATE / 2);
    }

    function test_capReached() public {
        // total cost of all 10 epochs: 10k * (1+2+4+...+512) = 10,230,000 USD
        vm.deal(agentOwner, 100_000 ether);
        uint256 w = _wei(10_230_000e18);
        vm.prank(agentOwner);
        uint256 minted = poi.mine{value: w}(agentId);
        assertEq(minted, token.CAP());
        assertEq(poi.tokensPerUsd(), 0);
        vm.prank(agentOwner);
        vm.expectRevert(ProofOfInference.CapReached.selector);
        poi.mine{value: 1 ether}(agentId);
    }

    function test_decay70() public {
        _deployWith(7000, PRICE, 8);
        assertEq(poi.rateAt(0), 10_000e18);
        assertEq(poi.rateAt(1), 7_000e18);
        assertEq(poi.rateAt(2), 4_900e18);
        assertEq(poi.rateAt(9), 40_353_607e18 / 100_000); // 10k * 0.7^9
        assertEq(poi.rateAt(10), 0);
        // paying exactly costToCapWei() mints the entire cap
        uint256 w = poi.costToCapWei();
        vm.deal(agentOwner, w);
        vm.prank(agentOwner);
        uint256 minted = poi.mine{value: w}(agentId);
        assertEq(minted, token.CAP());
        assertEq(poi.costToCap(), 0);
    }

    function test_badParamsRejected() public {
        vm.expectRevert(ProofOfInference.BadRate.selector);
        new ProofOfInference(address(token), address(feed), MAX_AGE, address(reg), ops, address(burner), BURN_BPS, 0, DECAY, MIN, REDEEM_BPS, owner);
        vm.expectRevert(ProofOfInference.BadRate.selector);
        new ProofOfInference(address(token), address(feed), 0, address(reg), ops, address(burner), BURN_BPS, RATE, DECAY, MIN, REDEEM_BPS, owner);
        vm.expectRevert(ProofOfInference.BadBps.selector);
        new ProofOfInference(address(token), address(feed), MAX_AGE, address(reg), ops, address(burner), 10_000, RATE, DECAY, MIN, REDEEM_BPS, owner);
        vm.expectRevert(ProofOfInference.BadBps.selector);
        new ProofOfInference(address(token), address(feed), MAX_AGE, address(reg), ops, address(burner), BURN_BPS, RATE, 10_000, MIN, REDEEM_BPS, owner);
        vm.expectRevert(ProofOfInference.ZeroAddress.selector);
        new ProofOfInference(address(token), address(0), MAX_AGE, address(reg), ops, address(burner), BURN_BPS, RATE, DECAY, MIN, REDEEM_BPS, owner);
    }

    function testFuzz_neverExceedsCap(uint256 a, uint256 b, uint256 c) public {
        a = bound(a, 0.002 ether, 10_000 ether);
        b = bound(b, 0.002 ether, 10_000 ether);
        c = bound(c, 0.002 ether, 10_000 ether);
        vm.deal(agentOwner, 30_000 ether);
        vm.startPrank(agentOwner);
        poi.mine{value: a}(agentId);
        poi.mine{value: b}(agentId);
        poi.mine{value: c}(agentId);
        vm.stopPrank();
        assertLe(token.totalSupply(), token.CAP());
        assertEq(poi.totalMinted(), token.totalSupply());
        assertEq(address(poi).balance, 0);
    }

    function testFuzz_monotoneRate(uint256 a) public {
        a = bound(a, 0.002 ether, 40 ether);
        vm.deal(agentOwner, 100 ether);
        uint256 r0 = poi.tokensPerUsd();
        vm.prank(agentOwner);
        poi.mine{value: a}(agentId);
        assertLe(poi.tokensPerUsd(), r0);
    }

    // ------------------------------------------------------------ redeem utility

    function test_redeemBurnsAndCredits() public {
        vm.deal(agentOwner, 1 ether);
        vm.startPrank(agentOwner);
        uint256 minted = poi.mine{value: 0.02 ether}(agentId); // $10 -> 100k tokens
        token.approve(address(poi), minted);
        uint256 credit = poi.redeem(agentId, minted);
        vm.stopPrank();
        assertEq(credit, 5e18); // 100k / 10k per USD = $10 x 50%
        assertEq(poi.creditsUsd(agentId), 15e18);
        assertEq(token.balanceOf(agentOwner), 0);
        assertEq(token.totalSupply(), 0);
        assertEq(poi.totalRedeemed(), minted);
    }

    function test_redeemConstantAcrossEpochs() public {
        vm.deal(agentOwner, 1_000 ether);
        vm.startPrank(agentOwner);
        poi.mine{value: 0.02 ether}(agentId);
        uint256 before = poi.quoteRedeem(100_000e18);
        uint256 w = _wei(10_000e18);
        poi.mine{value: w}(agentId); // pushes into epoch 1
        uint256 later = poi.quoteRedeem(100_000e18);
        vm.stopPrank();
        assertEq(later, before);
        assertEq(later, 5e18);
    }

    function testFuzz_redeemLiabilityBounded(uint256 a) public {
        a = bound(a, 0.002 ether, 2_000 ether);
        vm.deal(agentOwner, 3_000 ether);
        vm.startPrank(agentOwner);
        uint256 minted = poi.mine{value: a}(agentId);
        uint256 paidUsd = poi.totalUsdPaid();
        token.approve(address(poi), minted);
        uint256 credit = poi.redeem(agentId, minted);
        vm.stopPrank();
        assertLe(credit, paidUsd * REDEEM_BPS / 10_000);
    }

    function test_humanCannotRedeem() public {
        vm.prank(human);
        vm.expectRevert(abi.encodeWithSelector(ProofOfInference.NotAgentOperator.selector, agentId, human));
        poi.redeem(agentId, 1e18);
    }

    function test_redeemWorksWhilePaused() public {
        vm.deal(agentOwner, 1 ether);
        vm.prank(agentOwner);
        uint256 m = poi.mine{value: 0.02 ether}(agentId);
        vm.prank(owner);
        poi.pause();
        vm.startPrank(agentOwner);
        token.approve(address(poi), m);
        assertGt(poi.redeem(agentId, m), 0);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ burner

    function test_buybackAndBurn() public {
        vm.deal(agentOwner, 10 ether);
        vm.prank(agentOwner);
        poi.mine{value: 1 ether}(agentId); // burner holds 0.3 BNB
        // seed the fake router with tokens (as if a pool existed)
        vm.prank(agentOwner);
        uint256 m = poi.mine{value: 1 ether}(agentId);
        vm.prank(agentOwner);
        token.transfer(address(router), m);
        uint256 supplyBefore = token.totalSupply();
        uint256 bal = address(burner).balance; // 0.6 BNB
        vm.prank(owner);
        vm.expectRevert(BuybackBurner.SlippageTooLoose.selector);
        burner.buybackAndBurn(0, 1);
        vm.prank(owner);
        uint256 burned = burner.buybackAndBurn(0, bal * 2 * 97 / 100);
        assertEq(burned, bal * 2);
        assertEq(token.totalSupply(), supplyBefore - burned);
        assertEq(address(burner).balance, 0);
        assertEq(burner.totalBurned(), burned);
        assertEq(burner.totalWeiSpent(), bal);
    }

    function test_burnerPerCallCap() public {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);
        SuanToken t = new SuanToken("Y", "Y", predicted);
        BuybackBurner bb = new BuybackBurner(address(t), address(router), 0.1 ether, owner);
        ProofOfInference p = new ProofOfInference(
            address(t), address(feed), MAX_AGE, address(reg), ops, address(bb), BURN_BPS, RATE, DECAY, MIN, REDEEM_BPS, owner
        );
        vm.deal(agentOwner, 10 ether);
        vm.startPrank(agentOwner);
        p.mine{value: 1 ether}(agentId); // bb holds 0.3
        uint256 m = p.mine{value: 1 ether}(agentId);
        t.transfer(address(router), m);
        vm.stopPrank();
        vm.prank(owner);
        uint256 burned = bb.buybackAndBurn(0, 0.2 ether * 97 / 100);
        assertEq(burned, 0.2 ether); // 0.1 BNB x rate 2
        assertEq(address(bb).balance, 0.5 ether);
    }

    function test_burnerOnlyKeeper() public {
        vm.prank(human);
        vm.expectRevert(BuybackBurner.NotKeeper.selector);
        burner.buybackAndBurn(0, 0);
    }

    // ------------------------------------------------------------ staking

    function test_stakeCooldown() public {
        vm.deal(agentOwner, 1 ether);
        vm.startPrank(agentOwner);
        uint256 m = poi.mine{value: 0.02 ether}(agentId);
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
        assertGe(revenue * 100, liability * 110, "deploy params insolvent at best tier");
    }
}
