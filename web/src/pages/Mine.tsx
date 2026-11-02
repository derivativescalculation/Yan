import { useState } from "react";
import { Link } from "react-router-dom";
import { parseEther } from "viem";
import { useT } from "../i18n";
import { useMining, useProtocol, useQuote } from "../hooks";
import { deployment, fmt, compact, GATEWAY } from "../chain";
import { SecHead, Addr, Panel, Code } from "../components/Bits";

const PRESETS = ["0.005", "0.01", "0.02", "0.035"];
const SKILL = "npx skills add binance/binance-skills-hub/skills/binance-web3/binance-agentic-wallet";
const MINE_DATA = "0x99f4b251"; // mine()

/** Pick an amount and (optionally) your .ai name; get a ready prompt for your Binance agent. */
function PromptBuilder() {
  const { t, lang } = useT();
  const zh = lang === "zh";
  const d = deployment!;
  const p = useProtocol();
  const [bnb, setBnb] = useState("0.01");
  const [who, setWho] = useState("");

  const valid = /^\d*\.?\d+$/.test(bnb) && Number(bnb) > 0;
  const wei = valid ? parseEther(bnb) : 0n;
  const agent = who.trim().toLowerCase();
  const agentArg = /^0x[0-9a-f]{40}$/.test(agent) || /^[a-z0-9]{1,64}(\.ai)?$/.test(agent) ? agent : "";
  const q = useQuote(valid ? bnb : "", agentArg || undefined);

  const usd = p.bnbUsd !== undefined ? (wei * p.bnbUsd) / 10n ** 18n : undefined;
  const minWei = p.bnbUsd && p.minPaymentUsd ? (p.minPaymentUsd * 10n ** 18n + p.bnbUsd - 1n) / p.bnbUsd : undefined;
  const belowMin = valid && minWei !== undefined && wei < minWei;
  const capTokens = p.maxPerAgentPerEpoch && p.maxPerAgentPerEpoch > 0n ? p.maxPerAgentPerEpoch : undefined;
  const quote = q.data && !("agentMissing" in q.data && q.data.agentMissing) ? q.data : undefined;
  const toAgent = quote?.toAgent ? BigInt(quote.toAgent) : undefined;
  const total = quote?.total ? BigInt(quote.total) : undefined;
  const overAgentCap = quote?.agent && quote.canMine === false && /allowance/.test(quote.reason ?? "");
  const agentMissing = !!agentArg && !!q.data && "agentMissing" in q.data && !!q.data.agentMissing;
  const agentNoId = agentArg && quote?.agent && !quote.agent.handle;
  const ok = valid && !belowMin && !overAgentCap && !agentMissing && !agentNoId;

  const amt = ok ? bnb : "<BNB>";
  const weiStr = ok ? wei.toString() : "<wei>";
  const gw = GATEWAY || "https://api.yansuan.io";
  const prompt = zh
    ? `用我的币安 Agentic Wallet 铸造衍算 YAN，支付 ${amt} BNB（BNB Chain，链 ID 56）。
1. 运行 baw wallet agent-id --json，确认已领取 .ai Agent ID；没有就停止并告诉我。
2. 运行 baw wallet settings --json，确认 devMode.enabled 为 true；没有就告诉我去币安 App 打开开发者模式（Agentic Wallet → 设置 → 开发者模式）。
3. 运行 baw wallet address --json，取得我的 BSC 钱包地址。
4. 打开 ${gw}/v1/quote?bnb=${amt}&agent=<我的钱包地址>，如果 canMine 不是 true，停止并告诉我 reason。
5. 预览：baw contract-call preview --binanceChainId 56 --from <我的钱包地址> --to ${d.minter} --value ${weiStr} --inputData ${MINE_DATA} --json
6. 把解析出的交易与风险给我看，等我明确回复"确认"后，再运行 baw contract-call execute --requestId <requestId> --json。
合约地址只能是 ${d.minter}，不要使用任何其它地址。`
    : `Mint Yansuan (YAN) with my Binance Agentic Wallet, paying ${amt} BNB on BNB Chain (chain ID 56).
1. Run baw wallet agent-id --json and confirm I have claimed a .ai Agent ID; if not, stop and tell me.
2. Run baw wallet settings --json and confirm devMode.enabled is true; if not, tell me to turn on Developer Mode in the Binance app (Agentic Wallet → Settings → Developer Mode).
3. Run baw wallet address --json to get my BSC wallet address.
4. Open ${gw}/v1/quote?bnb=${amt}&agent=<my wallet address>; if canMine is not true, stop and tell me the reason.
5. Preview: baw contract-call preview --binanceChainId 56 --from <my wallet address> --to ${d.minter} --value ${weiStr} --inputData ${MINE_DATA} --json
6. Show me the parsed transaction and risks, wait for my explicit "yes", then run baw contract-call execute --requestId <requestId> --json.
The contract address must be ${d.minter}. Never use any other address.`;
  const raw = `to:    ${d.minter}
value: ${weiStr}   (${amt} BNB)
data:  ${MINE_DATA}   (mine())
chain: 56`;

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
          <label>{zh ? "你的 .ai 名称（可选，查看剩余额度）" : "Your .ai name (optional, shows your allowance)"}</label>
          <input value={who} onChange={(e) => setWho(e.target.value)} placeholder={zh ? "例如 nemo.ai 或钱包地址" : "e.g. nemo.ai or a wallet address"} />
          {agentArg && quote?.agent ? (
            quote.agent.handle ? (
              <span className="hint">
                {quote.agent.handle}.ai · <Addr a={quote.agent.wallet} n={4} />
                {quote.agent.remainingThisEpoch !== null ? <> · {zh ? "本轮剩余" : "left this round"} <b>{compact(BigInt(quote.agent.remainingThisEpoch))} YAN</b></> : null}
              </span>
            ) : (
              <span className="err">{zh ? "这个钱包没有 .ai Agent ID，合约会拒绝。" : "This wallet holds no .ai Agent ID; the contract will reject it."}</span>
            )
          ) : agentMissing ? (
            <span className="err">{zh ? "没有找到这个 .ai 名称。" : "No such .ai name."}</span>
          ) : null}
        </div>
        <div className="kvl">
          <div><span>{zh ? "约合" : "Worth"}</span><b>{ok && usd !== undefined ? `${fmt(usd, 18, 2)} USD` : "—"}</b></div>
          <div><span>{zh ? "你收到（70%）" : "You receive (70%)"}</span><b>{ok && toAgent !== undefined ? `${fmt(toAgent, 18, 0)} YAN` : "—"}</b></div>
          <div><span>{zh ? "本次共铸" : "Minted in total"}</span><b>{ok && total !== undefined ? `${fmt(total, 18, 0)} YAN` : "—"}</b></div>
          <div><span>{zh ? "入流动性金库 / 天选" : "To the vault / raffle"}</span><b>{ok && quote ? `${compact(BigInt(quote.toVault))} / ${compact(BigInt(quote.toRaffle))}` : "—"}</b></div>
          <div><span>BNB / USD</span><b>{fmt(p.bnbUsd, 18, 2)}</b></div>
          <div><span>{t("s_rate")}</span><b>{fmt(p.tokensPerUsd, 18, 0)} YAN/USD</b></div>
          <div><span>{zh ? "最低支付" : "Minimum"}</span><b>{minWei !== undefined ? `${fmt(minWei, 18, 5)} BNB` : "—"}</b></div>
          <div><span>{zh ? "每个 Agent ID 每轮上限" : "Cap per Agent ID per round"}</span><b>{capTokens ? `${compact(capTokens)} YAN` : zh ? "无" : "none"}</b></div>
        </div>
        {!valid && bnb !== "" ? <p className="warn">{zh ? "请输入有效的 BNB 数量。" : "Enter a valid BNB amount."}</p> : null}
        {belowMin ? <p className="warn">{zh ? "低于 1 美元的最低支付，合约会拒绝。" : "Below the $1 minimum; the contract will reject it."}</p> : null}
        {overAgentCap ? <p className="warn">{zh ? "超过这个 Agent ID 本轮的剩余额度，请减少金额。" : "More than this Agent ID can still mint this round; lower the amount."}</p> : null}
      </Panel>

      <div>
        <Code label={zh ? "复制给你的币安智能体" : "Paste into your Binance agent"}>{prompt}</Code>
        <Code label={zh ? "高级 · 原始交易" : "Advanced · raw transaction"}>{raw}</Code>
        <p className="hint" style={{ marginTop: 12 }}>
          {ok
            ? zh
              ? `已按 ${bnb} BNB 生成。只有持有 .ai Agent ID 的钱包能铸造，其它钱包会被合约拒绝、BNB 原路不动。网站从不接触钱包。`
              : `Filled for ${bnb} BNB. Only wallets holding a .ai Agent ID can mint; any other wallet is rejected by the contract and keeps its BNB. This site never touches a wallet.`
            : zh
              ? "先在左边选择有效金额，指令会自动填入。"
              : "Choose a valid amount on the left and the prompt fills in."}
        </p>
      </div>
    </div>
  );
}

function Steps() {
  const { lang } = useT();
  const zh = lang === "zh";
  return (
    <>
      <div className="g3">
        <div>
          <div className="no">{zh ? "壹" : "I"}</div>
          <h3>{zh ? "领取 .ai 身份" : "Claim a .ai identity"}</h3>
          <p>{zh ? "打开币安 App：钱包 → Web3 钱包 → Agent ID，免费领取你的 .ai 名称，并开通 Agentic Wallet。" : "In the Binance app: Wallet → Web3 wallet → Agent ID. Claim your free .ai name and turn on the Agentic Wallet."}</p>
        </div>
        <div>
          <div className="no">{zh ? "贰" : "II"}</div>
          <h3>{zh ? "接上你的 AI" : "Connect your AI"}</h3>
          <p>{zh ? "在你常用的 AI 智能体里安装币安官方技能，并在 Agentic Wallet 设置里打开开发者模式。" : "Install Binance's official skill in the AI agent you use, then turn on Developer Mode in the Agentic Wallet settings."}</p>
        </div>
        <div>
          <div className="no">{zh ? "叁" : "III"}</div>
          <h3>{zh ? "粘贴，确认" : "Paste, confirm"}</h3>
          <p>{zh ? "把上面的指令粘贴给智能体。它会检查身份与额度、预览交易，你确认后完成铸造。BNB 留在你自己的钱包里，直到你确认。" : "Paste the prompt above into the agent. It checks your identity and allowance, previews the transaction, and mints after you confirm. Your BNB stays in your wallet until then."}</p>
        </div>
      </div>
      <div style={{ marginTop: 32 }}>
        <Code label={zh ? "安装币安 Agentic Wallet 技能" : "Install the Binance Agentic Wallet skill"}>{SKILL}</Code>
        <p className="hint" style={{ marginTop: 10 }}>
          <Link to="/docs">{zh ? "完整接入文档：铸造、天选、核验" : "Full docs: minting, the raffle, verification"}</Link>
        </p>
      </div>
    </>
  );
}

const agentLabel = (handle: string, wallet: string) => (handle ? `${handle}.ai` : `${wallet.slice(0, 6)}…${wallet.slice(-4)}`);

export default function Mine() {
  const { t, lang } = useT();
  const zh = lang === "zh";
  const mining = useMining();
  if (!deployment) return <div className="wrap notice">No deployment for this chain.</div>;

  return (
    <div className="wrap">
      <section className="sec" style={{ paddingTop: 56 }}>
        <SecHead
          no="一"
          h={zh ? "让你的 .ai 智能体铸造" : "Mint with your .ai agent"}
          p={zh ? "选好金额，复制指令，交给你的币安智能体。网站不连接钱包，只有持有 .ai Agent ID 的智能体能铸造。" : "Pick an amount, copy the prompt, hand it to your Binance agent. This site never connects a wallet; only agents holding a .ai Agent ID can mint."}
        />
        <PromptBuilder />
      </section>

      <section className="sec">
        <SecHead no="二" h={zh ? "第一次？三步" : "First time? Three steps"} />
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
                  {mining.rows.length === 0 ? <tr><td colSpan={5} className="empty">{mining.loading ? t("loading") : t("none")}</td></tr> : null}
                  {mining.rows.slice(0, 50).map((r, i) => (
                    <tr key={r.agent}>
                      <td className="mono">{i + 1}</td>
                      <td><Link to={`/agent/${r.handle ? `${r.handle}.ai` : r.agent}`} className="mono">{agentLabel(r.handle, r.agent)}</Link></td>
                      <td className="num">{compact(r.total)}</td>
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
                  {mining.feed.length === 0 ? <tr><td colSpan={4} className="empty">{mining.loading ? t("loading") : t("none")}</td></tr> : null}
                  {mining.feed.map((e) => (
                    <tr key={e.tx + e.agent}>
                      <td><Link to={`/agent/${e.handle ? `${e.handle}.ai` : e.agent}`} className="mono">{agentLabel(e.handle, e.agent)}</Link></td>
                      <td className="num">{fmt(e.wei, 18, 4)}</td>
                      <td className="num">{compact(e.total)}</td>
                      <td><Addr a={e.tx} n={4} kind="tx" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
