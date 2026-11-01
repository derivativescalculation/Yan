import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useReadContracts } from "wagmi";
import { useT } from "../i18n";
import { useGatewayAgent, useMinedLogs } from "../hooks";
import { deployment, poiAbi, stakeAbi, fmt, compact, GATEWAY } from "../chain";
import { SecHead, Stat, Addr, Tier } from "../components/Bits";

export default function Agent() {
  const { t, lang } = useT();
  const { id } = useParams();
  const nav = useNavigate();
  const [q, setQ] = useState(id ?? "");
  const d = deployment!;
  const agentId = id && /^\d+$/.test(id) ? BigInt(id) : undefined;
  const poi = { address: d.proofOfInference, abi: poiAbi } as const;
  const chain = useReadContracts({
    contracts: [
      { ...poi, functionName: "creditsUsd", args: [agentId ?? 0n] },
      { ...poi, functionName: "minedByAgent", args: [agentId ?? 0n] },
      { ...poi, functionName: "redeemedByAgent", args: [agentId ?? 0n] },
      { address: d.stake, abi: stakeAbi, functionName: "staked", args: [agentId ?? 0n] },
    ],
    query: { enabled: agentId !== undefined },
  });
  const r = (i: number) => chain.data?.[i]?.result as bigint | undefined;
  const gw = useGatewayAgent(id);
  const logs = useMinedLogs();
  const mine = (logs.data ?? []).filter((e) => agentId !== undefined && e.agentId === agentId).reverse();

  return (
    <div className="wrap">
      <section className="sec" style={{ paddingTop: 56 }}>
        <SecHead no="一" h={t("agent_h")} />
        <form
          onSubmit={(e) => { e.preventDefault(); if (/^\d+$/.test(q)) nav(`/agent/${q}`); }}
          style={{ display: "flex", gap: 10, maxWidth: 420 }}
        >
          <div className="field" style={{ flex: 1, marginBottom: 0 }}>
            <input value={q} onChange={(e) => setQ(e.target.value.trim())} placeholder={t("a_lookup")} inputMode="numeric" />
          </div>
          <button className="btn" type="submit">→</button>
        </form>
      </section>

      {agentId !== undefined ? (
        <>
          <section className="sec" style={{ paddingTop: 40 }}>
            <div className="agent-id">#{agentId.toString()}<small>ERC-8004</small></div>
            <div className="strip">
              <Stat l={t("a_credit")} v={fmt(r(0), 18, 2)} u="USD" />
              <Stat l={t("a_used")} v={gw.data ? fmt(BigInt(gw.data.usedUsd18), 18, 2) : "—"} u="USD" />
              <Stat l={t("a_balance")} v={gw.data ? fmt(BigInt(gw.data.balanceUsd18), 18, 2) : "—"} u="USD" />
              <Stat l={t("a_mined")} v={compact(r(1))} u="YAN" />
              <Stat l={t("a_staked")} v={compact(r(3))} u="YAN" />
              <Stat l={t("a_tier")} v={gw.data ? <Tier name={gw.data.tier} /> : "—"} u={gw.data ? `-${gw.data.discountBps / 100}% · ${gw.data.rpm}/min` : undefined} />
            </div>
            {!GATEWAY || gw.isError ? <p className="notice">{t("no_gateway")}</p> : null}
          </section>

          <section className="sec">
            <div className="g2" style={{ alignItems: "start" }}>
              <div>
                <SecHead no="二" h={t("a_usage")} />
                <div className="tbl-wrap">
                  <table>
                    <thead><tr><th>{lang === "zh" ? "时间" : "Time"}</th><th>{lang === "zh" ? "模型" : "Model"}</th><th className="num">in</th><th className="num">out</th><th className="num">USD</th></tr></thead>
                    <tbody>
                      {!gw.data?.recent?.length ? <tr><td colSpan={5} className="empty">{t("none")}</td></tr> : null}
                      {gw.data?.recent?.map((u, i) => (
                        <tr key={i}>
                          <td className="mono">{new Date(u.createdAt).toISOString().slice(0, 16).replace("T", " ")}</td>
                          <td className="mono">{u.model.replace("claude-", "")}</td>
                          <td className="num">{u.inputTokens.toLocaleString()}</td>
                          <td className="num">{u.outputTokens.toLocaleString()}</td>
                          <td className="num">{fmt(BigInt(u.costUsd18), 18, 4)}</td>
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
                    <thead><tr><th>{t("f_block")}</th><th>{lang === "zh" ? "矿工钱包" : "Miner"}</th><th className="num">{t("f_usd")}</th><th className="num">{t("f_tokens")}</th><th>{t("f_tx")}</th></tr></thead>
                    <tbody>
                      {mine.length === 0 ? <tr><td colSpan={5} className="empty">{t("none")}</td></tr> : null}
                      {mine.slice(0, 40).map((e) => (
                        <tr key={e.tx}>
                          <td className="mono">{e.block.toString()}</td>
                          <td><Addr a={e.miner} n={4} /></td>
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
        </>
      ) : null}
    </div>
  );
}
