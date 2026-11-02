// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SuanToken} from "../src/SuanToken.sol";
import {ProofOfInference} from "../src/ProofOfInference.sol";
import {BuybackBurner} from "../src/BuybackBurner.sol";
import {SuanStake} from "../src/SuanStake.sol";
import {MockAgentIdRegistry} from "../src/mocks/MockAgentIdRegistry.sol";
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
    address agent = makeAddr("agent"); // holds nemo.ai
    address agent2 = makeAddr("agent2"); // holds second.ai
    address human = makeAddr("human"); // no Agent ID
    address wbnb = makeAddr("wbnb");

    SuanToken token;
    MockAggregator feed;
    MockAgentIdRegistry ids;
    MockRouter router;
    BuybackBurner burner;
    ProofOfInference poi;
    SuanStake stakeC;

    function setUp() public {
        _deploy(DECAY, PRICE, 8, 0);
    }

    function _cfg(address t, address f, address b, address o, uint256 decay, uint256 cap)
        internal
        view
        returns (ProofOfInference.Config memory)
    {
        return ProofOfInference.Config({
            token: t,
            priceFeed: f,
            maxPriceAge: MAX_AGE,
            agentIds: address(ids),
            opsTreasury: o,
            burner: b,
            burnBps: BURN_BPS,
            initialTokensPerUsd: RATE,
            decayBps: decay,
            minPaymentUsd: MIN,
            redeemBps: REDEEM_BPS,
            maxPerAgentPerEpoch: cap,
            owner: owner
        });
    }

    function _deploy(uint256 decay, int256 price, uint8 dec, uint256 cap) internal {
        feed = new MockAggregator(price, dec);
        ids = new MockAgentIdRegistry();
        router = new MockRouter(wbnb);
        // minter fixed at construction: token (n), burner (n+1), poi (n+2)
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);
        token = new SuanToken("Yansuan", "YAN", predicted);
        burner = new BuybackBurner(address(token), address(router), 100 ether, owner);
        poi = new ProofOfInference(_cfg(address(token), address(feed), address(burner), ops, decay, cap));
        assertEq(address(poi), predicted, "minter prediction");
        stakeC = new SuanStake(address(token));
        ids.setHandle(agent, "nemo");
        ids.setHandle(agent2, "second");
    }

    function _wei(uint256 usd18) internal view returns (uint256) {
        return usd18 * 1e18 / poi.bnbUsd();
    }

    // ------------------------------------------------------------ Agent ID gating

    function test_nonAgentCannotMine() public {
        vm.deal(human, 10 ether);
        vm.expectRevert(abi.encodeWithSelector(ProofOfInference.NotAnAgent.selector, human));
        vm.prank(human);
        poi.mine{value: 0.02 ether}();
    }

    function test_nonAgentCannotMineBySending() public {
        vm.deal(human, 10 ether);
        vm.prank(human);
        (bool ok,) = address(poi).call{value: 0.02 ether}("");
        assertFalse(ok);
        assertEq(human.balance, 10 ether, "BNB stays with sender");
    }

    function test_agentMines() public {
        vm.deal(agent, 1 ether);
        vm.expectEmit(true, false, false, true, address(poi));
        emit ProofOfInference.Mined(agent, "nemo", 10e18, 100_000e18, 0, 0.02 ether);
        vm.prank(agent);
        uint256 m = poi.mine{value: 0.02 ether}(); // $10
        assertEq(m, 100_000e18);
        assertEq(token.balanceOf(agent), m);
        assertEq(poi.minedBy(agent), m);
        assertEq(poi.creditsUsd(agent), 10e18);
        assertEq(poi.totalWeiPaid(), 0.02 ether);
        assertEq(poi.agentCount(), 1);
        assertTrue(poi.isAgent(agent));
        assertFalse(poi.isAgent(human));
        assertEq(poi.handleOf(agent), "nemo");
    }

    function test_agentMinesBySendingBnb() public {
        vm.deal(agent, 1 ether);
        vm.prank(agent);
        (bool ok,) = address(poi).call{value: 0.02 ether}("");
        assertTrue(ok);
        assertEq(token.balanceOf(agent), 100_000e18);
        assertEq(poi.creditsUsd(agent), 10e18);
    }

    function test_onlyMinterCanMint() public {
        vm.expectRevert(SuanToken.NotMinter.selector);
        token.mint(human, 1);
        assertEq(token.minter(), address(poi));
    }

    function test_belowMinimum() public {
        vm.deal(agent, 1 ether);
        vm.prank(agent);
        vm.expectRevert(ProofOfInference.BelowMinimum.selector);
        poi.mine{value: 0.001 ether}(); // $0.50
    }

    function test_pause() public {
        vm.deal(agent, 1 ether);
        vm.prank(owner);
        poi.pause();
        vm.prank(agent);
        vm.expectRevert();
        poi.mine{value: 0.02 ether}();
        vm.prank(agent);
        (bool ok,) = address(poi).call{value: 0.02 ether}("");
        assertFalse(ok);
        vm.prank(owner);
        poi.unpause();
        vm.prank(agent);
        poi.mine{value: 0.02 ether}();
    }

    // ------------------------------------------------------------ per-agent epoch cap

    function test_agentEpochCap() public {
        _deploy(DECAY, PRICE, 8, 1_000_000e18); // 1M per agent per epoch = $100 at 10k/USD
        vm.deal(agent, 10 ether);
        vm.deal(agent2, 10 ether);
        assertEq(poi.remainingThisEpoch(agent), 1_000_000e18);
        vm.prank(agent);
        poi.mine{value: 0.1 ether}(); // $50 -> 500k
        assertEq(poi.remainingThisEpoch(agent), 500_000e18);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(ProofOfInference.AgentEpochCap.selector, 500_000e18));
        poi.mine{value: 0.2 ether}(); // $100 -> 1M would exceed
        vm.prank(agent);
        poi.mine{value: 0.1 ether}(); // exactly fills
        assertEq(poi.remainingThisEpoch(agent), 0);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(ProofOfInference.AgentEpochCap.selector, 0));
        poi.mine{value: 0.002 ether}();
        // another agent is unaffected
        vm.prank(agent2);
        poi.mine{value: 0.1 ether}();
        assertEq(token.balanceOf(agent2), 500_000e18);
    }

    function test_capResetsNextEpoch() public {
        _deploy(DECAY, PRICE, 8, 1_000_000e18);
        // push the protocol into epoch 1 using many agents (100M tokens = 100 agents x 1M)
        for (uint256 i; i < 100; i++) {
            address a = address(uint160(0x1000 + i));
            ids.setHandle(a, string(abi.encodePacked("a", vm.toString(i))));
            vm.deal(a, 1 ether);
            vm.prank(a);
            poi.mine{value: 0.2 ether}(); // $100 -> 1M each
        }
        assertEq(poi.currentEpoch(), 1);
        address first = address(uint160(0x1000));
        assertEq(poi.remainingThisEpoch(first), 1_000_000e18, "fresh allowance in the new epoch");
        vm.prank(first);
        poi.mine{value: 0.2 ether}(); // $100 at 5k/USD -> 500k
        assertEq(poi.remainingThisEpoch(first), 500_000e18);
    }

    // ------------------------------------------------------------ price feed

    function test_stalePriceReverts() public {
        vm.deal(agent, 1 ether);
        vm.warp(vm.getBlockTimestamp() + MAX_AGE + 1);
        vm.prank(agent);
        vm.expectRevert(ProofOfInference.StalePrice.selector);
        poi.mine{value: 0.02 ether}();
    }

    function test_badPriceReverts() public {
        vm.deal(agent, 1 ether);
        feed.set(0);
        vm.prank(agent);
        vm.expectRevert(ProofOfInference.BadPrice.selector);
        poi.mine{value: 0.02 ether}();
        feed.set(-1);
        vm.prank(agent);
        vm.expectRevert(ProofOfInference.BadPrice.selector);
        poi.mine{value: 0.02 ether}();
    }

    function test_priceMovesUsdValue() public {
        vm.deal(agent, 1 ether);
        feed.set(1000e8);
        vm.prank(agent);
        assertEq(poi.mine{value: 0.02 ether}(), 200_000e18);
        assertEq(poi.creditsUsd(agent), 20e18);
    }

    function test_feedDecimalsScaled() public {
        _deploy(DECAY, 500e18, 18, 0);
        vm.deal(agent, 1 ether);
        vm.prank(agent);
        assertEq(poi.mine{value: 0.02 ether}(), 100_000e18);
    }

    // ------------------------------------------------------------ split

    function test_splitBurnAndOps() public {
        vm.deal(agent, 10 ether);
        vm.prank(agent);
        poi.mine{value: 1 ether}();
        assertEq(address(burner).balance, 0.3 ether);
        assertEq(ops.balance, 0.7 ether);
        assertEq(address(poi).balance, 0);
        assertEq(poi.totalUsdPaid(), 500e18);
    }

    function test_revertingTreasuryBlocksMine() public {
        RevertingReceiver bad = new RevertingReceiver();
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);
        SuanToken t = new SuanToken("Y", "Y", predicted);
        BuybackBurner bb = new BuybackBurner(address(t), address(router), 1 ether, owner);
        ProofOfInference p = new ProofOfInference(_cfg(address(t), address(feed), address(bb), address(bad), DECAY, 0));
        vm.deal(agent, 1 ether);
        vm.prank(agent);
        vm.expectRevert(ProofOfInference.TransferFailed.selector);
        p.mine{value: 0.02 ether}();
    }

    // ------------------------------------------------------------ emission

    function test_quoteMatchesMine() public {
        vm.deal(agent, 1_000 ether);
        uint256 q = poi.quote(24.69 ether);
        vm.prank(agent);
        assertEq(poi.mine{value: 24.69 ether}(), q);
    }

    function test_halvingBoundary() public {
        vm.deal(agent, 1_000 ether);
        uint256 w = _wei(10_001e18);
        vm.prank(agent);
        uint256 minted = poi.mine{value: w}();
        assertEq(minted, 100_000_000e18 + 5_000e18);
        assertEq(poi.currentEpoch(), 1);
        assertEq(poi.tokensPerUsd(), RATE / 2);
    }

    function test_capReached() public {
        vm.deal(agent, 100_000 ether);
        uint256 w = _wei(10_230_000e18);
        vm.prank(agent);
        uint256 minted = poi.mine{value: w}();
        assertEq(minted, token.CAP());
        assertEq(poi.tokensPerUsd(), 0);
        vm.prank(agent);
        vm.expectRevert(ProofOfInference.CapReached.selector);
        poi.mine{value: 1 ether}();
    }

    function test_decay70() public {
        _deploy(7000, PRICE, 8, 0);
        assertEq(poi.rateAt(1), 7_000e18);
        assertEq(poi.rateAt(9), 40_353_607e18 / 100_000);
        assertEq(poi.rateAt(10), 0);
        uint256 w = poi.costToCapWei();
        vm.deal(agent, w);
        vm.prank(agent);
        assertEq(poi.mine{value: w}(), token.CAP());
        assertEq(poi.costToCap(), 0);
    }

    function test_badParamsRejected() public {
        ProofOfInference.Config memory c = _cfg(address(token), address(feed), address(burner), ops, DECAY, 0);
        c.initialTokensPerUsd = 0;
        vm.expectRevert(ProofOfInference.BadRate.selector);
        new ProofOfInference(c);
        c = _cfg(address(token), address(feed), address(burner), ops, DECAY, 0);
        c.maxPriceAge = 0;
        vm.expectRevert(ProofOfInference.BadRate.selector);
        new ProofOfInference(c);
        c = _cfg(address(token), address(feed), address(burner), ops, 10_000, 0);
        vm.expectRevert(ProofOfInference.BadBps.selector);
        new ProofOfInference(c);
        c = _cfg(address(token), address(feed), address(burner), ops, DECAY, 0);
        c.burnBps = 10_000;
        vm.expectRevert(ProofOfInference.BadBps.selector);
        new ProofOfInference(c);
        c = _cfg(address(token), address(feed), address(burner), ops, DECAY, 0);
        c.agentIds = address(0);
        vm.expectRevert(ProofOfInference.ZeroAddress.selector);
        new ProofOfInference(c);
    }

    function testFuzz_neverExceedsCap(uint256 a, uint256 b, uint256 c) public {
        a = bound(a, 0.002 ether, 10_000 ether);
        b = bound(b, 0.002 ether, 10_000 ether);
        c = bound(c, 0.002 ether, 10_000 ether);
        vm.deal(agent, 30_000 ether);
        vm.startPrank(agent);
        poi.mine{value: a}();
        poi.mine{value: b}();
        poi.mine{value: c}();
        vm.stopPrank();
        assertLe(token.totalSupply(), token.CAP());
        assertEq(poi.totalMinted(), token.totalSupply());
        assertEq(address(poi).balance, 0);
    }

    function testFuzz_monotoneRate(uint256 a) public {
        a = bound(a, 0.002 ether, 40 ether);
        vm.deal(agent, 100 ether);
        uint256 r0 = poi.tokensPerUsd();
        vm.prank(agent);
        poi.mine{value: a}();
        assertLe(poi.tokensPerUsd(), r0);
    }

    // ------------------------------------------------------------ redeem utility

    function test_redeemBurnsAndCredits() public {
        vm.deal(agent, 1 ether);
        vm.startPrank(agent);
        uint256 minted = poi.mine{value: 0.02 ether}();
        token.approve(address(poi), minted);
        uint256 credit = poi.redeem(minted);
        vm.stopPrank();
        assertEq(credit, 5e18);
        assertEq(poi.creditsUsd(agent), 15e18);
        assertEq(token.totalSupply(), 0);
        assertEq(poi.totalRedeemed(), minted);
    }

    function test_anyHolderCanRedeem() public {
        vm.deal(agent, 1 ether);
        vm.prank(agent);
        uint256 minted = poi.mine{value: 0.02 ether}();
        vm.prank(agent);
        token.transfer(human, minted);
        vm.startPrank(human);
        token.approve(address(poi), minted);
        assertEq(poi.redeem(minted), 5e18);
        vm.stopPrank();
        assertEq(poi.creditsUsd(human), 5e18);
    }

    function test_redeemConstantAcrossEpochs() public {
        vm.deal(agent, 1_000 ether);
        vm.startPrank(agent);
        poi.mine{value: 0.02 ether}();
        uint256 before = poi.quoteRedeem(100_000e18);
        uint256 w = _wei(10_000e18);
        poi.mine{value: w}();
        uint256 later = poi.quoteRedeem(100_000e18);
        vm.stopPrank();
        assertEq(later, before);
    }

    function testFuzz_redeemLiabilityBounded(uint256 a) public {
        a = bound(a, 0.002 ether, 2_000 ether);
        vm.deal(agent, 3_000 ether);
        vm.startPrank(agent);
        uint256 minted = poi.mine{value: a}();
        uint256 paidUsd = poi.totalUsdPaid();
        token.approve(address(poi), minted);
        uint256 credit = poi.redeem(minted);
        vm.stopPrank();
        assertLe(credit, paidUsd * REDEEM_BPS / 10_000);
    }

    function test_redeemWorksWhilePaused() public {
        vm.deal(agent, 1 ether);
        vm.prank(agent);
        uint256 m = poi.mine{value: 0.02 ether}();
        vm.prank(owner);
        poi.pause();
        vm.startPrank(agent);
        token.approve(address(poi), m);
        assertGt(poi.redeem(m), 0);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ burner

    function test_buybackAndBurn() public {
        vm.deal(agent, 10 ether);
        vm.prank(agent);
        poi.mine{value: 1 ether}();
        vm.prank(agent);
        uint256 m = poi.mine{value: 1 ether}();
        vm.prank(agent);
        token.transfer(address(router), m);
        uint256 supplyBefore = token.totalSupply();
        uint256 bal = address(burner).balance;
        vm.prank(owner);
        vm.expectRevert(BuybackBurner.SlippageTooLoose.selector);
        burner.buybackAndBurn(0, 1);
        vm.prank(owner);
        uint256 burned = burner.buybackAndBurn(0, bal * 2 * 97 / 100);
        assertEq(burned, bal * 2);
        assertEq(token.totalSupply(), supplyBefore - burned);
        assertEq(address(burner).balance, 0);
    }

    function test_burnerOnlyKeeper() public {
        vm.prank(human);
        vm.expectRevert(BuybackBurner.NotKeeper.selector);
        burner.buybackAndBurn(0, 0);
    }

    // ------------------------------------------------------------ staking

    function test_stakeCooldown() public {
        vm.deal(agent, 1 ether);
        vm.startPrank(agent);
        uint256 m = poi.mine{value: 0.02 ether}();
        token.approve(address(stakeC), m);
        stakeC.stake(m);
        assertEq(stakeC.staked(agent), m);
        stakeC.requestUnstake(m);
        assertEq(stakeC.staked(agent), 0);
        vm.expectRevert(SuanStake.Locked.selector);
        stakeC.withdraw();
        vm.warp(vm.getBlockTimestamp() + 7 days);
        stakeC.withdraw();
        vm.stopPrank();
        assertEq(token.balanceOf(agent), m);
    }

    // ---------------------------------------------------------------- solvency of the DEPLOY parameters
    uint256 constant DEPLOY_BURN_BPS = 2000;
    uint256 constant DEPLOY_REDEEM_BPS = 1000;
    uint256 constant GATEWAY_MARKUP_BPS = 7500;
    uint256 constant GATEWAY_MAX_DISCOUNT_BPS = 2500;

    function test_deployParamsSolvent() public pure {
        uint256 effMarkup = GATEWAY_MARKUP_BPS * (10_000 - GATEWAY_MAX_DISCOUNT_BPS) / 10_000;
        uint256 revenue = (10_000 - DEPLOY_BURN_BPS) * (10_000 + effMarkup);
        uint256 liability = (10_000 + DEPLOY_REDEEM_BPS) * 10_000;
        assertGe(revenue * 100, liability * 110, "deploy params insolvent at best tier");
    }
}
