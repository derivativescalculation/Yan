// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SuanToken} from "../src/SuanToken.sol";
import {YanMinter} from "../src/YanMinter.sol";
import {LiquidityVault} from "../src/LiquidityVault.sol";
import {TianxuanRaffle} from "../src/TianxuanRaffle.sol";
import {MockAgentIdRegistry} from "../src/mocks/MockAgentIdRegistry.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";
import {MockVRFCoordinator} from "../src/mocks/MockVRFCoordinator.sol";
import {MockLiquidityRouter} from "../src/mocks/MockLiquidityRouter.sol";

contract RevertingReceiver {
    receive() external payable {
        revert("no");
    }
}

/// @dev Same construction as the gateway: sorted-pair hashing, an odd node is carried up unchanged.
library Merkle {
    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function leaf(address account, uint256 start, uint256 count) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account, start, count))));
    }

    function root(bytes32[] memory leaves) internal pure returns (bytes32) {
        bytes32[] memory nodes = _copy(leaves);
        uint256 n = nodes.length;
        while (n > 1) {
            uint256 m = (n + 1) / 2;
            for (uint256 i; i < m; i++) {
                nodes[i] = 2 * i + 1 < n ? hashPair(nodes[2 * i], nodes[2 * i + 1]) : nodes[2 * i];
            }
            n = m;
        }
        return nodes[0];
    }

    function proof(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory out) {
        bytes32[] memory nodes = _copy(leaves);
        bytes32[] memory tmp = new bytes32[](64);
        uint256 k;
        uint256 n = nodes.length;
        while (n > 1) {
            uint256 sib = index ^ 1;
            if (sib < n) tmp[k++] = nodes[sib];
            uint256 m = (n + 1) / 2;
            for (uint256 i; i < m; i++) {
                nodes[i] = 2 * i + 1 < n ? hashPair(nodes[2 * i], nodes[2 * i + 1]) : nodes[2 * i];
            }
            index /= 2;
            n = m;
        }
        out = new bytes32[](k);
        for (uint256 i; i < k; i++) out[i] = tmp[i];
    }

    function _copy(bytes32[] memory a) private pure returns (bytes32[] memory b) {
        b = new bytes32[](a.length);
        for (uint256 i; i < a.length; i++) b[i] = a[i];
    }
}

contract YanTest is Test {
    uint256 constant RATE = 40_000e18; // tokens per USD in epoch 0, before the split
    uint256 constant DECAY = 7000;
    uint256 constant MIN = 1e18;
    uint256 constant AGENT_CAP = 1_000_000e18;
    int256 constant PRICE = 500e8; // $500 per BNB
    uint256 constant MAX_AGE = 3600;
    bytes32 constant INIT_HASH = keccak256("pair init code");
    bytes32 constant KEY_HASH = keccak256("lane");
    uint256 constant SUB_ID = 777;

    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address keeper = makeAddr("keeper");
    address agent = makeAddr("agent"); // nemo.ai
    address agent2 = makeAddr("agent2"); // second.ai
    address human = makeAddr("human");
    address factory = makeAddr("factory");
    address wbnb = makeAddr("wbnb");

    MockAggregator feed;
    MockAgentIdRegistry ids;
    MockVRFCoordinator vrf;
    MockLiquidityRouter router;
    SuanToken token;
    LiquidityVault vault;
    TianxuanRaffle raffle;
    YanMinter minter;

    function setUp() public {
        feed = new MockAggregator(PRICE, 8);
        ids = new MockAgentIdRegistry();
        ids.setHandle(agent, "nemo");
        ids.setHandle(agent2, "second");
        vrf = new MockVRFCoordinator();
        router = new MockLiquidityRouter();
        _deploy(AGENT_CAP, treasury);
        vm.deal(agent, 10_000 ether);
        vm.deal(agent2, 10_000 ether);
        vm.deal(human, 10 ether);
    }

    function _deploy(uint256 agentCap, address treasury_) internal {
        uint256 n = vm.getNonce(address(this));
        address vaultAt = vm.computeCreateAddress(address(this), n + 1);
        address raffleAt = vm.computeCreateAddress(address(this), n + 2);
        address minterAt = vm.computeCreateAddress(address(this), n + 3);
        token = new SuanToken(
            SuanToken.Config({
                name: "Yansuan",
                symbol: "YAN",
                minter: minterAt,
                raffle: raffleAt,
                liquidityVault: vaultAt,
                factory: factory,
                pairInitCodeHash: INIT_HASH,
                wbnb: wbnb
            })
        );
        vault = new LiquidityVault(address(token), address(router), owner);
        raffle = new TianxuanRaffle(address(token), address(vrf), SUB_ID, KEY_HASH, keeper, owner);
        minter = new YanMinter(
            YanMinter.Config({
                token: address(token),
                priceFeed: address(feed),
                maxPriceAge: MAX_AGE,
                agentIds: address(ids),
                treasury: treasury_,
                liquidityVault: address(vault),
                raffle: address(raffle),
                initialTokensPerUsd: RATE,
                decayBps: DECAY,
                minPaymentUsd: MIN,
                maxPerAgentPerEpoch: agentCap,
                owner: owner
            })
        );
        assertEq(address(vault), vaultAt);
        assertEq(address(raffle), raffleAt);
        assertEq(address(minter), minterAt);
    }

    function _wei(uint256 usd18) internal pure returns (uint256) {
        return usd18 * 1e18 / 500e18;
    }

    function _mine(address who, uint256 usd18) internal returns (uint256) {
        uint256 w = _wei(usd18);
        vm.prank(who);
        return minter.mine{value: w}();
    }

    function _pot(uint256 i) internal view returns (uint256 balance, uint256 threshold, uint64 fullAtBlock, uint32 opened, uint64 activeDraw) {
        (balance, threshold,, fullAtBlock, opened, activeDraw) = raffle.pots(i);
    }

    // ================================================================ token

    function test_token_immutables() public view {
        assertEq(token.name(), "Yansuan");
        assertEq(token.symbol(), "YAN");
        assertEq(token.CAP(), 1_000_000_000e18);
        assertEq(token.SELL_TAX_BPS(), 50);
        assertEq(token.minter(), address(minter));
        assertEq(token.raffle(), address(raffle));
        assertEq(token.liquidityVault(), address(vault));
        (address t0, address t1) = address(token) < wbnb ? (address(token), wbnb) : (wbnb, address(token));
        address want = address(uint160(uint256(keccak256(abi.encodePacked(hex"ff", factory, keccak256(abi.encodePacked(t0, t1)), INIT_HASH)))));
        assertEq(token.pair(), want);
    }

    function test_token_onlyMinter() public {
        vm.expectRevert(SuanToken.NotMinter.selector);
        token.mint(human, 1);
    }

    function test_token_cap() public {
        SuanToken t = new SuanToken(
            SuanToken.Config("C", "C", address(this), address(1), address(2), factory, INIT_HASH, wbnb)
        );
        t.mint(human, 1_000_000_000e18);
        vm.expectRevert(SuanToken.CapExceeded.selector);
        t.mint(human, 1);
    }

    function test_sellTax_transfer() public {
        _mine(agent, 5e18); // agent receives 140,000
        address pair = token.pair();
        uint256 r0 = token.balanceOf(address(raffle));
        vm.prank(agent);
        token.transfer(pair, 100_000e18);
        assertEq(token.balanceOf(pair), 99_500e18);
        assertEq(token.balanceOf(address(raffle)) - r0, 500e18);
        assertEq(token.balanceOf(agent), 40_000e18);
    }

    function test_sellTax_transferFrom() public {
        _mine(agent, 5e18);
        address pair = token.pair();
        address spender = makeAddr("router");
        vm.prank(agent);
        token.approve(spender, 20_000e18);
        uint256 r0 = token.balanceOf(address(raffle));
        vm.prank(spender);
        token.transferFrom(agent, pair, 20_000e18);
        assertEq(token.balanceOf(pair), 19_900e18);
        assertEq(token.balanceOf(address(raffle)) - r0, 100e18);
    }

    function test_noTax_buy_wallet_vault_tiny() public {
        _mine(agent, 5e18);
        address pair = token.pair();
        vm.prank(agent);
        token.transfer(pair, 10_000e18); // pair holds 9,950
        uint256 r0 = token.balanceOf(address(raffle));
        vm.prank(pair); // a buy: tokens leave the pair
        token.transfer(human, 9_950e18);
        assertEq(token.balanceOf(human), 9_950e18);
        vm.prank(human); // wallet to wallet
        token.transfer(agent2, 1_000e18);
        assertEq(token.balanceOf(agent2), 1_000e18);
        vm.prank(address(vault)); // the vault adding liquidity
        token.transfer(pair, 1_000e18);
        assertEq(token.balanceOf(pair), 1_000e18);
        vm.prank(human); // too small to carry a tax
        token.transfer(pair, 199);
        assertEq(token.balanceOf(pair), 1_000e18 + 199);
        assertEq(token.balanceOf(address(raffle)), r0);
    }

    // ================================================================ minter

    function test_mine_split_treasury_pots() public {
        uint256 t0 = treasury.balance;
        uint256 got = _mine(agent, 5e18); // $5 -> 200,000 total
        assertEq(got, 140_000e18);
        assertEq(token.balanceOf(agent), 140_000e18);
        assertEq(token.balanceOf(address(vault)), 50_000e18);
        assertEq(token.balanceOf(address(raffle)), 10_000e18);
        assertEq(treasury.balance - t0, _wei(5e18));
        assertEq(address(minter).balance, 0);
        assertEq(minter.totalMinted(), 200_000e18);
        assertEq(minter.minedBy(agent), 140_000e18);
        assertEq(minter.minedInEpoch(agent, 0), 200_000e18);
        assertEq(minter.agentCount(), 1);
        (uint256 a,,,,) = _pot(0);
        (uint256 b,,,,) = _pot(1);
        (uint256 c,,,,) = _pot(2);
        assertEq(a, 4_000e18);
        assertEq(b, 2_000e18);
        assertEq(c, 4_000e18);
        assertEq(raffle.accounted(), 10_000e18);
    }

    function test_mine_bySend() public {
        vm.prank(agent);
        (bool ok,) = address(minter).call{value: _wei(2e18)}("");
        assertTrue(ok);
        assertEq(token.balanceOf(agent), 56_000e18);
    }

    function test_mine_rejectsNonAgent() public {
        vm.prank(human);
        vm.expectRevert(abi.encodeWithSelector(YanMinter.NotAnAgent.selector, human));
        minter.mine{value: 0.01 ether}();
        vm.prank(human);
        (bool ok,) = address(minter).call{value: 0.01 ether}("");
        assertFalse(ok);
    }

    function test_mine_minimum_price_pause() public {
        vm.prank(agent);
        vm.expectRevert(YanMinter.BelowMinimum.selector);
        minter.mine{value: _wei(0.99e18)}();

        vm.warp(block.timestamp + MAX_AGE + 1);
        vm.prank(agent);
        vm.expectRevert(YanMinter.StalePrice.selector);
        minter.mine{value: 0.01 ether}();

        feed.set(0);
        vm.prank(agent);
        vm.expectRevert(YanMinter.BadPrice.selector);
        minter.mine{value: 0.01 ether}();

        feed.set(PRICE);
        vm.prank(owner);
        minter.pause();
        vm.prank(agent);
        vm.expectRevert();
        minter.mine{value: 0.01 ether}();
        vm.prank(human);
        vm.expectRevert();
        minter.unpause();
        vm.prank(owner);
        minter.unpause();
        _mine(agent, 1e18);
    }

    function test_mine_treasuryRevert() public {
        _deploy(AGENT_CAP, address(new RevertingReceiver()));
        vm.prank(agent);
        vm.expectRevert(YanMinter.TransferFailed.selector);
        minter.mine{value: 0.01 ether}();
    }

    function test_quote_matches() public {
        (uint256 total, uint256 toAgent) = minter.quote(_wei(7e18));
        assertEq(total, 280_000e18);
        assertEq(toAgent, 196_000e18);
        assertEq(_mine(agent, 7e18), toAgent);
    }

    function test_agentEpochCap_andReset() public {
        _mine(agent, 25e18); // exactly 1M total
        assertEq(minter.remainingThisEpoch(agent), 0);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(YanMinter.AgentEpochCap.selector, 0));
        minter.mine{value: _wei(1e18)}();
        // 99 more agents fill epoch 0
        for (uint256 i; i < 99; i++) {
            address a = address(uint160(0x1000 + i));
            ids.setHandle(a, string.concat("a", vm.toString(i)));
            vm.deal(a, 1 ether);
            _mine(a, 25e18);
        }
        assertEq(minter.currentEpoch(), 1);
        assertEq(minter.remainingThisEpoch(agent), AGENT_CAP);
        // epoch 1 rate is x0.7
        assertEq(_mine(agent, 1e18), 28_000e18 * 7000 / 10_000);
    }

    function test_emission_crossesEpoch_andCap() public {
        _deploy(0, treasury); // uncapped per agent
        _mine(agent, 2_499e18); // 99,960,000
        (uint256 total,) = minter.quoteUsd(2e18);
        // $1 finishes epoch 0 (40,000), $1 at 28,000
        assertEq(total, 40_000e18 + 28_000e18);
        uint256 cost = minter.costToCap();
        vm.deal(agent, cost * 1e18 / 500e18 + 1 ether);
        vm.prank(agent);
        minter.mine{value: cost * 1e18 / 500e18 + 1}();
        assertEq(minter.totalMinted(), 1_000_000_000e18);
        assertEq(token.totalSupply(), 1_000_000_000e18);
        vm.prank(agent);
        vm.expectRevert(YanMinter.CapReached.selector);
        minter.mine{value: 0.01 ether}();
    }

    function testFuzz_split_sums(uint96 usd) public {
        uint256 u = bound(uint256(usd), MIN, 25e18);
        uint256 s0 = token.totalSupply();
        uint256 got = _mine(agent, u);
        uint256 minted = token.totalSupply() - s0;
        assertEq(got, minted * 7000 / 10_000);
        assertEq(token.balanceOf(address(vault)), minted * 2500 / 10_000);
        assertEq(token.balanceOf(address(raffle)), minted - got - minted * 2500 / 10_000);
        assertEq(raffle.accounted(), token.balanceOf(address(raffle)));
    }

    // ================================================================ vault

    function test_vault_addLiquidity() public {
        _mine(agent, 25e18); // vault gets 250,000
        uint256 amt = vault.balance();
        assertEq(amt, 250_000e18);
        vm.deal(owner, 1 ether);
        vm.prank(human);
        vm.expectRevert();
        vault.addLiquidity{value: 0.1 ether}(amt, 0, 0, block.timestamp);
        uint256 o0 = owner.balance;
        vm.prank(owner);
        (uint256 tok, uint256 bnb,) = vault.addLiquidity{value: 0.1 ether}(amt, amt, 0.08 ether, block.timestamp);
        assertEq(tok, amt);
        assertEq(bnb, 0.08 ether);
        assertEq(router.lastTo(), vault.LP_BURN());
        assertEq(o0 - owner.balance, 0.08 ether); // 0.02 refunded
        assertEq(token.balanceOf(address(router)), amt);
        assertEq(token.allowance(address(vault), address(router)), 0);
        assertEq(vault.totalTokenAdded(), amt);
        assertEq(vault.totalBnbAdded(), 0.08 ether);
        assertEq(address(vault).balance, 0);
    }

    function test_vault_rejectsStrayBnb_andZero() public {
        vm.prank(human);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertFalse(ok);
        vm.deal(owner, 1 ether);
        vm.prank(owner);
        vm.expectRevert(LiquidityVault.ZeroAmount.selector);
        vault.addLiquidity{value: 0}(1, 0, 0, block.timestamp);
    }

    // ================================================================ raffle

    function _holders() internal pure returns (address[3] memory a, uint256[3] memory start, uint256[3] memory count) {
        a = [address(0xA11CE), address(0xB0B), address(0xCA401)];
        start = [uint256(0), 5, 8];
        count = [uint256(5), 3, 2];
    }

    function _leaves() internal pure returns (bytes32[] memory l) {
        (address[3] memory a, uint256[3] memory s, uint256[3] memory c) = _holders();
        l = new bytes32[](3);
        for (uint256 i; i < 3; i++) l[i] = Merkle.leaf(a[i], s[i], c[i]);
    }

    function _fillJade() internal returns (uint64 snap) {
        _mine(agent, 25e18); // raffle +50,000: jade 20,000, cinnabar 10,000, gold 20,000
        (,, snap,,) = _pot(0);
        assertEq(snap, block.number);
    }

    function test_sync_split_dust() public {
        _mine(agent, 5e18);
        vm.prank(agent);
        token.transfer(address(raffle), 7); // arbitrary inflow
        raffle.sync();
        (uint256 a,,,,) = _pot(0);
        (uint256 b,,,,) = _pot(1);
        (uint256 c,,,,) = _pot(2);
        assertEq(a, 4_000e18 + 2);
        assertEq(b, 2_000e18 + 1);
        assertEq(c, 4_000e18 + 4);
        assertEq(a + b + c, token.balanceOf(address(raffle)));
        assertEq(raffle.pending(), 0);
    }

    function test_sellTax_reachesPots() public {
        _mine(agent, 5e18);
        address pair = token.pair();
        vm.prank(agent);
        token.transfer(pair, 100_000e18);
        assertEq(raffle.pending(), 500e18);
        raffle.sync();
        (uint256 c,,,,) = _pot(2);
        assertEq(c, 4_000e18 + 200e18);
    }

    function test_commit_guards() public {
        vm.prank(keeper);
        vm.expectRevert(TianxuanRaffle.NotFull.selector);
        raffle.commit(0, 1, bytes32(uint256(1)), 10);
        uint64 snap = _fillJade();
        bytes32 r = Merkle.root(_leaves());
        vm.expectRevert(TianxuanRaffle.NotKeeper.selector);
        raffle.commit(0, snap, r, 10);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(TianxuanRaffle.WrongSnapshot.selector, snap));
        raffle.commit(0, snap - 1, r, 10);
        vm.prank(keeper);
        vm.expectRevert(TianxuanRaffle.BadRoot.selector);
        raffle.commit(0, snap, bytes32(0), 10);
        vm.prank(keeper);
        vm.expectRevert(TianxuanRaffle.BadPot.selector);
        raffle.commit(3, snap, r, 10);
        vm.prank(keeper);
        raffle.commit(0, snap, r, 10);
        vm.prank(keeper);
        vm.expectRevert(TianxuanRaffle.DrawActive.selector);
        raffle.commit(0, snap, r, 10);
    }

    function test_commit_requestsVrf() public {
        uint64 snap = _fillJade();
        vm.prank(keeper);
        uint256 id = raffle.commit(0, snap, Merkle.root(_leaves()), 10);
        (address consumer, bytes32 kh, uint256 sub, uint16 conf, uint32 gasLimit, uint32 words, bytes memory extra) =
            vrf.requests(vrf.lastRequestId());
        assertEq(consumer, address(raffle));
        assertEq(kh, KEY_HASH);
        assertEq(sub, SUB_ID);
        assertEq(conf, 3);
        assertEq(gasLimit, 100_000);
        assertEq(words, 1);
        assertEq(extra, abi.encodeWithSelector(bytes4(keccak256("VRF ExtraArgsV1")), true));
        assertEq(raffle.drawOfRequest(vrf.lastRequestId()), id);
        (uint256 bal,,, , uint64 active) = _pot(0);
        assertEq(bal, 0); // prize reserved
        assertEq(active, id);
    }

    function test_fullDraw_paysWinner() public {
        uint64 snap = _fillJade();
        bytes32[] memory leaves = _leaves();
        vm.prank(keeper);
        uint256 id = raffle.commit(0, snap, Merkle.root(leaves), 10);
        uint256 req = vrf.lastRequestId();

        vm.expectRevert();
        raffle.rawFulfillRandomWords(req, new uint256[](1)); // not the coordinator
        vrf.fulfill(req, 1_000_007); // ticket 7 -> 0xB0B (5..7)

        (address[3] memory a, uint256[3] memory s, uint256[3] memory c) = _holders();
        bytes32[] memory pA = Merkle.proof(leaves, 0);
        vm.expectRevert(TianxuanRaffle.NotWinningTicket.selector);
        raffle.settle(id, a[0], s[0], c[0], pA);
        bytes32[] memory pB = Merkle.proof(leaves, 1);
        vm.expectRevert(TianxuanRaffle.BadProof.selector);
        raffle.settle(id, a[1], s[1], c[1] + 1, pB);
        vm.expectRevert(TianxuanRaffle.BadProof.selector);
        raffle.settle(id, human, s[1], c[1], pB);

        vm.prank(human); // anyone can settle
        raffle.settle(id, a[1], s[1], c[1], pB);
        assertEq(token.balanceOf(a[1]), 20_000e18);
        (,,, uint32 opened, uint64 active) = _pot(0);
        assertEq(opened, 1);
        assertEq(active, 0);
        assertEq(raffle.paidOut(), 20_000e18);
        assertEq(raffle.accounted(), token.balanceOf(address(raffle)));
        vm.expectRevert(TianxuanRaffle.NotReady.selector);
        raffle.settle(id, a[1], s[1], c[1], pB);
        (, TianxuanRaffle.Status st,,,,,,,, address w) = raffle.draws(id);
        assertEq(uint256(st), uint256(TianxuanRaffle.Status.Settled));
        assertEq(w, a[1]);
    }

    function test_draw_lastTicket_andSingleHolder() public {
        uint64 snap = _fillJade();
        bytes32[] memory one = new bytes32[](1);
        one[0] = Merkle.leaf(agent2, 0, 4);
        vm.prank(keeper);
        uint256 id = raffle.commit(0, snap, Merkle.root(one), 4);
        vrf.fulfill(vrf.lastRequestId(), 3); // last ticket
        raffle.settle(id, agent2, 0, 4, new bytes32[](0));
        assertEq(token.balanceOf(agent2), 20_000e18);
    }

    function test_void_restartsSnapshot() public {
        uint64 snap = _fillJade();
        vm.roll(block.number + 10);
        vm.prank(keeper);
        uint256 id = raffle.commit(0, snap, bytes32(0), 0);
        (, TianxuanRaffle.Status st,,,,,,,,) = raffle.draws(id);
        assertEq(uint256(st), uint256(TianxuanRaffle.Status.Void));
        (uint256 bal,, uint64 full,, uint64 active) = _pot(0);
        assertEq(bal, 20_000e18);
        assertEq(full, block.number);
        assertEq(active, 0);
    }

    function test_retry_andStaleFulfill() public {
        uint64 snap = _fillJade();
        vm.prank(keeper);
        uint256 id = raffle.commit(0, snap, Merkle.root(_leaves()), 10);
        uint256 first = vrf.lastRequestId();
        vm.prank(keeper);
        vm.expectRevert(TianxuanRaffle.TooEarly.selector);
        raffle.retry(id);
        vm.warp(block.timestamp + 1 days);
        vm.prank(human);
        vm.expectRevert(TianxuanRaffle.NotKeeper.selector);
        raffle.retry(id);
        vm.prank(keeper);
        raffle.retry(id);
        uint256 second = vrf.lastRequestId();
        assertTrue(second != first);
        vrf.fulfill(first, 7); // superseded: ignored
        (, TianxuanRaffle.Status st,,,,,,,,) = raffle.draws(id);
        assertEq(uint256(st), uint256(TianxuanRaffle.Status.Committed));
        vrf.fulfill(second, 7);
        (, st,,,,,,,,) = raffle.draws(id);
        assertEq(uint256(st), uint256(TianxuanRaffle.Status.Random));
    }

    function test_refullAfterSettle_andConcurrentPots() public {
        _mine(agent, 25e18);
        _mine(agent2, 25e18); // raffle +100,000: jade 40,000, cinnabar 20,000, gold 40,000
        (,, uint64 snap,,) = _pot(0);
        bytes32[] memory leaves = _leaves();
        vm.prank(keeper);
        uint256 id = raffle.commit(0, snap, Merkle.root(leaves), 10);
        vrf.fulfill(vrf.lastRequestId(), 9);
        (address[3] memory a, uint256[3] memory s, uint256[3] memory c) = _holders();
        raffle.settle(id, a[2], s[2], c[2], Merkle.proof(leaves, 2));
        (uint256 bal,, uint64 full,,) = _pot(0);
        assertEq(bal, 20_000e18);
        assertEq(full, block.number); // full again: next snapshot starts now
        (uint256 cin,, uint64 cinFull,,) = _pot(1);
        assertEq(cin, 20_000e18);
        assertEq(cinFull, 0);
        assertEq(raffle.accounted(), token.balanceOf(address(raffle)));
    }

    function test_admin() public {
        vm.expectRevert();
        raffle.setKeeper(human);
        vm.expectRevert();
        raffle.setVrf(1, bytes32(0), 1, 1);
        vm.prank(owner);
        raffle.setKeeper(human);
        assertEq(raffle.keeper(), human);
        vm.prank(owner);
        raffle.setVrf(9, KEY_HASH, 120_000, 5);
        assertEq(raffle.subscriptionId(), 9);
        assertEq(raffle.callbackGasLimit(), 120_000);
        assertEq(raffle.requestConfirmations(), 5);
    }
}
