import { Link } from "react-router-dom";
import { useT } from "../i18n";
import { useProtocol } from "../hooks";
import { deployment, fmt, compact, E18, EPOCH } from "../chain";
import { SecHead, Stat, Addr } from "../components/Bits";

export default function Home() {
  const { t, lang } = useT();
  const p = useProtocol();
  const d = deployment;
  if (!d) return <div className="wrap notice">No deployment for this chain. Set VITE_CHAIN_ID.</div>;

  const epoch = Number(p.currentEpoch ?? 0n);
  const r0 = p.initialTokensPerUsd ?? 40_000n * E18;
  const burned = p.totalMinted !== undefined && p.totalSupply !== undefined ? p.totalMinted - p.totalSupply : undefined;
  const decay = p.decayBps ?? 7000n;
  const rows = Array.from({ length: 10 }, (_, i) => {
    let rate = r0;
    for (let k = 0; k < i; k++) rate = (rate * decay) / 10_000n;
    const cost = rate === 0n ? 0n : (EPOCH * E18) / rate;
    return { i, rate, cost, cum: EPOCH * BigInt(i + 1) };
  });
  const totalCost = rows.reduce((a, r) => a + r.cost, 0n);
  const zh = (a: string, b: string) => (lang === "zh" ? a : b);

  return (
    <>
      <div className="wrap">
        <section className="hero">
          <div className="vert">{t("hero_vert")}</div>
          <div>
            <h1>
              {t("hero_h1_a")}
              <br />
              <em>{t("hero_h1_b")}</em>
            </h1>
            <p className="lede">{t("hero_lede")}</p>
            <div className="cta">
              <Link to="/mine" className="btn seal">{t("hero_cta1")}</Link>
              <Link to="/docs" className="btn">{t("hero_cta2")}</Link>
            </div>
          </div>
          <aside className="side">
            <h3>
              <span className="live" />
              {t("side_title")} · {t("s_rate")}
            </h3>
            <div className="hero-rate">{fmt(p.tokensPerUsd, 18, 0)}<small>{t("s_rate_u")}</small></div>
            <div className="hero-sub">{zh("纪元", "epoch")} {p.loading ? "…" : epoch} / 10 · {zh("下一纪元", "next")} {fmt(rows[Math.min(epoch + 1, 9)].rate, 18, 0)}</div>
            <div className="kv"><span>{t("s_minted")}</span><b>{compact(p.totalMinted)} YAN</b></div>
            <div className="kv"><span>{t("s_paid")}</span><b>{fmt(p.totalUsdPaid, 18, 2)} USD</b></div>
            <div className="kv"><span>{t("s_agents")}</span><b>{p.agentCount?.toString() ?? "—"}</b></div>
            <div className="kv"><span>{t("s_burned")}</span><b>{compact(burned)} YAN</b></div>
          </aside>
        </section>

        <div className="strip">
          <Stat l={t("s_epoch")} v={p.loading ? "…" : epoch} u="/ 10" />
          <Stat l={t("s_rate")} v={fmt(p.tokensPerUsd, 18, 0)} u={t("s_rate_u")} />
          <Stat l={t("s_minted")} v={compact(p.totalMinted)} u="YAN" />
          <Stat l={t("s_paid")} v={fmt(p.totalUsdPaid, 18, 0)} u="USD" />
          <Stat l={t("s_staked")} v={compact(p.totalStaked)} u="YAN" />
          <Stat l={t("s_burned")} v={compact(burned)} u="YAN" />
        </div>

        <section className="sec">
          <SecHead no={t("sec1_no")} h={t("sec1_h")} p={t("sec1_p")} />
          <div className="g3">
            <div><div className="no">{zh("壹", "I")}</div><h3>{t("m1_h")}</h3><p>{t("m1_p")}</p></div>
            <div><div className="no">{zh("贰", "II")}</div><h3>{t("m2_h")}</h3><p>{t("m2_p")}</p></div>
            <div><div className="no">{zh("叁", "III")}</div><h3>{t("m3_h")}</h3><p>{t("m3_p")}</p></div>
          </div>
        </section>

        <section className="sec">
          <SecHead no={t("sec2_no")} h={t("sec2_h")} p={t("sec2_p")} />
          <div className="g2">
            <div>
              <div className="emis">
                {rows.map((r) => {
                  const h = Math.max(6, (100 * Number(r.rate / E18)) / Number(r0 / E18));
                  const cls = r.i < epoch ? "done" : r.i === epoch ? "on" : "";
                  return (
                    <div key={r.i} className={cls} style={{ height: `${h}%` }}>
                      <i>{compact(r.rate)}</i>
                    </div>
                  );
                })}
              </div>
              <div className="emis-x">{rows.map((r) => <span key={r.i}>{r.i}</span>)}</div>
              <p className="emis-note">
                {zh(
                  `每个纪元一亿枚。纪元 0 每美元铸 ${fmt(r0, 18, 0)} 枚，之后每个纪元下调 ${100 - Number(decay) / 100}%。把十亿枚全部铸完需要约 ${fmt(totalCost, 18, 0)} 美元的真实推理支出，没有其它来源。`,
                  `100M per epoch. Epoch 0 mints ${fmt(r0, 18, 0)} per dollar, then the rate steps down ${100 - Number(decay) / 100}% each epoch. Minting all 1B takes about ${fmt(totalCost, 18, 0)} USD of real inference spend, from no other source.`,
                )}
              </p>
            </div>
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t("e_epoch")}</th>
                    <th className="num">{t("e_rate")}</th>
                    <th className="num">{t("e_cost")}</th>
                    <th className="num">{t("e_cum")}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.i}>
                      <td className="mono">{r.i}</td>
                      <td className="num">{fmt(r.rate, 18, 0)}</td>
                      <td className="num">{fmt(r.cost, 18, 0)} USD</td>
                      <td className="num">{compact(r.cum)}</td>
                      <td>
                        {r.i < epoch ? <span className="tag">{t("epoch_done")}</span> : r.i === epoch ? <span className="tag seal">{t("epoch_on")}</span> : <span className="muted tag">{t("epoch_todo")}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="sec">
          <SecHead no={t("sec3_no")} h={t("sec3_h")} p={t("sec3_p")} />
          <div className="g3">
            <div><div className="no">{zh("壹", "I")}</div><h3>{t("u1_h")}</h3><p>{t("u1_p")}</p></div>
            <div><div className="no">{zh("贰", "II")}</div><h3>{t("u2_h")}</h3><p>{t("u2_p")}</p></div>
            <div><div className="no">{zh("叁", "III")}</div><h3>{t("u3_h")}</h3><p>{t("u3_p")}</p></div>
          </div>
        </section>

        <section className="sec">
          <SecHead no={t("sec4_no")} h={t("sec4_h")} p={t("sec4_p")} />
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr><th>{t("c_name")}</th><th>{t("c_addr")}</th><th>{t("c_note")}</th></tr>
              </thead>
              <tbody>
                <tr><td>{t("c_token")} · YAN</td><td><Addr a={d.token} n={8} /></td><td className="muted">{t("c_token_n")}</td></tr>
                <tr><td>{t("c_poi")}</td><td><Addr a={d.proofOfInference} n={8} /></td><td className="muted">{t("c_poi_n")}</td></tr>
                <tr><td>{t("c_burner")}</td><td><Addr a={d.burner} n={8} /></td><td className="muted">{t("c_burner_n")}</td></tr>
                <tr><td>{t("c_stake")}</td><td><Addr a={d.stake} n={8} /></td><td className="muted">{t("c_stake_n")}</td></tr>
                <tr><td>{t("c_stable")}</td><td><Addr a={d.priceFeed} n={8} /></td><td className="muted">burn {Number(p.burnBps ?? 0n) / 100}% · redeem {Number(p.redeemBps ?? 0n) / 100}%</td></tr>
                <tr><td>{t("c_registry")}</td><td><Addr a={d.agentIds} n={8} /></td><td className="muted">SPACE ID Agent ID · soulbound</td></tr>
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </>
  );
}
