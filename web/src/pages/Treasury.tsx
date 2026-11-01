import { useT } from "../i18n";
import { useProtocol, useBurnLogs } from "../hooks";
import { deployment, fmt, compact } from "../chain";
import { SecHead, Stat, Addr } from "../components/Bits";

export default function Treasury() {
  const { t, lang } = useT();
  const p = useProtocol();
  const burns = useBurnLogs();
  const d = deployment!;
  const burnedTotal = p.totalMinted !== undefined && p.totalSupply !== undefined ? p.totalMinted - p.totalSupply : undefined;
  const dec = p.stableDecimals;
  return (
    <div className="wrap">
      <section className="sec" style={{ paddingTop: 56 }}>
        <SecHead no="一" h={t("tr_h")} p={t("tr_p")} />
        <div className="strip">
          <Stat l={t("tr_ops")} v={fmt(p.opsBalance, dec, 2)} u={p.stableSymbol} />
          <Stat l={t("tr_burner")} v={fmt(p.burnerBalance, dec, 2)} u={p.stableSymbol} />
          <Stat l={t("tr_spent")} v={fmt(p.stableSpent, dec, 2)} u={p.stableSymbol} />
          <Stat l={t("tr_burned")} v={compact(burnedTotal)} u="YAN" />
          <Stat l={lang === "zh" ? "回购销毁" : "Via buyback"} v={compact(p.burnedByBuyback)} u="YAN" />
          <Stat l={lang === "zh" ? "兑换销毁" : "Via redeem"} v={compact(p.totalRedeemed)} u="YAN" />
        </div>
      </section>

      <section className="sec">
        <div className="g2" style={{ alignItems: "start" }}>
          <div>
            <SecHead no="二" h={lang === "zh" ? "地址" : "Addresses"} />
            <table>
              <tbody>
                <tr><td>{lang === "zh" ? "运营金库" : "Ops treasury"}</td><td><Addr a={d.opsTreasury} n={8} /></td></tr>
                <tr><td>{t("c_burner")}</td><td><Addr a={d.burner} n={8} /></td></tr>
                <tr><td>{t("c_stable")}</td><td><Addr a={d.stable} n={8} /></td></tr>
                <tr><td>PancakeSwap Router</td><td><Addr a={d.router} n={8} /></td></tr>
              </tbody>
            </table>
            <p className="hint" style={{ marginTop: 16, maxWidth: "60ch" }}>
              {lang === "zh"
                ? "运营金库支付模型账单，是协议唯一的成本中心。销毁合约里的稳定币除了买回并销毁 YAN 之外没有任何提取路径。"
                : "The ops treasury pays model bills and is the protocol's only cost centre. Stablecoin in the burner has no withdrawal path except buying and burning YAN."}
            </p>
          </div>
          <div>
            <SecHead no="三" h={lang === "zh" ? "销毁记录" : "Burn history"} />
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>{t("f_block")}</th><th className="num">{p.stableSymbol}</th><th className="num">YAN</th><th>{t("f_tx")}</th></tr></thead>
                <tbody>
                  {!burns.data?.length ? <tr><td colSpan={4} className="empty">{burns.isLoading ? t("loading") : t("none")}</td></tr> : null}
                  {[...(burns.data ?? [])].reverse().map((b) => (
                    <tr key={b.tx}>
                      <td className="mono">{b.block.toString()}</td>
                      <td className="num">{fmt(b.stableIn, dec, 2)}</td>
                      <td className="num">{fmt(b.tokens, 18, 0)}</td>
                      <td><Addr a={b.tx} n={4} kind="tx" /></td>
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
