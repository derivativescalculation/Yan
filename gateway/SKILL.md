---
name: yansuan
description: Mint 衍算 ($YAN) on BNB Chain with a Binance .ai Agent ID wallet, then spend the inference credit at the Yansuan gateway. Use when the user asks to mint YAN, check their YAN allowance, or use Yansuan credit.
---

# 衍算 Yansuan — minted only by .ai agents

Only wallets that hold a Binance **.ai Agent ID** can mint YAN. The agent pays BNB to the minter contract; the contract values it in USD with Chainlink BNB/USD, mints YAN to the agent wallet and books the USD value as inference credit on that wallet. Each Agent ID can mint at most 1,000,000 YAN per epoch. The mint rate steps down 30% every 100M YAN.

These steps use the Binance Agentic Wallet skill (`baw`). Install it with
`npx skills add binance/binance-skills-hub/skills/binance-web3/binance-agentic-wallet`.

## Mint

1. `baw wallet agent-id --json` → `claimed` must be `true`. If not, the user claims a free .ai Agent ID in the Binance app (Web3 wallet → Agent ID).
2. `baw wallet settings --json` → `devMode.enabled` must be `true`. If not, the user turns on Developer Mode in the Binance app (Agentic Wallet → Settings → Developer Mode).
3. `baw wallet address --json` → the agent wallet on BSC (`<wallet>`).
4. Check the quote and allowance: `GET {GATEWAY}/v1/quote?bnb=<amount>&agent=<wallet>`. Stop if `canMine` is false and tell the user `reason`.
5. Preview: `baw contract-call preview --binanceChainId 56 --from <wallet> --to <MINTER> --value <wei> --inputData 0x99f4b251 --json`
   (`0x99f4b251` is `mine()`; `--value` is in wei, e.g. 0.01 BNB = 10000000000000000).
6. Show the user the parsed transaction and risks, get an explicit "yes", then `baw contract-call execute --requestId <requestId> --json`.

The minter address is listed at https://yansuan.io/mine and in `{GATEWAY}/`. Never use any other address.

## Use the credit (optional)

1. `GET {GATEWAY}/v1/login/challenge?wallet=<wallet>` → returns `signRequest` and `message`.
2. `baw sign-message preview --binanceChainId 56 --signType EIP712 --message '<signRequest>' --json`, confirm with the user, `baw sign-message execute --requestId <id> --json`.
3. `POST {GATEWAY}/v1/login` with `{ "wallet", "issuedAt", "nonce", "signature" }` from step 1 and 2 → `{ token }`, valid 7 days.
4. `POST {GATEWAY}/v1/messages` with `Authorization: Bearer <token>` and an Anthropic Messages body (`model`, `max_tokens`, `messages`). Billed at list price + 75% from the wallet's credit. `GET {GATEWAY}/v1/agents/<wallet or name.ai>` shows the balance.

## Rules

- Minimum payment is $1 of BNB. The price feed must be fresh or the transaction reverts; nothing is minted at a bad price.
- Each payment is split in the same transaction: 80% to the ops treasury (pays for the AI compute), 20% to the buyback burner.
- Any YAN holder can `redeem(amount)` for credit at 10% of the genesis mint value, and `stake(amount)` in SuanStake for a gateway tier (铜 0 · 银 1M · 金 10M · 玄 100M YAN).
- Only custom tools are accepted at the gateway (no server tools); use `stream: true` when `max_tokens` > 8000.
