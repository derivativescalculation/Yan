# 衍算 Yansuan · Proof of Inference

**A BNB Chain token that only Binance .ai agents can mint.** A wallet holding a Binance .ai Agent ID pays BNB; the payment mints $YAN at the current epoch rate and books the same value as inference credit. There is no presale, no team allocation, and no mint path for a wallet without an Agent ID.

- **Chain:** BNB Smart Chain (mainnet 56, testnet 97)
- **Identity:** Binance .ai Agent ID, the SPACE ID "Agent ID" registry (`0x60B9…022F`). Soulbound, one per Binance user, claimed free in the Binance app.
- **Payment:** native BNB, valued in USD by the Chainlink BNB/USD feed. Call `mine()` or just send BNB to the minter. No approval.
- **Fair distribution:** each Agent ID can mint at most 1,000,000 YAN per epoch.
- **Supply:** 1,000,000,000 YAN hard cap, 10 epochs of 100M, mint rate steps down 30% per epoch.
- **Utility:** redeem for inference credit, stake for gateway tier, protocol buyback-and-burn.

---

## How it works

```
   Binance app                     BNB (mine() or plain send)                    EIP-712 login
  ┌──────────────┐  ──────────────────────────────────────▶ ┌──────────────────┐ ◀──────────── ┌───────────┐
  │ .ai Agent ID │                                          │ ProofOfInference │               │  Gateway  │
  │ Agentic      │  ◀────────────────────────────────────── │  (sole minter)   │ ───credit───▶ │ (metered  │
  │ Wallet       │              mints YAN                   └────────┬─────────┘    reads      │ inference)│
  └──────────────┘                                             80%   │   20%                    └───────────┘
                                                                     ▼
                                                 ┌──────────────┐   ┌────────────────┐
                                                 │ ops treasury │   │ BuybackBurner  │──▶ PancakeSwap ──▶ burn
                                                 │ (AI compute) │   │ (no other exit)│
                                                 └──────────────┘   └────────────────┘
```

1. **Identity.** The user claims a free .ai Agent ID in the Binance app (Wallet → Web3 wallet → Agent ID). It is bound to their Binance Agentic Wallet, driven by their own AI (Claude, ChatGPT, …) through Binance's official skill. The minter checks `handleOf(msg.sender)` on the Agent ID registry.
2. **Mine.** The agent calls `mine()` with BNB, or sends BNB to the minter. The contract values it with Chainlink (reverting on a stale or bad price), enforces the $1 minimum and the per-Agent-ID epoch cap, splits the BNB 80/20 in the same transaction, mints YAN to the agent wallet and books the USD value as credit. The `Mined` event carries the .ai name.
3. **Infer.** The wallet signs one EIP-712 login message (the only kind Agentic Wallets sign) and gets a 7-day bearer token. The gateway meters model usage against the on-chain credit at list price plus markup.
4. **Redeem / stake / burn.** Any holder can burn YAN for credit at a fixed fraction of the genesis mint value (never pausable) or stake it for a better gateway tier. The protocol buys back and burns YAN from the 20% share.

The mine page at yansuan.io builds the exact prompt for a Binance agent: pick an amount, optionally enter your .ai name to see your remaining allowance, paste.

## Economics

| Parameter | Default | Where |
|---|---|---|
| Initial mint rate | 40,000 YAN / USD | `INITIAL_TOKENS_PER_USD` |
| Epoch size | 100,000,000 YAN | constant |
| Rate decay per epoch | ×0.70 | `DECAY_BPS = 7000` |
| Cap per Agent ID per epoch | 1,000,000 YAN | `MAX_PER_AGENT_PER_EPOCH` |
| Minimum payment | $1 | `MIN_PAYMENT_USD` |
| Cost to mint the full supply | ≈ 200,674 USD | `costToCap()` |
| Burn share of each payment | 20% | `BURN_BPS = 2000` |
| Redeem value | 10% of genesis mint value | `REDEEM_BPS = 1000` |
| Gateway markup over list price | 75% | `MARKUP_BPS = 7500` |
| Tier discount (on the markup only) | 铜 0 · 银 8% · 金 15% · 玄 25% | `pricing.ts` |

| Epoch | YAN / USD | Cost of epoch (USD) | Max per Agent ID (USD) |
|---|---|---|---|
| 0 | 40,000 | 2,500 | 25 |
| 1 | 28,000 | 3,571 | 36 |
| 2 | 19,600 | 5,102 | 51 |
| 3 | 13,720 | 7,289 | 73 |
| 4 | 9,604 | 10,412 | 104 |
| 5 | 6,722 | 14,874 | 149 |
| 6 | 4,705 | 21,249 | 213 |
| 7 | 3,294 | 30,356 | 304 |
| 8 | 2,305 | 43,366 | 434 |
| 9 | 1,614 | 61,952 | 620 |

Every epoch needs at least 100 different Agent IDs to fill.

**Solvency.** In the worst case every agent spends all of its credit at the best tier discount and redeems every token. The treasury share must still cover the raw model bill:

```
(1 − burn) · (1 + markup · (1 − maxDiscount)) ≥ (1 + redeem) · (1 + margin)
(1 − 0.20) · (1 + 0.75 · 0.75) = 1.25  ≥  1.10 · 1.10 = 1.21   ✓
```

Asserted by `test_deployParamsSolvent` in Foundry and by `assertSolvent()` when the gateway starts.

## Repository

```
contracts/   Foundry · SuanToken, ProofOfInference, BuybackBurner, SuanStake, deploy scripts, 31 tests
gateway/     Bun + Hono · metered inference, EIP-712 login, quote and agent endpoints, SKILL.md for agents
web/         Vite + React + wagmi · protocol, mine (agent prompt builder), agents, treasury, docs (zh / en)
```

### Contracts

| Contract | Role |
|---|---|
| `SuanToken` | BEP-20, 1B cap, ERC20Permit. Minter is immutable and set at construction from a precomputed address. No owner, no admin functions. |
| `ProofOfInference` | The only mint path. `mine()` and `receive()` (both payable, Agent ID required), `redeem`, `quote` (wei), `quoteUsd`, `quoteRedeem`, `remainingThisEpoch`, `isAgent`, `handleOf`, `bnbUsd`, `rateAt`, `costToCap`, `costToCapWei`. Owner can only pause minting. |
| `BuybackBurner` | Receives the 20% share in BNB. Keeper swaps WBNB→YAN on PancakeSwap V2 and burns the output. `minOut` must be within 3% of the router quote; per-call cap. BNB has no other exit. |
| `SuanStake` | Per-wallet staking with a 7-day unstake cooldown. Read by the gateway to assign tiers. |

### Gateway

- **Login:** `GET /v1/login/challenge?wallet=…` returns EIP-712 typed data and a ready `eth_signTypedData_v4` request for `baw sign-message`. `POST /v1/login` verifies it and returns an HMAC session token valid 7 days. Requests send `Authorization: Bearer <token>`.
- **Metering:** each request reserves its worst-case cost in the ledger before the model runs, inside a per-wallet lock, with at most 4 requests in flight. Settlement replaces the reservation with actual usage; upstream failure releases it.
- **Ledger:** Postgres (`DATABASE_URL`) is mandatory outside the local chain; rows are scoped by chain id.
- **Surface:** `GET /v1/quote?bnb=…&agent=…` (tokens, USD, allowance, `canMine` and the reason if not), `GET /v1/agents/<wallet or name.ai>`, `GET /v1/leaderboard`, `GET /v1/stats`, `POST /v1/messages` (Anthropic Messages shape, custom tools only), `GET /skill.md`.

## Quick start

[Foundry](https://getfoundry.sh) and [Bun](https://bun.sh).

```sh
# 1. local chain + contracts (mock price feed at $700, mock Agent ID registry, mock router;
#    gives the deployer the handle "genesis")
anvil
cd contracts
PRIVATE_KEY=<anvil key 0> forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --skip-simulation

# 2. gateway
cd ../gateway && bun install
cp .env.example .env.local      # CHAIN_ID=31337, addresses from contracts/deployments/31337.json, ANTHROPIC_API_KEY
bun --env-file=.env.local src/server.ts

# 3. web
cd ../web && bun install
printf 'VITE_CHAIN_ID=31337\nVITE_GATEWAY_URL=http://localhost:8787\nVITE_RPC_URL=http://127.0.0.1:8545\n' > .env.anvil
bun run dev:anvil
```

### Tests

```sh
cd contracts && forge test -vvv
cd gateway && bun x tsc --noEmit
cd web && bun x tsc --noEmit && bun x vite build

# browser end-to-end on the local chain: read-only site; a .ai agent mines by sending BNB; a wallet
# without an Agent ID is rejected; leaderboard, agent page and treasury reflect it
cd web && SITE=http://127.0.0.1:5174 bun run e2e

# live-site audit (read-only): every route in zh/en at desktop and phone width
cd web && SITE=https://yansuan.io node e2e/audit.mjs
```

## Deployment

```sh
cd contracts
cp .env.example .env    # PRIVATE_KEY, AGENT_ID_REGISTRY, PRICE_FEED, MAX_PRICE_AGE, ROUTER, OPS_TREASURY
forge script script/Deploy.s.sol --rpc-url bsc --broadcast --skip-simulation --verify
```

The script precomputes the minter address, deploys token → burner → minter → stake, and aborts before broadcasting anything if the prediction does not match. On mainnet it requires the real Agent ID registry and a treasury that is not the deployer. On testnet, leaving `AGENT_ID_REGISTRY` empty deploys a mock registry and gives `TEST_AGENT` the handle `TEST_HANDLE`. Addresses are written to `contracts/deployments/<chainId>.json`.

## Deployments

| | BNB Chain mainnet (56) | BSC testnet (97) |
|---|---|---|
| YAN token | `MAINNET_TOKEN` | `0x87dB35408C15E0360431948BD579F38FFefDe680` |
| ProofOfInference | `MAINNET_POI` | `0x73Dcf1e3ef87A67B8AD398eDca34a3b08B506e3F` |
| BuybackBurner | `MAINNET_BURNER` | `0xA27a7E6CD43F12E650d7b7Dde236D16FC8E0ef70` |
| SuanStake | `MAINNET_STAKE` | `0x55CeDe0fa71c161fFe7D9ccdbbfA8Eb156a76C21` |
| Agent ID registry | `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F` (SPACE ID) | `0xa347BF02Df5Ce25fCDaBCE9aBaB7129c0397aF97` (mock) |
| Chainlink BNB/USD | `0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE` | `0x2514895c72f50D8bd4B4F9b1110F0D6bD2c97526` |
| Ops treasury | `0x16F7e765DC66D5589bc60e8005949921E066A65E` | deployer |
| Deploy block | `MAINNET_BLOCK` | 140390811 |

All contracts are verified on BscScan. Any other token named Yansuan or YAN is not the protocol token.

Superseded mainnet deployments (pre-launch iterations, not the protocol token):

| Token | Minter | Note |
|---|---|---|
| `0xa19cB6ef09E3a5fDc36230afd25e1044078100Fd` | `0x073648Dd60402E39C332B49d76728EAE2820d2d8` | USD1-settled, ERC-8004 gated; paused |
| `0x460461dBa2643b62514ad199F0746ec080752e56` | `0xbED42bc64FF8B69075626402b6fa6B3b3202C52c` | BNB, ERC-8004 gated; has a PancakeSwap pool `0xa66cf207e0eA2436F01e20214BCB04464F2092b3`; paused |
| `0x7AE827a0a4254D1dA84129a624EA1D61F5D79353` | `0xBA4930D6152A30b5e371720C6000CC7f218486d3` | "Yansuan Test" (YANT), integration test; paused |
| `0x87dB35408C15E0360431948BD579F38FFefDe680` | `0x73Dcf1e3ef87A67B8AD398eDca34a3b08B506e3F` | BNB, ERC-8004 gated (mainnet) |

## Security model

- Token: no owner, immutable minter, cap enforced on `totalSupply`.
- Minter: immutable parameters, registry, feed and destinations; owner can only pause minting; `redeem` can never be paused; `nonReentrant` on every path that moves BNB or tokens; state is written before BNB is sent; a treasury that rejects BNB makes the mint revert rather than strand funds; a wallet without an Agent ID keeps its BNB because the whole transaction reverts.
- Identity: Agent IDs are soulbound and issued only through the Binance app (registrar signature), one per user, which makes the per-Agent-ID cap a real distribution limit.
- Burner: BNB can only leave through a swap whose entire output is burned; slippage floor and per-call cap are enforced on-chain.
- Price: Chainlink BNB/USD with a staleness bound (the mainnet feed updates about every 30 seconds). A stale or non-positive answer reverts; nothing mints at a bad price.
- Gateway: no API keys; one EIP-712 login per 7 days; reservations before execution; persistent ledger; server-side tools refused; bounded caches and IP limits.

## License

MIT
