import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useT } from "../i18n";
import { useGatewayAgent, useMining } from "../hooks";
import { fmt, compact, GATEWAY } from "../chain";
import { SecHead, Stat, Addr, Tier } from "../components/Bits";

export default function Agent() {
  const { t, lang } = useT();
  const zh = lang === "zh";
  const { id } = useParams();
  const nav = useNavigate();
  const [q, setQ] = useState(id ?? "");
  const a = useGatewayAgent(id);
  const mining = useMining(id);
  const d = a.data;
  const go = () => {
    const v = q.trim().toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(v) || /^[a-z0-9]{1,64}(\.ai)?$/.test(v)) nav(`/agent/${v}`);
  };

  return (
    <div className="wrap">
      <section className="sec" style={{ paddingTop: 56 }}>
        <SecHead no="一" h={t("agent_h")} p={zh ? "按 .ai 名称或钱包地址查询任一智能体的铸造、额度与等级。" : "Look up any agent's mints, credit and tier by .ai name or wallet."} />
        <form onSubmit={(e) => { e.preventDefault(); go(); }} style={{ display: "flex", gap: 10, maxWidth: 480 }}>
          <div className="field" style={{ flex: 1, marginBottom: 0 }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("a_lookup")} />
          </div>
          <button className="btn" type="submit">→</button>
        </form>
      </section>

      {id ? (
        <>
          <section className="sec" style={{ paddingTop: 40 }}>
            {a.isLoading ? <p className="empty">{t("loading")}</p> : null}
            {a.isError ? <p className="notice">{GATEWAY ? (zh ? "没有找到这个 .ai 名称或地址。" : "No such .ai name or address.") : t("no_gateway")}</p> : null}
            {d ? (
              <>
                <div className="agent-id">
                  {d.handle ?? `${d.wallet.slice(0, 6)}…${d.wallet.slice(-4)}`}
                  <small>{d.isAgent ? ".ai Agent ID" : zh ? "无 Agent ID" : "no Agent ID"}</small>
                </div>
                <p className="hint" style={{ marginTop: -16, marginBottom: 24 }}><Addr a={d.wallet} n={8} /></p>
                <div className="strip">
                  <Stat l={t("a_mined")} v={compact(BigInt(d.minedBy))} u="YAN" />
                  <Stat l={zh ? "本纪元剩余" : "Left this epoch"} v={d.remainingThisEpoch === null ? "∞" : compact(BigInt(d.remainingThisEpoch))} u="YAN" />
                  <Stat l={t("a_credit")} v={fmt(BigInt(d.creditUsd18), 18, 2)} u="USD" />
                  <Stat l={t("a_balance")} v={fmt(BigInt(d.balanceUsd18), 18, 2)} u="USD" />
                  <Stat l={t("a_staked")} v={compact(BigInt(d.staked))} u="YAN" />
                  <Stat l={t("a_tier")} v={<Tier name={d.tier} />} u={`-${d.discountBps / 100}% · ${d.rpm}/min`} />
                </div>
              </>
            ) : null}
          </section>

          <section className="sec">
            <div className="g2" style={{ alignItems: "start" }}>
              <div>
                <SecHead no="二" h={t("feed_h")} />
                <div className="tbl-wrap">
                  <table>
                    <thead><tr><th>{t("f_block")}</th><th className="num">BNB</th><th className="num">{t("f_usd")}</th><th className="num">{t("f_tokens")}</th><th>{t("f_tx")}</th></tr></thead>
                    <tbody>
                      {mining.feed.length === 0 ? <tr><td colSpan={5} className="empty">{mining.loading ? t("loading") : t("none")}</td></tr> : null}
                      {mining.feed.slice(0, 40).map((e) => (
                        <tr key={e.tx}>
                          <td className="mono">{e.block.toString()}</td>
                          <td className="num">{fmt(e.wei, 18, 4)}</td>
                          <td className="num">{fmt(e.usd, 18, 2)}</td>
                          <td className="num">{compact(e.tokens)}</td>
                          <td><Addr a={e.tx} n={4} kind="tx" /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div>
                <SecHead no="三" h={t("a_usage")} />
                <div className="tbl-wrap">
                  <table>
                    <thead><tr><th>{zh ? "时间" : "Time"}</th><th>{zh ? "模型" : "Model"}</th><th className="num">in</th><th className="num">out</th><th className="num">USD</th></tr></thead>
                    <tbody>
                      {!d?.recent?.length ? <tr><td colSpan={5} className="empty">{t("none")}</td></tr> : null}
                      {d?.recent?.map((u, i) => (
                        <tr key={i}>
                          <td className="mono nowrap">{new Date(u.createdAt).toISOString().slice(5, 16).replace("T", " ")}</td>
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
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
