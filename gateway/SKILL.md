---
name: yansuan
description: Mine 衍算 ($YAN) on BNB Chain by paying BNB for Claude inference as an ERC-8004 agent, then spend the credit through the Yansuan gateway. Use when an agent needs inference and wants to earn the token.
---

# 衍算 Yansuan — Proof of Inference

Only registered AI agents can mint $YAN. An agent pays BNB for inference credit; the contract values the payment in USD with the Chainlink BNB/USD feed, mints YAN to the agent and books the USD value as credit on its agentId. The credit is spent at this gateway. The mint rate steps down 30% every 100M tokens. YAN is always redeemable (even while mining is paused) for inference credit at 10% of the genesis mint value.

## Setup (once)

1. Wallet: an EVM key on BNB Chain holding BNB. The same key signs mining transactions and gateway requests.
2. Identity: an ERC-8004 agentId that this key owns or is the agent wallet of. Create one with `yansuan_register` (MCP) or `register(agentURI)` on the Identity Registry.
3. MCP: add this server to your agent config:

```json
{ "mcpServers": { "yansuan": { "command": "bun", "args": ["<path>/gateway/src/mcp.ts"],
  "env": { "AGENT_PRIVATE_KEY": "0x..", "AGENT_ID": "<id>", "GATEWAY_URL": "https://api.yansuan.io",
           "CHAIN_ID": "56", "RPC_URL": "https://bsc-dataseed.bnbchain.org",
           "POI_ADDRESS": "..", "TOKEN_ADDRESS": "..", "STAKE_ADDRESS": "..",
           "REGISTRY_ADDRESS": "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" } } } }
```

## Loop

- `yansuan_quote { bnb }` shows the YAN a payment mints and its USD value.
- `yansuan_mine { bnb }` sends one transaction: `ProofOfInference.mine(agentId)` with the BNB as value. No approval step.
- `yansuan_infer { prompt }` or `POST /v1/messages` (Anthropic Messages shape) with headers `x-agent-id`, `x-agent-address`, `x-agent-ts` (unix seconds), `x-agent-nonce` (random 0x-hex), `x-agent-sig` = personal_sign(`yansuan:<chainId>:<agentId>:<ts>:<nonce>:<sha256(body) as 0x-hex>`). One signature per request; only custom tools are accepted (no server tools); set `stream: true` when `max_tokens` > 8000.
- `yansuan_balance` shows remaining credit and tier.
- `yansuan_stake { tokens }` raises your tier: 铜 0, 银 1M (-8%), 金 10M (-15%), 玄 100M (-25%) off the markup.
- `yansuan_redeem { tokens }` burns YAN for credit when you would rather compute than hold.

## Rules

- Each payment is split in the same transaction: 80% to the ops treasury (model bills), 20% to the buyback burner. Inference is billed at list price + 75% markup; stake-tier discounts apply to the markup only.
- The minimum payment is $1 of BNB. The price feed must be fresh or `mine` reverts.
- Pre-flight reserve = full `max_tokens` at the charged rate (list + markup), held until the request settles; at most 4 requests in flight per agent. Keep `max_tokens` honest.
- 402 means top up. 429 means your tier's per-minute limit or too many requests in flight.
