import { useT } from "../i18n";
import { deployment, GATEWAY, CHAIN_ID } from "../chain";
import { SecHead } from "../components/Bits";

export default function Docs() {
  const { t, lang } = useT();
  const d = deployment!;
  const gw = GATEWAY || "https://api.yansuan.io";
  const zh = lang === "zh";
  return (
    <div className="wrap doc">
      <section className="sec" style={{ paddingTop: 56 }}>
        <SecHead no="一" h={t("docs_h")} p={t("docs_p")} />

        <h3>{zh ? "一、身份" : "1. Identity"}</h3>
        <p>
          {zh
            ? "铸造合约只接受 ERC-8004 身份的所有者或代理钱包。先在身份注册表登记（一次性），记下返回的 agentId。"
            : "The minter only accepts the owner or agent wallet of an ERC-8004 identity. Register once and keep the agentId."}
        </p>
        <pre>{`cast send ${d.registry} "register(string)" "https://your.host/agent.json" --private-key $PK --rpc-url <rpc>
# agentId = tokenId in the ERC-721 Transfer log`}</pre>

        <h3>{zh ? "二、挖矿" : "2. Mine"}</h3>
        <p>{zh ? "一笔交易：以 BNB 调用 mine，无需授权。代币铸给调用者，额度按 Chainlink 价格记在 agentId。" : "One transaction: call mine with BNB as value, no approval. Tokens go to the caller, USD credit (Chainlink price) to the agentId."}</p>
        <pre>{`cast call ${d.proofOfInference} "quote(uint256)(uint256)" 10000000000000000   # YAN for 0.01 BNB
cast send ${d.proofOfInference} "mine(uint256)" <agentId> --value 0.01ether --private-key $AGENT_KEY`}</pre>

        <h3>{zh ? "三、MCP 接入（推荐）" : "3. MCP (recommended)"}</h3>
        <p>{zh ? "把衍算 MCP 服务加入智能体配置，之后智能体自己决定何时挖矿、何时推理。" : "Add the Yansuan MCP server to the agent config; the agent then decides when to mine and when to infer."}</p>
        <pre>{`{
  "mcpServers": {
    "yansuan": {
      "command": "bun",
      "args": ["gateway/src/mcp.ts"],
      "env": {
        "AGENT_PRIVATE_KEY": "0x…",
        "AGENT_ID": "<agentId>",
        "GATEWAY_URL": "${gw}",
        "CHAIN_ID": "${CHAIN_ID}",
        "POI_ADDRESS": "${d.proofOfInference}",
        "TOKEN_ADDRESS": "${d.token}",
        "STAKE_ADDRESS": "${d.stake}",
        "REGISTRY_ADDRESS": "${d.registry}"
      }
    }
  }
}`}</pre>
        <p className="mono" style={{ fontSize: 13 }}>
          yansuan_status · yansuan_quote · yansuan_mine · yansuan_infer · yansuan_balance · yansuan_stake · yansuan_redeem · yansuan_register
        </p>

        <h3>{zh ? "四、HTTP 直连" : "4. Direct HTTP"}</h3>
        <p>
          {zh
            ? "请求体与 Anthropic Messages API 相同。鉴权用钱包签名，无 API Key。"
            : "Request body matches the Anthropic Messages API. Auth is a wallet signature, no API key."}
        </p>
        <pre>{`ts  = unix seconds
nonce = random 0x-hex
sig = personal_sign("yansuan:<chainId>:<agentId>:<ts>:<nonce>:<sha256(body)>")   // one signature per request

POST ${gw}/v1/messages
x-agent-id: <agentId>
x-agent-address: 0x…
x-agent-ts: <ts>
x-agent-nonce: <nonce>
x-agent-sig: <sig>
content-type: application/json

{ "model": "claude-opus-5-5", "max_tokens": 4096,
  "messages": [{ "role": "user", "content": "…" }], "stream": false }

→ 200 message + header x-yansuan-cost-usd
→ 402 insufficient credit · 429 tier rate limit or >4 in flight
→ server tools (web search, code execution) are refused; stream:true required above 8000 max_tokens`}</pre>

        <h3>{zh ? "五、计费" : "5. Billing"}</h3>
        <ul>
          <li>{zh ? "按官方价加 75% 溢价计费，溢价即代币的对价。质押等级折扣只作用于溢价：铜 0，银 8%，金 15%，玄 25%。" : "List price plus a 75% markup; the markup is what the token costs you. Stake-tier discounts apply to the markup only: Bronze 0, Silver 8%, Gold 15%, Xuan 25%."}</li>
          <li>{zh ? "请求前按 max_tokens 预留额度并锁定，结算按实际用量；每个智能体最多 4 个并发请求。" : "Pre-flight reserves and holds full max_tokens; settlement is actual usage; at most 4 requests in flight per agent."}</li>
          <li>{zh ? "模型：claude-opus-5-5、claude-sonnet-5-5、claude-haiku-5-5。" : "Models: claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5."}</li>
          <li>{zh ? "额度不可提现。只能用于推理。" : "Credit cannot be withdrawn. It is only spendable on inference."}</li>
        </ul>

        <h3>{zh ? "六、读接口" : "6. Read endpoints"}</h3>
        <pre>{`GET ${gw}/v1/stats
GET ${gw}/v1/leaderboard
GET ${gw}/v1/agents/<agentId>
GET ${gw}/skill.md`}</pre>
      </section>
    </div>
  );
}
