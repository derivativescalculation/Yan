# 衍算 Yansuan · 天选

**A BNB Chain token that only Binance .ai agents can mint, with three raffle pots that pay holders.** A wallet holding a Binance .ai Agent ID pays BNB and mints $YAN at the current epoch rate. Every mint is split 70% to the agent, 25% to a liquidity vault and 5% to the 天选 raffle. There is no presale, no team allocation and no mint path for a wallet without an Agent ID.

- **Chain:** BNB Smart Chain (mainnet 56, testnet 97)
- **Identity:** Binance .ai Agent ID, the SPACE ID "Agent ID" registry (`0x60B9…022F`). Soulbound, one per Binance user, claimed free in the Binance app.
- **Payment:** native BNB, valued in USD by the Chainlink BNB/USD feed. Call `mine()` or just send BNB to the minter. No approval. All BNB goes to the project treasury.
- **Fair distribution:** each Agent ID can mint at most 1,000,000 YAN per epoch (700,000 to the agent).
- **Supply:** 1,000,000,000 YAN hard cap, 10 epochs of 100M, mint rate steps down 30% per epoch.
- **Liquidity:** 25% of every mint is locked in a vault that can only add PancakeSwap liquidity; the LP is burned.
- **Raffle:** 5% of every mint and a fixed 0.5% tax on sells fill three pots. One ticket per 10,000 YAN held; Chainlink VRF picks the winner; prizes are sent automatically.

---

## How it works

```
   Binance app                BNB (mine() or plain send)
  ┌──────────────┐  ─────────────────────────────────────▶ ┌────────────┐ ── 100% BNB ──▶ treasury
  │ .ai Agent ID │                                         │ YanMinter  │
  │ Agentic      │  ◀──────────── 70% YAN ──────────────── │ (only mint │ ── 25% YAN ───▶ LiquidityVault ──▶ PancakeSwap LP (burned)
  │ Wallet       │                                         │   path)    │
  └──────────────┘                                         └────────────┘ ── 5% YAN ────▶ TianxuanRaffle
                                                                                              ▲
                        every sale into the YAN/WBNB pool ── 0.5% in YAN ─────────────────────┘
```

1. **Identity.** The user claims a free .ai Agent ID in the Binance app (Wallet → Web3 wallet → Agent ID). It is bound to their Binance Agentic Wallet, which their own AI drives through Binance's official skill. The minter checks `handleOf(msg.sender)` on the Agent ID registry.
2. **Mint.** The agent calls `mine()` with BNB, or sends BNB to the minter. The contract values it with Chainlink (reverting on a stale or bad price), enforces the $1 minimum and the per-Agent-ID epoch cap, mints 70% to the agent, 25% to the vault and 5% to the raffle, and forwards all the BNB to the treasury in the same transaction. The `Mined` event carries the .ai name.
3. **Liquidity.** The vault's YAN can only become PancakeSwap liquidity. The team supplies the BNB side and adds liquidity after round 7 (700M minted); the LP tokens go to the dead address.
4. **Raffle.** See below.

The mine page at yansuan.io builds the exact prompt for a Binance agent: pick an amount, optionally enter your .ai name to see your remaining allowance, paste.

## Economics

| Parameter | Value | Where |
|---|---|---|
| Initial mint rate | 40,000 YAN / USD (28,000 to the agent) | `INITIAL_TOKENS_PER_USD` |
| Epoch size | 100,000,000 YAN | constant |
| Rate decay per epoch | ×0.70 | `DECAY_BPS = 7000` |
| Cap per Agent ID per epoch | 1,000,000 YAN (700,000 to the agent) | `MAX_PER_AGENT_PER_EPOCH` |
| Minimum payment | $1 | `MIN_PAYMENT_USD` |
| Split of every mint | 70% agent · 25% liquidity vault · 5% raffle | constants |
| BNB | 100% to the treasury | `TREASURY` |
| Sell tax | 0.5% of every sale into the YAN/WBNB pair, in YAN, to the raffle | `SELL_TAX_BPS = 50` |
| Cost to mint the full supply | ≈ 200,674 USD | `costToCap()` |

| Round (epoch) | YAN / USD | To the agent / USD | Cost of the round (USD) | Max per Agent ID (USD) |
|---|---|---|---|---|
| 1 (0) | 40,000 | 28,000 | 2,500 | 25 |
| 2 (1) | 28,000 | 19,600 | 3,571 | 36 |
| 3 (2) | 19,600 | 13,720 | 5,102 | 51 |
| 4 (3) | 13,720 | 9,604 | 7,289 | 73 |
| 5 (4) | 9,604 | 6,723 | 10,412 | 104 |
| 6 (5) | 6,723 | 4,706 | 14,874 | 149 |
| 7 (6) | 4,706 | 3,294 | 21,249 | 213 |
| 8 (7) | 3,294 | 2,306 | 30,356 | 304 |
| 9 (8) | 2,306 | 1,614 | 43,366 | 434 |
| 10 (9) | 1,614 | 1,130 | 61,952 | 620 |

Every round needs at least 100 different Agent IDs to fill. Liquidity goes on-chain after round 7.

## 天选 raffle

| Pot | Share of inflows | Opens at | Draws during the mint |
|---|---|---|---|
| 青罐 jade jar | 40% | 20,000 YAN | 1,000 |
| 朱瓶 cinnabar vase | 20% | 100,000 YAN | 100 |
| 金鼎 gold cauldron | 40% | 1,000,000 YAN | 20 |

- **Inflows.** 5% of every mint (50,000 YAN per 1M minted) and the 0.5% sell tax. `sync()` splits each inflow 40/20/40; the minter calls it on every mint and the keeper calls it for the tax. After the mint ends, the sell tax keeps the pots filling.
- **Tickets.** One ticket per 10,000 YAN of a wallet's lowest balance in the hour before the draw's snapshot. Nothing to sign up for. Liquidity pools, protocol contracts, the treasury and the deployer are left out.
- **Snapshot.** When a pot fills, the contract records that block as the next draw's snapshot. The keeper cannot choose it.
- **Commit.** The keeper builds the ticket list for the snapshot (addresses in ascending order, consecutive ticket ranges), commits its Merkle root and the ticket total, and the contract requests a Chainlink VRF v2.5 random word (paid in BNB). The prize is reserved at the same time.
- **Settle.** The winning ticket is `random % totalTickets`. Anyone can call `settle` with the holder's range and Merkle proof; the prize is transferred to the holder in the same transaction.
- **Verify.** The gateway publishes every draw's full list at `/v1/raffle/draws/<id>`. Rebuild it from public `Transfer` events and compare the root with the `DrawCommitted` event. Leaf: `keccak256(keccak256(abi.encode(account, start, count)))`, sorted-pair hashing, a node without a sibling is carried up unchanged.
- **Nobody can withdraw the pots.** YAN leaves only as prizes. The owner can change only the keeper and the VRF subscription settings; the coordinator is immutable.

## Repository

```
contracts/   Foundry · SuanToken, YanMinter, LiquidityVault, TianxuanRaffle, deploy script, unit and mainnet-fork tests
gateway/     Bun + Hono · indexer, ticket lists, raffle keeper, quote / agent / raffle endpoints, SKILL.md for agents
web/         Vite + React · protocol, mine (agent prompt builder), 天选 raffle (three.js), agents, treasury, docs (zh / en)
```

### Contracts

| Contract | Role |
|---|---|
| `SuanToken` | BEP-20, 1B cap, ERC20Permit. Minter, raffle, vault and the CREATE2-derived YAN/WBNB pair are immutable. Fixed 0.5% sell tax to the raffle; the vault is exempt. No owner, no admin functions. |
| `YanMinter` | The only mint path. `mine()` and `receive()` (Agent ID required), `quote` (total and the agent's share), `quoteUsd`, `remainingThisEpoch`, `isAgent`, `handleOf`, `bnbUsd`, `rateAt`, `costToCap`. Owner can only pause minting. |
| `LiquidityVault` | Holds the 25% share. Owner-only `addLiquidity` pairs vault YAN with the BNB sent, adds it on PancakeSwap V2 and sends the LP to the dead address. No other way out. |
| `TianxuanRaffle` | Three pots, on-chain snapshots, keeper commits, Chainlink VRF v2.5, permissionless settlement with Merkle proofs. |

### Gateway

- **Indexer:** follows the token, minter and raffle from the deploy block, a few blocks behind the head, keeping every holder's balance history. Nothing is committed before the scan has caught up.
- **Keeper:** one action per tick: settle a draw that has its random word, commit a full pot, re-request a random word after a day, sync the sell tax. Every action is re-checked against chain state first, and a rebuilt list must match the committed root before settling.
- **Surface:** `GET /v1/quote?bnb=…&agent=…`, `GET /v1/agents/<wallet or name.ai>`, `GET /v1/leaderboard`, `GET /v1/stats`, `GET /v1/raffle`, `GET /v1/raffle/feed`, `GET /v1/raffle/tickets/<wallet or name.ai>`, `GET /v1/raffle/draws/<id>`, `GET /v1/raffle/draws/<id>/winner`, `GET /skill.md`.

## Quick start

[Foundry](https://getfoundry.sh) and [Bun](https://bun.sh). The local chain forks BNB Chain mainnet, so PancakeSwap, Chainlink and the Agent ID registry are real; only VRF is mocked.

```sh
# 1. local chain (fork of mainnet; needs an RPC that serves historical state)
anvil --fork-url <bsc archive rpc> --chain-id 31337 --block-time 1

# 2. contracts
cd contracts
PRIVATE_KEY=… TREASURY=… KEEPER=… AGENT_ID_REGISTRY=0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F \
PRICE_FEED=0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE MAX_PRICE_AGE=86400 \
ROUTER=0x10ED43C718714eb63d5aA57B78B54704E256024E FACTORY=0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73 \
PAIR_INIT_CODE_HASH=0x00fb7f630766e6a796048ea87d01acd3068e8ff67d078148a3fa3f4a84f69bd5 WBNB=0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c \
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --skip-simulation

# 3. gateway (addresses from contracts/deployments/31337.json; on 31337 the keeper also answers the mock VRF)
cd ../gateway && bun install
CHAIN_ID=31337 RPC_URL=http://127.0.0.1:8545 MINTER_ADDRESS=… TOKEN_ADDRESS=… RAFFLE_ADDRESS=… VAULT_ADDRESS=… \
AGENT_ID_REGISTRY_ADDRESS=0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F TREASURY_ADDRESS=… DEPLOYER_ADDRESS=… \
DEPLOY_BLOCK=… KEEPER_PRIVATE_KEY=… bun src/server.ts

# 4. web
cd ../web && bun install
printf 'VITE_CHAIN_ID=31337\nVITE_GATEWAY_URL=http://localhost:8787\nVITE_RPC_URL=http://127.0.0.1:8545\n' > .env.anvil
bun run dev:anvil
```

### Tests

```sh
cd contracts && forge test                            # unit tests and the mainnet-fork tests
cd gateway && bun x tsc --noEmit
cd web && bun run build

# live-site audit (read-only): every route in zh/en at desktop and phone width
cd web && SITE=https://yansuan.io node e2e/audit.mjs
```

## Deployment

```sh
cd contracts
# 1. VRF subscription (owner = deployer), funded in BNB
cast send <coordinator> "createSubscription()" …          # subId from the SubscriptionCreated event
cast send <coordinator> "fundSubscriptionWithNative(uint256)" <subId> --value 0.1ether …
# 2. contracts
PRIVATE_KEY=… TREASURY=… KEEPER=… VRF_COORDINATOR=… VRF_SUB_ID=… VRF_KEY_HASH=… PRICE_FEED=… ROUTER=… FACTORY=… \
PAIR_INIT_CODE_HASH=… WBNB=… AGENT_ID_REGISTRY=… forge script script/Deploy.s.sol --rpc-url bsc --broadcast --skip-simulation --verify
# 3. register the raffle as the subscription's consumer
cast send <coordinator> "addConsumer(uint256,address)" <subId> <raffle> …
```

The script precomputes every address, deploys token → vault → raffle → minter, and aborts if a prediction does not match. On mainnet it requires the real Agent ID registry, a treasury and keeper that are not the deployer, and a VRF subscription. Off mainnet, leaving `AGENT_ID_REGISTRY` empty deploys a mock registry and gives `TEST_AGENT` the handle `TEST_HANDLE`. Addresses are written to `contracts/deployments/<chainId>.json`.

## Deployments

| | BNB Chain mainnet (56) | BSC testnet (97) |
|---|---|---|
| YAN token | `0x058Da1ddA7452469192838885e3547738E968257` | `0xF6512aDCbCa88F631B9a9393CDdf419B0eAE5DF2` |
| YanMinter | `0xf8E07D59F61e87ec96388b6fa0ae1c72b726d29a` | `0x058Da1ddA7452469192838885e3547738E968257` |
| LiquidityVault | `0xbe68fdf8e4e1c3f299B53E58f2da5A3c414E06af` | `0x5286A197266FB3F84B4D3cCE4A2c0A383c8472E7` |
| TianxuanRaffle | `0xe6B952cff12360a71d5621276Bb8DBfe1F1339b1` | `0x7E6b66749b3bD558C2Ec4b3bC652AE96980b1353` |
| YAN/WBNB pair | `0xB363043A743738d3720536503Aff39A1C3DeF4D9` | `0xEd839e8905BA5B70B826088Dd54e90e6C3D10F86` |
| Agent ID registry | `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F` (SPACE ID) | `0xFB8fD15f2b71c1029f93d44a6f9870D248885d6F` (mock) |
| Chainlink BNB/USD | `0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE` | `0x2514895c72f50D8bd4B4F9b1110F0D6bD2c97526` |
| Chainlink VRF v2.5 | `0xd691f04bc0C9a24Edb78af9E005Cf85768F694C9` | `0xDA3b641D438362C440Ac5458c57e00a712b66700` |
| Treasury | `0x16F7e765DC66D5589bc60e8005949921E066A65E` | `0x16F7e765DC66D5589bc60e8005949921E066A65E` |
| Deploy block | 131287519 | 140425979 |

All mainnet contracts are verified on BscScan. **The mainnet YAN token is `0x058Da1ddA7452469192838885e3547738E968257`.** Any other token named Yansuan or YAN is not the protocol token.

Superseded mainnet deployments (pre-launch iterations, all paused, not the protocol token):

| Token | Minter | Note |
|---|---|---|
| `0xa19cB6ef09E3a5fDc36230afd25e1044078100Fd` | `0x073648Dd60402E39C332B49d76728EAE2820d2d8` | USD1-settled, ERC-8004 gated |
| `0x460461dBa2643b62514ad199F0746ec080752e56` | `0xbED42bc64FF8B69075626402b6fa6B3b3202C52c` | BNB, ERC-8004 gated; has a PancakeSwap pool `0xa66cf207e0eA2436F01e20214BCB04464F2092b3` |
| `0x7AE827a0a4254D1dA84129a624EA1D61F5D79353` | `0xBA4930D6152A30b5e371720C6000CC7f218486d3` | "Yansuan Test" (YANT), integration test |
| `0x87dB35408C15E0360431948BD579F38FFefDe680` | `0x73Dcf1e3ef87A67B8AD398eDca34a3b08B506e3F` | BNB, ERC-8004 gated |
| `0xB77E581DD0CC0413686Ef2C4a31B98D1627D02D2` | `0x49c9B706369102309A26C0B72F215f2B3D09Db5b` | BNB, .ai Agent ID gated, inference credit; zero supply |

## Security model

- Token: no owner; minter, raffle, vault and pair immutable; cap enforced on `totalSupply`; the tax rate is a constant.
- Minter: immutable parameters, registry, feed and destinations; owner can only pause minting; `nonReentrant`; state is written before BNB is sent; a treasury that rejects BNB makes the mint revert rather than strand funds; a wallet without an Agent ID keeps its BNB because the whole transaction reverts.
- Identity: Agent IDs are soulbound and issued only through the Binance app (registrar signature), one per user, which makes the per-Agent-ID cap a real distribution limit.
- Vault: YAN can only leave as PancakeSwap liquidity whose LP is burned; only the router may send it BNB (refunds).
- Raffle: the snapshot is recorded on-chain when a pot fills; the list is committed before the random word exists; the coordinator is immutable and only it can deliver the word; settlement is permissionless and checked against the committed root; pots cannot be withdrawn.
- Price: Chainlink BNB/USD with a staleness bound. A stale or non-positive answer reverts; nothing mints at a bad price.

## License

MIT
