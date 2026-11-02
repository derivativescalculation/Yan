# 衍算 Yansuan · Proof of Inference

**A BNB Chain token that only AI agents can mint.** An agent with an ERC-8004 identity pays stablecoin for inference credit; the payment mints $YAN at the current epoch rate. There is no presale, no team allocation and no mint path that does not go through a registered agent paying for compute.

- **Chain:** BNB Smart Chain (mainnet 56, testnet 97)
- **Identity:** ERC-8004 Identity Registry (`0x8004A169…a432` mainnet, `0x8004A818…BD9e` testnet)
- **Settlement:** USD1 (18 decimals) on mainnet, mock stablecoin on testnet
- **Supply:** 1,000,000,000 YAN hard cap, 10 epochs of 100M, mint rate steps down 30% per epoch
- **Utility:** redeem for inference credit, stake for gateway tier, protocol buyback-and-burn

---

## How it works

```
                 approve + mine(agentId, usd)                     signed request
  ┌──────────┐ ───────────────────────────────▶ ┌──────────────────┐ ◀──────────── ┌───────────┐
  │ ERC-8004 │                                  │ ProofOfInference │               │  Gateway  │
  │  agent   │ ◀─────────────────────────────── │   (sole minter)  │ ───credit───▶ │ (metered  │
  └──────────┘          mints YAN               └───────┬──────────┘   reads       │ inference)│
                                                   80%  │  20%                      └───────────┘
                                                        ▼
                                      ┌──────────────┐   ┌───────────────┐
                                      │ ops treasury │   │ BuybackBurner │──▶ PancakeSwap ──▶ burn
                                      │ (model bills)│   │ (no other exit)│
                                      └──────────────┘   └───────────────┘
```

1. **Identity.** The agent registers once in the ERC-8004 Identity Registry and receives an `agentId`. The minter accepts calls only from that identity's owner or its registered agent wallet.
2. **Mine.** `mine(agentId, amount)` pulls stablecoin, splits it 80% to the ops treasury and 20% to the burner, mints YAN to the caller at the current epoch rate and books `amount` as inference credit on the `agentId`.
3. **Infer.** The agent calls the gateway with a wallet signature. The gateway meters model usage against the on-chain credit and settles each request at list price plus markup.
4. **Redeem / stake / burn.** YAN can be burned for inference credit at a fixed fraction of the genesis mint value (never pausable), staked per `agentId` for a better gateway tier, and is bought back and burned by the protocol from the 20% share.

## Economics

| Parameter | Default | Where |
|---|---|---|
| Initial mint rate | 40,000 YAN / USD | `INITIAL_TOKENS_PER_USD` |
| Epoch size | 100,000,000 YAN | constant |
| Rate decay per epoch | ×0.70 | `DECAY_BPS = 7000` |
| Cost to mint the full supply | ≈ 200,674 USD | `costToCap()` |
| Burn share of each payment | 20% | `BURN_BPS = 2000` |
| Redeem value | 10% of genesis mint value | `REDEEM_BPS = 1000` |
| Gateway markup over list price | 75% | `MARKUP_BPS = 7500` |
| Tier discount (on the markup only) | 铜 0 · 银 8% · 金 15% · 玄 25% | `pricing.ts` |

| Epoch | YAN / USD | Cost of epoch (USD) |
|---|---|---|
| 0 | 40,000 | 2,500 |
| 1 | 28,000 | 3,571 |
| 2 | 19,600 | 5,102 |
| 3 | 13,720 | 7,289 |
| 4 | 9,604 | 10,412 |
| 5 | 6,722 | 14,874 |
| 6 | 4,705 | 21,249 |
| 7 | 3,294 | 30,356 |
| 8 | 2,305 | 43,366 |
| 9 | 1,614 | 61,952 |

**Solvency.** In the worst case every agent spends all of its credit at the best tier discount and redeems every token. The treasury share must still cover the raw model bill:

```
(1 − burn) · (1 + markup · (1 − maxDiscount)) ≥ (1 + redeem) · (1 + margin)
(1 − 0.20) · (1 + 0.75 · 0.75) = 1.25  ≥  1.10 · 1.10 = 1.21   ✓
```

This inequality is asserted by `test_deployParamsSolvent` in Foundry and by `assertSolvent()` when the gateway starts. The redemption liability is bounded because the redeem rate is pinned to the genesis rate and every token was minted by a payment.

## Repository

```
contracts/   Foundry · SuanToken, ProofOfInference, BuybackBurner, SuanStake, deploy scripts, 24 tests
gateway/     Bun + Hono · metered inference proxy, wallet-signature auth, MCP server, genesis agent
web/         Vite + React + wagmi · protocol, mine, agents, treasury, integration docs (zh / en)
```

### Contracts

| Contract | Role |
|---|---|
| `SuanToken` | BEP-20, 1B cap, ERC20Permit. Minter is immutable and set at construction from a precomputed address. No owner, no admin functions. |
| `ProofOfInference` | The only mint path. `mine`, `redeem`, `quote`, `quoteRedeem`, `rateAt`, `costToCap`. Epoch walk rounds in the protocol's favour. Owner can only pause `mine`. |
| `BuybackBurner` | Receives the 20% share. Keeper swaps stable→YAN on PancakeSwap V2 (direct or via WBNB) and burns the output. `minOut` must be within 3% of the router quote; per-call cap. Stablecoin has no other exit. |
| `SuanStake` | Per-`agentId` staking with a 7-day unstake cooldown. Read by the gateway to assign tiers. |

### Gateway

- **Auth:** `x-agent-id`, `x-agent-address`, `x-agent-ts`, `x-agent-nonce`, `x-agent-sig` where the signature is `personal_sign("yansuan:<chainId>:<agentId>:<ts>:<nonce>:<sha256(body)>")`. Bound to chain, agent, time and body; accepted once. The signer must be the agent's owner or agent wallet, checked on-chain.
- **Metering:** each request reserves its worst-case cost (full `max_tokens` at the charged rate) in the ledger before the model runs, inside a per-agent lock, with at most 4 requests in flight. Settlement replaces the reservation with actual usage; upstream failure releases it.
- **Ledger:** Postgres (`DATABASE_URL`) is mandatory outside the local chain. SQLite is for local development only.
- **Surface:** `POST /v1/messages` (Anthropic Messages shape, custom tools only, `stream:true` required above 8,000 output tokens), `GET /v1/stats`, `GET /v1/leaderboard`, `GET /v1/agents/:id`, `GET /skill.md`, `GET /agent.json` (ERC-8004 registration file).
- **MCP:** `src/mcp.ts` exposes `yansuan_status`, `yansuan_quote`, `yansuan_mine`, `yansuan_infer`, `yansuan_balance`, `yansuan_stake`, `yansuan_redeem`, `yansuan_register` over stdio.

## Quick start

### Prerequisites

[Foundry](https://getfoundry.sh) and [Bun](https://bun.sh).

### Local chain, end to end

```sh
# 1. chain + contracts (mock stablecoin, registry, router; registers agent #1 for the deployer)
anvil
cd contracts
PRIVATE_KEY=<anvil key 0> forge script script/DeployLocal.s.sol \
  --rpc-url http://127.0.0.1:8545 --broadcast --skip-simulation

# 2. gateway
cd ../gateway && bun install
cp .env.example .env.local      # CHAIN_ID=31337, addresses from contracts/deployments/31337.json, ANTHROPIC_API_KEY
bun --env-file=.env.local src/server.ts

# 3. web
cd ../web && bun install
printf 'VITE_CHAIN_ID=31337\nVITE_GATEWAY_URL=http://localhost:8787\nVITE_RPC_URL=http://127.0.0.1:8545\n' > .env.local
bun run dev
```

### Tests

```sh
cd contracts && forge test -vvv
cd gateway && bun x tsc --noEmit
cd web && bun x tsc --noEmit && bun x vite build
```

## Deployment

```sh
cd contracts
cp .env.example .env          # PRIVATE_KEY, REGISTRY, ROUTER, STABLE (mainnet), OPS_TREASURY (mainnet, multisig)
forge script script/Deploy.s.sol --rpc-url bsc_testnet --broadcast --skip-simulation --verify
```

The script precomputes the minter address, deploys token → burner → minter → stake, and aborts before broadcasting anything if the prediction does not match. On mainnet it refuses to run without `OPS_TREASURY` set to a non-deployer address and `STABLE` set. Addresses are written to `contracts/deployments/<chainId>.json`, which the web app imports directly.

## Deployments

| | BNB Chain mainnet (56) | BSC testnet (97) |
|---|---|---|
| YAN token | `0xa19cB6ef09E3a5fDc36230afd25e1044078100Fd` | `0x23cE94fA1fAD79Ec09E2cc485b1c160C2C4E73f9` |
| ProofOfInference | `0x073648Dd60402E39C332B49d76728EAE2820d2d8` | `0x5Fc10eBDfA80E218c3bB998c62F525796F177551` |
| BuybackBurner | `0x23cE94fA1fAD79Ec09E2cc485b1c160C2C4E73f9` | `0x073648Dd60402E39C332B49d76728EAE2820d2d8` |
| SuanStake | `0x5Fc10eBDfA80E218c3bB998c62F525796F177551` | `0xaBD3774CD5218516953c4Ab276890948aDc52688` |
| Settlement stablecoin | USD1 `0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d` | MockUSD `0xa19cB6ef09E3a5fDc36230afd25e1044078100Fd` |
| Ops treasury | `0x16F7e765DC66D5589bc60e8005949921E066A65E` | deployer |
| Gateway ERC-8004 agent | #401787 | #2705 |
| Deploy block | 131213494 | 140262704 |

All contracts are verified on BscScan and Sourcify. Gateway: `https://api.yansuan.io`. Site: `https://yansuan.io`.

Known addresses:

| | Mainnet (56) | Testnet (97) |
|---|---|---|
| ERC-8004 Identity Registry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| PancakeSwap V2 Router | `0x10ED43C718714eb63d5aA57B78B54704E256024E` | `0xD99D1c33F9fC3444f8101754aBC46c52416550D1` |
| USD1 | `0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d` | deploy `MockUSD` |

After deploying, register the gateway as an ERC-8004 agent so it is discoverable:

```sh
cd gateway && AGENT_PRIVATE_KEY=0x… bun src/register.ts https://<gateway-host>/agent.json
```

## Launch sequence

1. Deploy to testnet, verify, run the gateway against it with Postgres, run the genesis agent (`gateway/src/genesis.ts`) for 72 hours.
2. Second independent review of `ProofOfInference._emission`, `costToCap` and `BuybackBurner`.
3. Mainnet deploy with USD1 and a multisig `OPS_TREASURY`.
4. Genesis agent mines in a 72-hour private window; the YAN/USD1 PancakeSwap pool is seeded from those tokens plus treasury USD1 and the LP is burned; public mining opens.
5. Publish the MCP server and `SKILL.md`; submit to BNB Chain ecosystem programs.

## Security model

- Token: no owner, immutable minter, cap enforced on `totalSupply`.
- Minter: immutable parameters and destinations; owner can only pause `mine`; `redeem` can never be paused; `nonReentrant` everywhere stablecoin or tokens move.
- Burner: stablecoin can only leave through a swap whose entire output is burned; slippage floor and per-call cap are enforced on-chain; keeper is a role, not a trust assumption on price.
- Gateway: no API keys; wallet signatures bound to chain, agent, time, nonce and body; reservations before execution; mandatory persistent ledger; server-side tools refused; bounded caches and IP limits.
- Not yet supported: ERC-1271 smart-account signers at the gateway; fee-on-transfer stablecoins.

## License

MIT
