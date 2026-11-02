---
name: yansuan
description: Mint 衍算 ($YAN) on BNB Chain with a Binance .ai Agent ID wallet, and check YAN raffle tickets. Use when the user asks to mint YAN, check their YAN allowance, or check their 天选 raffle tickets.
---

# 衍算 Yansuan — minted only by .ai agents

Only wallets that hold a Binance **.ai Agent ID** can mint YAN. The agent pays BNB to the minter contract; the contract values it in USD with Chainlink BNB/USD and splits every mint in the same transaction: **70% to the agent, 25% to the liquidity vault, 5% to the 天选 raffle**. All BNB goes to the project treasury. Each Agent ID can mint at most 1,000,000 YAN (700,000 to the agent) per epoch, and the mint rate steps down 30% every 100M YAN.

These steps use the Binance Agentic Wallet skill (`baw`). Install it with
`npx skills add binance/binance-skills-hub/skills/binance-web3/binance-agentic-wallet`.

## Mint

1. `baw wallet agent-id --json` → `claimed` must be `true`. If not, the user claims a free .ai Agent ID in the Binance app (Web3 wallet → Agent ID).
2. `baw wallet settings --json` → `devMode.enabled` must be `true`. If not, the user turns on Developer Mode in the Binance app (Agentic Wallet → Settings → Developer Mode).
3. `baw wallet address --json` → the agent wallet on BSC (`<wallet>`).
4. Check the quote and allowance: `GET {GATEWAY}/v1/quote?bnb=<amount>&agent=<wallet>`. Stop if `canMine` is false and tell the user `reason`. `toAgent` is what the wallet receives.
5. Preview: `baw contract-call preview --binanceChainId 56 --from <wallet> --to <MINTER> --value <wei> --inputData 0x99f4b251 --json`
   (`0x99f4b251` is `mine()`; `--value` is in wei, e.g. 0.01 BNB = 10000000000000000).
6. Show the user the parsed transaction and risks, get an explicit "yes", then `baw contract-call execute --requestId <requestId> --json`.

The minter address is listed at https://yansuan.io/mine and in `{GATEWAY}/`. Never use any other address.

## 天选 raffle

- Every wallet holding YAN takes part automatically: one ticket per 10,000 YAN, counted on the lowest balance in the hour before each draw. Nothing to sign up for, nothing to claim; prizes are sent to the winning wallet.
- Three pots fill from 5% of every mint and the 0.5% sell tax: 青罐 opens at 20,000 YAN, 朱瓶 at 100,000, 金鼎 at 1,000,000. Chainlink VRF picks the winning ticket.
- `GET {GATEWAY}/v1/raffle/tickets/<wallet or name.ai>` → `tickets`, `totalTickets`.
- `GET {GATEWAY}/v1/raffle/draws/<id>` → the draw and the full ticket list it was committed with.

## Rules

- Minimum payment is $1 of BNB. The price feed must be fresh or the transaction reverts; nothing is minted at a bad price.
- Selling YAN into the PancakeSwap YAN/WBNB pool pays 0.5% of the amount to the raffle. Use a router path that supports fee-on-transfer tokens and allow at least 1% slippage. Buying is untaxed.
