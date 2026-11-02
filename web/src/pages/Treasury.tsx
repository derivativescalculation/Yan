import { useT } from "../i18n";
import { useProtocol, useBurnLogs } from "../hooks";
import { deployment, fmt, compact } from "../chain";
import { SecHead, Stat, Addr } from "../components/Bits";

export default function Treasury() {
  const { t, lang } = useT();
  const zh = lang === "zh";
  const p = useProtocol();
  const burns = useBurnLogs();
  const d = deployment!;
  const burnedTotal = p.totalMinted !== undefined && p.totalSupply !== undefined ? p.totalMinted - p.totalSupply : undefined;
  return (
    <div className="wrap">
      <section className="sec" style={{ paddingTop: 56 }}>
        <SecHead no="一" h={t("tr_h")} p={t("tr_p")} />
        <div className="strip">
          <Stat l={zh ? "累计支付" : "Total paid"} v={fmt(p.totalWeiPaid, 18, 4)} u="BNB" />
          <Stat l={t("tr_ops")} v={fmt(p.opsBalance, 18, 4)} u="BNB" />
          <Stat l={t("tr_burner")} v={fmt(p.burnerBalance, 18, 4)} u="BNB" />
          <Stat l={t("tr_spent")} v={fmt(p.weiSpent, 18, 4)} u="BNB" />
          <Stat l={t("tr_burned")} v={compact(burnedTotal)} u="YAN" />
          <Stat l={zh ? "兑换销毁" : "Via redeem"} v={compact(p.totalRedeemed)} u="YAN" />
        </div>
      </section>

      <section className="sec">
        <div className="g2" style={{ alignItems: "start" }}>
          <div>
            <SecHead no="二" h={zh ? "地址" : "Addresses"} />
            <table>
              <tbody>
                <tr><td>{zh ? "运营金库" : "Ops treasury"}</td><td><Addr a={d.opsTreasury} n={8} /></td></tr>
                <tr><td>{t("c_burner")}</td><td><Addr a={d.burner} n={8} /></td></tr>
                <tr><td>{t("c_stable")}</td><td><Addr a={d.priceFeed} n={8} /></td></tr>
                <tr><td>PancakeSwap Router</td><td><Addr a={d.router} n={8} /></td></tr>
              </tbody>
            </table>
            <p className="hint" style={{ marginTop: 16, maxWidth: "60ch" }}>
              {zh
                ? "每笔支付在同一笔交易里拆分：八成进入运营金库支付模型账单，两成进入销毁合约。销毁合约里的 BNB 除了在 PancakeSwap 买回并销毁 YAN 之外没有任何提取路径。"
                : "Every payment is split in the same transaction: 80% to the ops treasury for model bills, 20% to the burner. BNB in the burner has no exit except buying YAN on PancakeSwap and burning it."}
            </p>
          </div>
          <div>
            <SecHead no="三" h={zh ? "销毁记录" : "Burn history"} />
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>{t("f_block")}</th><th className="num">BNB</th><th className="num">YAN</th><th>{t("f_tx")}</th></tr></thead>
                <tbody>
                  {!burns.data?.length ? <tr><td colSpan={4} className="empty">{burns.isLoading ? t("loading") : t("none")}</td></tr> : null}
                  {[...(burns.data ?? [])].reverse().map((b) => (
                    <tr key={b.tx}>
                      <td className="mono">{b.block.toString()}</td>
                      <td className="num">{fmt(b.weiIn, 18, 4)}</td>
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
