---
name: yansuan
description: Mine 衍算 ($YAN) on BNB Chain by paying for Claude inference as an ERC-8004 agent, then spend the credit through the Yansuan gateway. Use when an agent needs inference and wants to earn the token.
---

# 衍算 Yansuan — Proof of Inference

Only registered AI agents can mint $YAN. You mint by paying stablecoin for inference credit; the credit is spent at this gateway. The mint rate steps down 30% every 100M tokens. Tokens are always redeemable (even while mining is paused) for inference credit at 10% of the genesis mint value.

## Setup (once)

1. Wallet: an EVM key on BNB Chain with a little BNB for gas and stablecoin (USD1 on mainnet).
2. Identity: an ERC-8004 agentId that your wallet owns or is the agent wallet of. Register with `yansuan_register` (MCP) or `register(agentURI)` on the Identity Registry.
3. MCP: add this server to your agent config:

```json
{ "mcpServers": { "yansuan": { "command": "bun", "args": ["<path>/gateway/src/mcp.ts"],
  "env": { "AGENT_PRIVATE_KEY": "0x..", "AGENT_ID": "<id>", "GATEWAY_URL": "https://api.yansuan.ai",
           "CHAIN_ID": "56", "POI_ADDRESS": "..", "TOKEN_ADDRESS": "..", "STAKE_ADDRESS": "..", "STABLE_ADDRESS": "..", "REGISTRY_ADDRESS": ".." } } } }
```

## Loop

- `yansuan_quote { usd }` to see tokens per payment.
- `yansuan_mine { usd }` pays on-chain: `approve` + `ProofOfInference.mine(agentId, amount)`. Tokens land in your wallet, credit lands on your agentId.
- `yansuan_infer { prompt }` or `POST /v1/messages` (Anthropic Messages shape) with headers `x-agent-id`, `x-agent-address`, `x-agent-ts` (unix seconds), `x-agent-nonce` (random 0x-hex), `x-agent-sig` = personal_sign(`yansuan:<chainId>:<agentId>:<ts>:<nonce>:<sha256(body) as 0x-hex>`). One signature per request; only custom tools are accepted (no server tools); set `stream: true` when `max_tokens` > 8000.
- `yansuan_balance` shows remaining credit and tier.
- `yansuan_stake { tokens }` raises your tier: 铜 0, 银 1M (-8%), 金 10M (-15%), 玄 100M (-25%) on the markup.
- `yansuan_redeem { tokens }` burns tokens for credit when you would rather compute than hold.

## Rules

- Payment goes 80% to the ops treasury (model bills) and 20% to the buyback burner. Inference is billed at list price + 75% markup; the markup is what buys you the token. Stake-tier discounts apply to the markup only.
- Pre-flight reserve = full `max_tokens` at the charged rate (list + markup), held until the request settles; at most 4 requests in flight per agent. Keep `max_tokens` honest.
- 402 means top up. 429 means your tier's per-minute limit.
