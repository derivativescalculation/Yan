import { useState } from "react";
import { Link } from "react-router-dom";
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { parseUnits } from "viem";
import { useT } from "../i18n";
import { useMinedLogs, useProtocol, leaderboard } from "../hooks";
import { deployment, poiAbi, erc20Abi, tokenAbi, stakeAbi, fmt, compact } from "../chain";
import { SecHead, Addr, Panel } from "../components/Bits";

function useTx() {
  const w = useWriteContract();
  const rc = useWaitForTransactionReceipt({ hash: w.data });
  return { ...w, receipt: rc, busy: w.isPending || rc.isLoading };
}

function MinePanel() {
  const { t, lang } = useT();
  const d = deployment!;
  const p = useProtocol();
  const { address } = useAccount();
  const [agentId, setAgentId] = useState("");
  const [usd, setUsd] = useState("10");
  const amount = (() => { try { return parseUnits(usd || "0", p.stableDecimals); } catch { return 0n; } })();
  const id = /^\d+$/.test(agentId) ? BigInt(agentId) : undefined;

  const quote = useReadContract({ address: d.proofOfInference, abi: poiAbi, functionName: "quote", args: [amount], query: { enabled: amount > 0n } });
  const isOp = useReadContract({ address: d.proofOfInference, abi: poiAbi, functionName: "isOperator", args: [id ?? 0n, address ?? "0x0000000000000000000000000000000000000000"], query: { enabled: id !== undefined && !!address } });
  const allowance = useReadContract({ address: d.stable, abi: erc20Abi, functionName: "allowance", args: [address ?? "0x0000000000000000000000000000000000000000", d.proofOfInference], query: { enabled: !!address, refetchInterval: 5000 } });
  const bal = useReadContract({ address: d.stable, abi: erc20Abi, functionName: "balanceOf", args: [address ?? "0x0000000000000000000000000000000000000000"], query: { enabled: !!address, refetchInterval: 5000 } });

  const approve = useTx();
  const mine = useTx();
  const needApprove = (allowance.data as bigint | undefined ?? 0n) < amount;
  const can = !!address && id !== undefined && amount > 0n && isOp.data === true;

  return (
    <Panel h={t("mine_panel_h")} m={p.stableSymbol}>
      <p className="hint" style={{ marginBottom: 14 }}>{t("mine_panel_p")}</p>
      <div className="field">
        <label>{t("agent_id")}</label>
        <input value={agentId} onChange={(e) => setAgentId(e.target.value.trim())} placeholder="364913" inputMode="numeric" />
        {id !== undefined && address && isOp.data === false ? <span className="err">not an operator of agent {agentId}</span> : null}
      </div>
      <div className="field">
        <label>{t("quote_amt")}</label>
        <input value={usd} onChange={(e) => setUsd(e.target.value)} placeholder="10" inputMode="decimal" />
        <span className="hint">
          {t("quote_out")}: <b className="mono">{fmt(quote.data as bigint | undefined, 18, 0)} YAN</b>
          {address ? <> · balance {fmt(bal.data as bigint | undefined, p.stableDecimals, 2)} {p.stableSymbol}</> : null}
          {p.costToCap !== undefined && amount > 0n && amount * (10n ** 18n) / (10n ** BigInt(p.stableDecimals)) > p.costToCap ? (
            <> · <span className="err">{lang === "zh" ? "超过剩余可铸造量，多付部分不会铸造" : "exceeds cost to cap; the excess mints nothing"}</span></>
          ) : null}
        </span>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {!address ? <span className="hint">{t("need_wallet")}</span> : null}
        {needApprove ? (
          <button className="btn" disabled={!can || approve.busy} onClick={() => approve.writeContract({ address: d.stable, abi: erc20Abi, functionName: "approve", args: [d.proofOfInference, amount] })}>
            {t("approve")} {usd} {p.stableSymbol}
          </button>
        ) : null}
        <button className="btn seal" disabled={!can || needApprove || mine.busy} onClick={() => mine.writeContract({ address: d.proofOfInference, abi: poiAbi, functionName: "mine", args: [id!, amount] })}>
          {t("mine_btn")}
        </button>
      </div>
      {approve.error ? <p className="err" style={{ marginTop: 10 }}>{(approve.error as any).shortMessage ?? approve.error.message}</p> : null}
      {mine.error ? <p className="err" style={{ marginTop: 10 }}>{(mine.error as any).shortMessage ?? mine.error.message}</p> : null}
      {mine.receipt.data ? <p className="ok" style={{ marginTop: 10 }}>mined · <Addr a={mine.receipt.data.transactionHash} kind="tx" /></p> : null}
    </Panel>
  );
}

function RedeemStakePanel() {
  const { t, lang } = useT();
  const d = deployment!;
  const { address } = useAccount();
  const [agentId, setAgentId] = useState("");
  const [tokens, setTokens] = useState("100000");
  const id = /^\d+$/.test(agentId) ? BigInt(agentId) : undefined;
  const amount = (() => { try { return parseUnits(tokens || "0", 18); } catch { return 0n; } })();
  const q = useReadContract({ address: d.proofOfInference, abi: poiAbi, functionName: "quoteRedeem", args: [amount], query: { enabled: amount > 0n } });
  const allowPoi = useReadContract({ address: d.token, abi: tokenAbi, functionName: "allowance", args: [address ?? "0x0000000000000000000000000000000000000000", d.proofOfInference], query: { enabled: !!address, refetchInterval: 5000 } });
  const allowStake = useReadContract({ address: d.token, abi: tokenAbi, functionName: "allowance", args: [address ?? "0x0000000000000000000000000000000000000000", d.stake], query: { enabled: !!address, refetchInterval: 5000 } });
  const yan = useReadContract({ address: d.token, abi: tokenAbi, functionName: "balanceOf", args: [address ?? "0x0000000000000000000000000000000000000000"], query: { enabled: !!address, refetchInterval: 5000 } });
  const ap = useTx(); const rd = useTx(); const as = useTx(); const st = useTx();
  const can = !!address && id !== undefined && amount > 0n;
  return (
    <Panel h={lang === "zh" ? "兑换与质押" : "Redeem and stake"} m="YAN">
      <div className="field"><label>{t("agent_id")}</label><input value={agentId} onChange={(e) => setAgentId(e.target.value.trim())} inputMode="numeric" /></div>
      <div className="field">
        <label>YAN</label>
        <input value={tokens} onChange={(e) => setTokens(e.target.value)} inputMode="decimal" />
        <span className="hint">
          {lang === "zh" ? "兑换额度" : "Redeem credit"}: <b className="mono">{fmt(q.data as bigint | undefined, 18, 4)} USD</b>
          {address ? <> · {fmt(yan.data as bigint | undefined, 18, 0)} YAN</> : null}
        </span>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {((allowPoi.data as bigint | undefined) ?? 0n) < amount ? (
          <button className="btn ghost" disabled={!can || ap.busy} onClick={() => ap.writeContract({ address: d.token, abi: tokenAbi, functionName: "approve", args: [d.proofOfInference, amount] })}>{t("approve")} · redeem</button>
        ) : (
          <button className="btn" disabled={!can || rd.busy} onClick={() => rd.writeContract({ address: d.proofOfInference, abi: poiAbi, functionName: "redeem", args: [id!, amount] })}>{lang === "zh" ? "销毁换算力" : "Redeem"}</button>
        )}
        {((allowStake.data as bigint | undefined) ?? 0n) < amount ? (
          <button className="btn ghost" disabled={!can || as.busy} onClick={() => as.writeContract({ address: d.token, abi: tokenAbi, functionName: "approve", args: [d.stake, amount] })}>{t("approve")} · stake</button>
        ) : (
          <button className="btn" disabled={!can || st.busy} onClick={() => st.writeContract({ address: d.stake, abi: stakeAbi, functionName: "stake", args: [id!, amount] })}>{lang === "zh" ? "质押" : "Stake"}</button>
        )}
      </div>
      {[ap, rd, as, st].map((x, i) => x.error ? <p key={i} className="err" style={{ marginTop: 10 }}>{(x.error as any).shortMessage ?? x.error.message}</p> : null)}
      {rd.receipt.data ? <p className="ok" style={{ marginTop: 10 }}>redeemed · <Addr a={rd.receipt.data.transactionHash} kind="tx" /></p> : null}
      {st.receipt.data ? <p className="ok" style={{ marginTop: 10 }}>staked · <Addr a={st.receipt.data.transactionHash} kind="tx" /></p> : null}
    </Panel>
  );
}

export default function Mine() {
  const { t } = useT();
  const logs = useMinedLogs();
  const events = logs.data ?? [];
  const lb = leaderboard(events);
  const feed = [...events].reverse().slice(0, 60);
  if (!deployment) return <div className="wrap notice">No deployment for this chain.</div>;

  return (
    <div className="wrap">
      <section className="sec" style={{ paddingTop: 56 }}>
        <SecHead no="一" h={t("mine_h")} p={t("mine_p")} />
        <div className="g2" style={{ alignItems: "start" }}>
          <MinePanel />
          <RedeemStakePanel />
        </div>
      </section>

      <section className="sec">
        <div className="g2" style={{ alignItems: "start" }}>
          <div>
            <SecHead no="二" h={t("nav_agents")} />
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>{t("lb_rank")}</th><th>{t("lb_agent")}</th><th className="num">{t("lb_mined")}</th><th className="num">{t("lb_paid")}</th><th className="num">{t("lb_txs")}</th></tr></thead>
                <tbody>
                  {lb.length === 0 ? <tr><td colSpan={5} className="empty">{logs.isLoading ? t("loading") : t("none")}</td></tr> : null}
                  {lb.slice(0, 50).map((r, i) => (
                    <tr key={r.agentId.toString()} className="rowlink">
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
            <SecHead no="三" h={t("feed_h")} />
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>{t("f_block")}</th><th>{t("f_agent")}</th><th className="num">{t("f_usd")}</th><th className="num">{t("f_tokens")}</th><th>{t("f_tx")}</th></tr></thead>
                <tbody>
                  {feed.length === 0 ? <tr><td colSpan={5} className="empty">{logs.isLoading ? t("loading") : t("none")}</td></tr> : null}
                  {feed.map((e) => (
                    <tr key={e.tx + e.agentId.toString()}>
                      <td className="mono">{e.block.toString()}</td>
                      <td><Link to={`/agent/${e.agentId}`} className="mono">#{e.agentId.toString()}</Link></td>
                      <td className="num">{fmt(e.usd, 18, 2)}</td>
                      <td className="num">{fmt(e.tokens, 18, 0)}</td>
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
