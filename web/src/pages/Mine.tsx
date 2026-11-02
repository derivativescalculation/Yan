import { useState } from "react";
import { Link } from "react-router-dom";
import { useReadContract } from "wagmi";
import { parseAbi, parseEther } from "viem";
import { useT } from "../i18n";
import { useMining, useProtocol } from "../hooks";
import { deployment, poiAbi, fmt, compact, short, GATEWAY, CHAIN_ID, RPC } from "../chain";
import { SecHead, Addr, Panel, Code } from "../components/Bits";

const REPO = "https://github.com/derivativescalculation/Yan";
const PRESETS = ["0.005", "0.01", "0.05", "0.1", "0.5"];
const registryAbi = parseAbi(["function ownerOf(uint256 agentId) view returns (address)"]);

function rpcUrl() {
  return RPC || (CHAIN_ID === 56 ? "https://bsc-dataseed.bnbchain.org" : "https://bsc-testnet-rpc.publicnode.com");
}

/** Pick an amount, see what it mints, get the exact command for that amount. */
function MintPlanner() {
  const { t, lang } = useT();
  const zh = lang === "zh";
  const d = deployment!;
  const p = useProtocol();
  const [bnb, setBnb] = useState("0.01");
  const [agent, setAgent] = useState("");

  const wei = (() => {
    try {
      return /^\d*\.?\d+$/.test(bnb) ? parseEther(bnb) : 0n;
    } catch {
      return 0n;
    }
  })();
  const agentId = /^\d{1,30}$/.test(agent) ? BigInt(agent) : undefined;

  const q = useReadContract({ address: d.proofOfInference, abi: poiAbi, functionName: "quote", args: [wei], query: { enabled: wei > 0n, refetchInterval: 15_000 } });
  const owner = useReadContract({ address: d.registry, abi: registryAbi, functionName: "ownerOf", args: [agentId ?? 0n], query: { enabled: agentId !== undefined, retry: 0 } });

  const usd = p.bnbUsd !== undefined ? (wei * p.bnbUsd) / 10n ** 18n : undefined;
  const minWei = p.bnbUsd ? (10n ** 36n + p.bnbUsd - 1n) / p.bnbUsd : undefined; // $1 minimum, rounded up
  const invalid = bnb !== "" && wei === 0n;
  const belowMin = wei > 0n && minWei !== undefined && wei < minWei;
  const overCap = usd !== undefined && p.costToCap !== undefined && usd > p.costToCap;
  const ok = wei > 0n && !belowMin && !overCap;

  const amt = ok ? bnb : "<BNB>";
  const id = agentId !== undefined ? agentId.toString() : "<agentId>";
  const mcpCall = `yansuan_mine { "bnb": "${amt}" }`;
  const castCmd = `cast send ${d.proofOfInference} \\
  "mine(uint256)" ${id} \\
  --value ${amt}ether \\
  --private-key $AGENT_KEY \\
  --rpc-url ${rpcUrl()}`;

  return (
    <div className="g2" style={{ alignItems: "start" }}>
      <Panel h={zh ? "选择金额" : "Choose an amount"} m="BNB">
        <div className="field">
          <label>{zh ? "支付 BNB" : "Payment (BNB)"}</label>
          <input value={bnb} onChange={(e) => setBnb(e.target.value.trim().replace(",", "."))} inputMode="decimal" placeholder="0.01" />
        </div>
        <div className="chips">
          {PRESETS.map((v) => (
            <button key={v} type="button" className={bnb === v ? "on" : ""} onClick={() => setBnb(v)}>{v}</button>
          ))}
        </div>
        <div className="field">
          <label>{zh ? "agentId（可选，用于生成指令）" : "agentId (optional, fills the command)"}</label>
          <input value={agent} onChange={(e) => setAgent(e.target.value.trim())} inputMode="numeric" placeholder={zh ? "你的 agentId" : "your agentId"} />
          {agentId !== undefined ? (
            owner.data ? (
              <span className="hint">{zh ? "所有者 " : "Owner "}<Addr a={owner.data as string} n={4} />{zh ? "。只有它或其代理钱包能为该 agentId 铸造。" : ". Only it or its agent wallet can mine for this agentId."}</span>
            ) : owner.isError ? (
              <span className="err">{zh ? "注册表中没有这个 agentId。" : "This agentId is not in the registry."}</span>
            ) : null
          ) : null}
        </div>
        <div className="kvl">
          <div><span>{zh ? "约合" : "Worth"}</span><b>{ok && usd !== undefined ? `${fmt(usd, 18, 2)} USD` : "—"}</b></div>
          <div><span>{zh ? "可铸造" : "Mints"}</span><b>{ok ? `${fmt(q.data as bigint | undefined, 18, 0)} YAN` : "—"}</b></div>
          <div><span>BNB / USD</span><b>{fmt(p.bnbUsd, 18, 2)}</b></div>
          <div><span>{t("s_rate")}</span><b>{fmt(p.tokensPerUsd, 18, 0)} YAN/USD</b></div>
          <div><span>{zh ? "最低支付" : "Minimum"}</span><b>{minWei !== undefined ? `${fmt(minWei, 18, 5)} BNB` : "—"}</b></div>
        </div>
        {invalid ? <p className="warn">{zh ? "请输入有效的 BNB 数量。" : "Enter a valid BNB amount."}</p> : null}
        {belowMin ? <p className="warn">{zh ? "低于 1 美元的最低支付，合约会拒绝。" : "Below the $1 minimum; the contract will reject it."}</p> : null}
        {overCap ? <p className="warn">{zh ? "超过剩余可铸造量，多付部分不会铸造。" : "Exceeds the cost to cap; the excess mints nothing."}</p> : null}
      </Panel>

      <div>
        <Code label={zh ? "MCP · 让智能体执行" : "MCP · ask the agent"}>{mcpCall}</Code>
        <Code label={zh ? "交易 · 直接发送" : "Transaction · send directly"}>{castCmd}</Code>
        <p className="hint" style={{ marginTop: 12 }}>
          {ok
            ? zh
              ? `指令已按 ${bnb} BNB 生成。只有该 agentId 的所有者或代理钱包能调用，其它地址会被合约拒绝。网站从不接触密钥。`
              : `Commands are filled for ${bnb} BNB. Only the agentId's owner or agent wallet can call; any other address is rejected by the contract. This site never touches a key.`
            : zh
              ? "先在左边选择有效金额，指令会自动填入。"
              : "Choose a valid amount on the left and the commands fill in."}
        </p>
      </div>
    </div>
  );
}

function Steps() {
  const { lang } = useT();
  const zh = lang === "zh";
  const d = deployment!;
  const gw = GATEWAY || "https://api.yansuan.io";
  const mcp = `{
  "mcpServers": {
    "yansuan": {
      "command": "bun",
      "args": ["<repo>/gateway/src/mcp.ts"],
      "env": {
        "AGENT_PRIVATE_KEY": "0x…",
        "AGENT_ID": "<agentId>",
        "GATEWAY_URL": "${gw}",
        "CHAIN_ID": "${CHAIN_ID}",
        "RPC_URL": "${rpcUrl()}",
        "POI_ADDRESS": "${d.proofOfInference}",
        "TOKEN_ADDRESS": "${d.token}",
        "STAKE_ADDRESS": "${d.stake}",
        "REGISTRY_ADDRESS": "${d.registry}"
      }
    }
  }
}`;
  return (
    <>
      <div className="g3">
        <div>
          <div className="no">{zh ? "壹" : "I"}</div>
          <h3>{zh ? "装上工具" : "Install the tools"}</h3>
          <p>
            {zh
              ? "克隆仓库，把衍算 MCP 服务加入智能体配置。密钥只存在智能体自己的运行环境里，网站从不接触。"
              : "Clone the repo and add the Yansuan MCP server to the agent's config. The key lives only in the agent's own runtime; this site never touches it."}
          </p>
        </div>
        <div>
          <div className="no">{zh ? "贰" : "II"}</div>
          <h3>{zh ? "注册身份" : "Register an identity"}</h3>
          <p>
            {zh ? "智能体调用 " : "The agent calls "}
            <code>yansuan_register</code>
            {zh ? "，在 ERC-8004 身份注册表获得 agentId，写回配置的 AGENT_ID。只需一次。" : " to get an agentId from the ERC-8004 Identity Registry, then sets AGENT_ID. Once."}
          </p>
        </div>
        <div>
          <div className="no">{zh ? "叁" : "III"}</div>
          <h3>{zh ? "支付即铸造" : "Pay, and it mints"}</h3>
          <p>
            {zh ? "智能体以任意金额调用 " : "The agent calls "}
            <code>yansuan_mine</code>
            {zh ? "（不低于 1 美元）。一笔交易，无需授权。YAN 铸给智能体，额度记在 agentId，随后 " : " with any amount of at least $1. One transaction, no approval. YAN goes to the agent, credit to its agentId, then "}
            <code>yansuan_infer</code>
            {zh ? " 消费额度。" : " spends it."}
          </p>
        </div>
      </div>
      <div style={{ marginTop: 32 }}>
        <Code label={zh ? "MCP 配置" : "MCP config"}>{mcp}</Code>
        <p className="hint" style={{ marginTop: 10 }}>
          <a href={REPO} target="_blank" rel="noreferrer">{REPO.replace("https://", "")}</a> · <Link to="/docs">{zh ? "完整接入文档" : "full integration docs"}</Link>
        </p>
      </div>
    </>
  );
}

export default function Mine() {
  const { t, lang } = useT();
  const zh = lang === "zh";
  const mining = useMining();
  const lb = mining.rows;
  const feed = mining.feed;
  if (!deployment) return <div className="wrap notice">No deployment for this chain.</div>;

  return (
    <div className="wrap">
      <section className="sec" style={{ paddingTop: 56 }}>
        <SecHead
          no="一"
          h={zh ? "计算并铸造" : "Calculate and mint"}
          p={zh ? "先选金额，看清能铸多少，再把指令交给你的智能体。网站不连接钱包。" : "Pick an amount, see what it mints, then hand the command to your agent. This site never connects a wallet."}
        />
        <MintPlanner />
      </section>

      <section className="sec">
        <SecHead no="二" h={zh ? "接入你的智能体" : "Connect your agent"} p={zh ? "铸造只发生在智能体自己的运行环境里。" : "Minting happens only inside the agent's own runtime."} />
        <Steps />
      </section>

      <section className="sec">
        <div className="g2" style={{ alignItems: "start" }}>
          <div>
            <SecHead no="三" h={t("nav_agents")} />
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>{t("lb_rank")}</th><th>{t("lb_agent")}</th><th className="num">{t("lb_mined")}</th><th className="num">{t("lb_paid")}</th><th className="num">{t("lb_txs")}</th></tr></thead>
                <tbody>
                  {lb.length === 0 ? <tr><td colSpan={5} className="empty">{mining.loading ? t("loading") : t("none")}</td></tr> : null}
                  {lb.slice(0, 50).map((r, i) => (
                    <tr key={r.agentId.toString()}>
                      <td className="mono">{i + 1}</td>
                      <td><Link to={`/agent/${r.agentId}`} className="mono">#{r.agentId.toString()}</Link></td>
                      <td className="num">{compact(r.tokens)}</td>
                      <td className="num">{fmt(r.usd, 18, 2)}</td>
                      <td className="num">{r.txs}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div>
            <SecHead no="四" h={t("feed_h")} />
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>{t("f_agent")}</th><th className="num">BNB</th><th className="num">{t("f_tokens")}</th><th>{t("f_tx")}</th></tr></thead>
                <tbody>
                  {feed.length === 0 ? <tr><td colSpan={4} className="empty">{mining.loading ? t("loading") : t("none")}</td></tr> : null}
                  {feed.map((e) => (
                    <tr key={e.tx + e.agentId.toString()}>
                      <td><Link to={`/agent/${e.agentId}`} className="mono">#{e.agentId.toString()}</Link></td>
                      <td className="num">{fmt(e.wei, 18, 4)}</td>
                      <td className="num">{compact(e.tokens)}</td>
                      <td><Addr a={e.tx} n={4} kind="tx" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {feed.length ? <p className="hint" style={{ marginTop: 8 }}>{zh ? "区块 " : "Block "}{feed[0].block.toString()} · {short(feed[0].miner)}</p> : null}
          </div>
        </div>
      </section>
    </div>
  );
}
