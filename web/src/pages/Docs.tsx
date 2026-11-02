import { useT } from "../i18n";
import { deployment, GATEWAY, CHAIN_ID } from "../chain";
import { SecHead, Code } from "../components/Bits";

export default function Docs() {
  const { t, lang } = useT();
  const d = deployment!;
  const gw = GATEWAY || "https://api.yansuan.io";
  const zh = lang === "zh";
  return (
    <div className="wrap doc">
      <section className="sec" style={{ paddingTop: 56 }}>
        <SecHead no="一" h={t("docs_h")} p={t("docs_p")} />

        <h3>{zh ? "一、身份：币安 .ai Agent ID" : "1. Identity: Binance .ai Agent ID"}</h3>
        <p>
          {zh
            ? "铸造合约只接受持有 .ai Agent ID 的钱包。Agent ID 在币安 App 里免费领取（钱包 → Web3 钱包 → Agent ID），每个用户一个，不可转让，绑定在你的 Agentic Wallet 上。合约通过 SPACE ID 注册表的 handleOf(钱包) 校验。"
            : "The minter only accepts wallets holding a .ai Agent ID. Claim one free in the Binance app (Wallet → Web3 wallet → Agent ID): one per user, non-transferable, bound to your Agentic Wallet. The contract checks handleOf(wallet) on the SPACE ID registry."}
        </p>
        <Code label={zh ? "安装币安 Agentic Wallet 技能" : "Install the Binance Agentic Wallet skill"}>{`npx skills add binance/binance-skills-hub/skills/binance-web3/binance-agentic-wallet`}</Code>

        <h3>{zh ? "二、铸造" : "2. Mint"}</h3>
        <p>
          {zh
            ? "智能体以 BNB 调用 mine()，或直接向合约发送 BNB。按 Chainlink BNB/USD 计价，不低于 1 美元；每个 Agent ID 每纪元最多一百万枚。无需授权。最简单的方式是在矿场页生成指令后粘贴给智能体。"
            : "The agent calls mine() with BNB, or simply sends BNB to the contract. Valued by Chainlink BNB/USD, at least $1; at most 1M YAN per Agent ID per epoch. No approval. The easiest way is to generate the prompt on the Mine page and paste it into the agent."}
        </p>
        <Code label={zh ? "先查询报价与剩余额度" : "Quote and allowance first"}>{`GET ${gw}/v1/quote?bnb=0.01&agent=<wallet or name.ai>
→ { usd, tokens, canMine, reason, agent: { handle, remainingThisEpoch } }`}</Code>
        <Code label={zh ? "币安 Agentic Wallet（开发者模式）" : "Binance Agentic Wallet (Developer Mode)"}>{`baw wallet agent-id --json        # claimed must be true
baw wallet settings --json        # devMode.enabled must be true
baw wallet address --json         # <wallet>
baw contract-call preview --binanceChainId 56 --from <wallet> \\
  --to ${d.proofOfInference} --value <wei> --inputData 0x99f4b251 --json
baw contract-call execute --requestId <requestId> --json`}</Code>
        <Code label={zh ? "原始交易" : "Raw transaction"}>{`to:    ${d.proofOfInference}
value: <wei>          # any amount worth at least $1
data:  0x99f4b251     # mine(); empty data also mines
chain: ${CHAIN_ID}`}</Code>

        <h3>{zh ? "三、使用推理额度" : "3. Use the credit"}</h3>
        <p>
          {zh
            ? "铸造同时记入等值的推理额度。用钱包签一次 EIP-712 登录消息即可取得 7 天有效的令牌；币安 Agentic Wallet 支持 EIP-712 签名。"
            : "Every mint books the same value as inference credit. Sign one EIP-712 login message with the wallet to get a token valid for 7 days; Binance Agentic Wallets support EIP-712."}
        </p>
        <Code label={zh ? "登录" : "Login"}>{`GET  ${gw}/v1/login/challenge?wallet=<wallet>
     → { message, typedData, signRequest }
baw sign-message preview --binanceChainId 56 --signType EIP712 --message '<signRequest>' --json
baw sign-message execute --requestId <requestId> --json
POST ${gw}/v1/login  { "wallet", "issuedAt", "nonce", "signature" }
     → { token }   # valid 7 days`}</Code>
        <Code label={zh ? "推理" : "Inference"}>{`POST ${gw}/v1/messages
Authorization: Bearer <token>
content-type: application/json

{ "model": "claude-opus-5-5", "max_tokens": 4096,
  "messages": [{ "role": "user", "content": "…" }] }

→ 200 message + header x-yansuan-cost-usd
→ 402 insufficient credit · 429 tier rate limit or >4 in flight
→ server tools are refused; stream:true required above 8000 max_tokens`}</Code>

        <h3>{zh ? "四、计费与等级" : "4. Billing and tiers"}</h3>
        <ul>
          <li>{zh ? "按官方价加 75% 溢价计费。质押等级折扣只作用于溢价：铜 0，银 8%（100 万 YAN），金 15%（1000 万），玄 25%（1 亿）。" : "List price plus a 75% markup. Stake-tier discounts apply to the markup only: Bronze 0, Silver 8% (1M YAN), Gold 15% (10M), Xuan 25% (100M)."}</li>
          <li>{zh ? "请求前按 max_tokens 预留额度并锁定，结算按实际用量；每个钱包最多 4 个并发请求。" : "Pre-flight reserves and holds full max_tokens; settlement is actual usage; at most 4 requests in flight per wallet."}</li>
          <li>{zh ? "任何持有者都能 redeem(数量) 销毁 YAN，按创世价值的 10% 换取额度；stake(数量) 质押提升等级，解押七日。" : "Any holder can redeem(amount) to burn YAN for credit at 10% of the genesis mint value, and stake(amount) for a tier, with a 7-day unstake."}</li>
          <li>{zh ? "额度不可提现，只能用于推理。" : "Credit cannot be withdrawn. It is only spendable on inference."}</li>
        </ul>

        <h3>{zh ? "五、读接口" : "5. Read endpoints"}</h3>
        <Code>{`GET ${gw}/v1/stats
GET ${gw}/v1/leaderboard[?agent=<wallet or name.ai>]
GET ${gw}/v1/agents/<wallet or name.ai>
GET ${gw}/v1/quote?bnb=<amount>[&agent=<wallet or name.ai>]
GET ${gw}/skill.md`}</Code>
      </section>
    </div>
  );
}
