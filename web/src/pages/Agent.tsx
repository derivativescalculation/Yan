import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useT } from "../i18n";
import { useGatewayAgent } from "../hooks";
import { fmt, compact, GATEWAY } from "../chain";
import { SecHead, Stat, Addr } from "../components/Bits";

const POT = { zh: ["青罐", "朱瓶", "金鼎"], en: ["Jade Jar", "Cinnabar Vase", "Gold Cauldron"] };

export default function Agent() {
  const { t, lang } = useT();
  const zh = lang === "zh";
  const { id } = useParams();
  const nav = useNavigate();
  const [q, setQ] = useState(id ?? "");
  const a = useGatewayAgent(id);
  const d = a.data;
  const go = () => {
    const v = q.trim().toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(v) || /^[a-z0-9-]{1,64}(\.ai)?$/.test(v)) nav(`/agent/${v}`);
  };

  return (
    <div className="wrap">
      <section className="sec" style={{ paddingTop: 56 }}>
        <SecHead no="一" h={t("agent_h")} p={zh ? "按 .ai 名称或钱包地址查询任一智能体的铸造、签数与中签记录。" : "Look up any agent's mints, tickets and wins by .ai name or wallet."} />
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
                  {d.handle ? `${d.handle}.ai` : `${d.wallet.slice(0, 6)}…${d.wallet.slice(-4)}`}
                  <small>{d.isAgent ? ".ai Agent ID" : zh ? "无 Agent ID" : "no Agent ID"}</small>
                </div>
                <p className="hint" style={{ marginTop: -16, marginBottom: 24 }}><Addr a={d.wallet} n={8} /></p>
                <div className="strip">
                  <Stat l={t("a_mined")} v={compact(BigInt(d.minedBy))} u="YAN" />
                  <Stat l={t("a_left")} v={d.remainingThisEpoch === null ? "∞" : compact(BigInt(d.remainingThisEpoch))} u="YAN" />
                  <Stat l={t("a_balance")} v={compact(BigInt(d.balance))} u="YAN" />
                  <Stat l={t("a_tickets")} v={fmt(BigInt(d.tickets), 0, 0)} u={`/ ${fmt(BigInt(d.totalTickets), 0, 0)}`} />
                  <Stat l={t("a_wins")} v={d.wins.length} u={zh ? "次" : ""} />
                </div>
                <p className="hint" style={{ marginTop: 14 }}>
                  {zh ? "每 10,000 YAN 一支签，按开器前一小时内的最低余额计算。" : "One ticket per 10,000 YAN, counted on the lowest balance in the hour before a draw."}{" "}
                  <Link to="/raffle">{zh ? "进入天选 →" : "Enter the raffle →"}</Link>
                </p>
              </>
            ) : null}
          </section>

          <section className="sec">
            <div className="g2" style={{ alignItems: "start" }}>
              <div>
                <SecHead no="二" h={t("feed_h")} />
                <div className="tbl-wrap">
                  <table>
                    <thead><tr><th>{t("f_block")}</th><th className="num">BNB</th><th className="num">{t("f_usd")}</th><th className="num">{zh ? "到账 YAN" : "YAN received"}</th><th>{t("f_tx")}</th></tr></thead>
                    <tbody>
                      {!d?.mints.length ? <tr><td colSpan={5} className="empty">{a.isLoading ? t("loading") : t("none")}</td></tr> : null}
                      {d?.mints.map((e) => (
                        <tr key={e.tx}>
                          <td className="mono">{e.block.toString()}</td>
                          <td className="num">{fmt(e.wei, 18, 4)}</td>
                          <td className="num">{fmt(e.usd, 18, 2)}</td>
                          <td className="num">{compact(e.toAgent)}</td>
                          <td><Addr a={e.tx} n={4} kind="tx" /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div>
                <SecHead no="三" h={t("a_wins_h")} />
                <div className="tbl-wrap">
                  <table>
                    <thead><tr><th>{zh ? "器" : "Vessel"}</th><th className="num">{zh ? "奖金" : "Prize"}</th><th className="num">{zh ? "中签号" : "Ticket"}</th><th>{t("f_tx")}</th></tr></thead>
                    <tbody>
                      {!d?.wins.length ? <tr><td colSpan={4} className="empty">{t("none")}</td></tr> : null}
                      {d?.wins.map((w) => (
                        <tr key={w.id}>
                          <td>{(zh ? POT.zh : POT.en)[w.pot]} · #{w.id}</td>
                          <td className="num">{compact(BigInt(w.prize))}</td>
                          <td className="num">{w.winningTicket} / {w.totalTickets}</td>
                          <td><Addr a={w.settleTx} n={4} kind="tx" /></td>
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
