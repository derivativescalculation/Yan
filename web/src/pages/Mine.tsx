import { useState } from "react";
import { Link } from "react-router-dom";
import { useReadContract } from "wagmi";
import { parseEther } from "viem";
import { useT } from "../i18n";
import { useMining, useProtocol } from "../hooks";
import { deployment, poiAbi, fmt, compact, GATEWAY, CHAIN_ID, RPC } from "../chain";
import { SecHead, Addr, Panel } from "../components/Bits";

const REPO = "https://github.com/derivativescalculation/Yan";

function Steps() {
  const { lang } = useT();
  const zh = lang === "zh";
  const d = deployment!;
  const gw = GATEWAY || "https://api.yansuan.io";
  const rpc = RPC || (CHAIN_ID === 56 ? "https://bsc-dataseed.bnbchain.org" : "https://bsc-testnet-rpc.publicnode.com");
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
        "RPC_URL": "${rpc}",
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
            {zh ? "智能体调用 " : "The agent calls "}
            <code>yansuan_mine {"{ bnb }"}</code>
            {zh ? "。一笔交易，无需授权。YAN 铸给智能体，额度记在 agentId，随后 " : ". One transaction, no approval. YAN goes to the agent, credit to its agentId, then "}
            <code>yansuan_infer</code>
            {zh ? " 消费额度。" : " spends it."}
          </p>
        </div>
      </div>
      <div className="g2" style={{ marginTop: 32, alignItems: "start" }}>
        <div>
          <pre>{mcp}</pre>
          <p className="hint" style={{ marginTop: 10 }}>
            <a href={REPO} target="_blank" rel="noreferrer">{REPO.replace("https://", "")}</a> · <Link to="/docs">{zh ? "完整接入文档" : "full integration docs"}</Link>
          </p>
        </div>
        <div>
          <pre>{`# ${zh ? "不用 MCP，也可以直接发交易" : "or send the transaction directly"}
cast send ${d.proofOfInference} \\
  "mine(uint256)" <agentId> \\
  --value 0.01ether --private-key $AGENT_KEY \\
  --rpc-url ${rpc}`}</pre>
          <p className="hint" style={{ marginTop: 10 }}>
            {zh
              ? "只有该 agentId 的所有者或代理钱包能调用，其它地址会被合约拒绝。"
              : "Only the agentId's owner or agent wallet can call it; any other address is rejected by the contract."}
          </p>
        </div>
      </div>
    </>
  );
}

function Calculator() {
  const { t, lang } = useT();
  const zh = lang === "zh";
  const d = deployment!;
  const p = useProtocol();
  const [bnb, setBnb] = useState("0.01");
  const wei = (() => {
    try {
      return parseEther(bnb || "0");
    } catch {
      return 0n;
    }
  })();
  const q = useReadContract({ address: d.proofOfInference, abi: poiAbi, functionName: "quote", args: [wei], query: { enabled: wei > 0n, refetchInterval: 15_000 } });
  const usd = p.bnbUsd !== undefined ? (wei * p.bnbUsd) / 10n ** 18n : undefined;
  const minWei = p.bnbUsd ? (10n ** 36n + p.bnbUsd - 1n) / p.bnbUsd : undefined; // $1 minimum
  const overCap = usd !== undefined && p.costToCap !== undefined && usd > p.costToCap;
  const belowMin = usd !== undefined && wei > 0n && usd < 10n ** 18n;
  return (
    <Panel h={zh ? "铸造计算" : "Mint calculator"} m="BNB">
      <div className="field">
        <label>{zh ? "支付 BNB" : "Payment (BNB)"}</label>
        <input value={bnb} onChange={(e) => setBnb(e.target.value.trim())} inputMode="decimal" />
      </div>
      <div className="kvl">
        <div><span>{zh ? "约合" : "Worth"}</span><b>{usd !== undefined ? `${fmt(usd, 18, 2)} USD` : "—"}</b></div>
        <div><span>{zh ? "可铸造" : "Mints"}</span><b>{belowMin ? "—" : `${fmt(q.data as bigint | undefined, 18, 0)} YAN`}</b></div>
        <div><span>BNB / USD</span><b>{fmt(p.bnbUsd, 18, 2)}</b></div>
        <div><span>{t("s_rate")}</span><b>{fmt(p.tokensPerUsd, 18, 0)} YAN/USD</b></div>
        <div><span>{zh ? "最低支付" : "Minimum"}</span><b>{minWei !== undefined ? `${fmt(minWei, 18, 5)} BNB` : "—"}</b></div>
      </div>
      {belowMin ? <p className="err" style={{ marginTop: 10 }}>{zh ? "低于 1 美元的最低支付，合约会拒绝。" : "Below the $1 minimum; the contract will reject it."}</p> : null}
      {overCap ? <p className="err" style={{ marginTop: 10 }}>{zh ? "超过剩余可铸造量，多付部分不会铸造。" : "Exceeds the cost to cap; the excess mints nothing."}</p> : null}
    </Panel>
  );
}

export default function Mine() {
  const { t, lang } = useT();
  const zh = lang === "zh";
  const mining = useMining();
  const lb = mining.rows;
  const feed = mining.feed;
  const logs = { isLoading: mining.loading };
  if (!deployment) return <div className="wrap notice">No deployment for this chain.</div>;

  return (
    <div className="wrap">
      <section className="sec" style={{ paddingTop: 56 }}>
        <SecHead
          no="一"
          h={zh ? "接入你的智能体" : "Connect your agent"}
          p={zh ? "铸造只发生在智能体自己的运行环境里。网站不连接钱包，也不需要。" : "Minting happens only inside the agent's own runtime. This site never connects a wallet and does not need to."}
        />
        <Steps />
      </section>

      <section className="sec">
        <div className="g2" style={{ alignItems: "start" }}>
          <div>
            <SecHead no="二" h={zh ? "计算" : "Calculate"} p={zh ? "按当前 Chainlink 价格与纪元比率实时估算。" : "Live estimate from the Chainlink price and the current epoch rate."} />
            <Calculator />
          </div>
          <div>
            <SecHead no="三" h={t("nav_agents")} />
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>{t("lb_rank")}</th><th>{t("lb_agent")}</th><th className="num">{t("lb_mined")}</th><th className="num">{t("lb_paid")}</th><th className="num">{t("lb_txs")}</th></tr></thead>
                <tbody>
                  {lb.length === 0 ? <tr><td colSpan={5} className="empty">{logs.isLoading ? t("loading") : t("none")}</td></tr> : null}
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
        </div>
      </section>

      <section className="sec">
        <SecHead no="四" h={t("feed_h")} />
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>{t("f_block")}</th><th>{t("f_agent")}</th><th className="num">BNB</th><th className="num">{t("f_usd")}</th><th className="num">{t("f_tokens")}</th><th>{t("f_tx")}</th></tr></thead>
            <tbody>
              {feed.length === 0 ? <tr><td colSpan={6} className="empty">{logs.isLoading ? t("loading") : t("none")}</td></tr> : null}
              {feed.map((e) => (
                <tr key={e.tx + e.agentId.toString()}>
                  <td className="mono">{e.block.toString()}</td>
                  <td><Link to={`/agent/${e.agentId}`} className="mono">#{e.agentId.toString()}</Link></td>
                  <td className="num">{fmt(e.wei, 18, 4)}</td>
                  <td className="num">{fmt(e.usd, 18, 2)}</td>
                  <td className="num">{fmt(e.tokens, 18, 0)}</td>
                  <td><Addr a={e.tx} n={4} kind="tx" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
