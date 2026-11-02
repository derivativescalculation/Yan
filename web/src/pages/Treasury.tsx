import { Link } from "react-router-dom";
import { useT } from "../i18n";
import { useProtocol } from "../hooks";
import { deployment, fmt, compact } from "../chain";
import { SecHead, Stat, Addr } from "../components/Bits";

export default function Treasury() {
  const { t, lang } = useT();
  const zh = lang === "zh";
  const p = useProtocol();
  const d = deployment!;
  return (
    <div className="wrap">
      <section className="sec" style={{ paddingTop: 56 }}>
        <SecHead no="一" h={t("tr_h")} p={t("tr_p")} />
        <div className="strip">
          <Stat l={t("tr_received")} v={fmt(p.totalWeiPaid, 18, 4)} u="BNB" />
          <Stat l={t("tr_treasury")} v={fmt(p.treasuryBalance, 18, 4)} u="BNB" />
          <Stat l={t("tr_vault")} v={compact(p.vaultBalance)} u="YAN" />
          <Stat l={t("tr_pots")} v={compact(p.raffleBalance)} u="YAN" />
          <Stat l={t("tr_paid_out")} v={compact(p.rafflePaidOut)} u="YAN" />
          <Stat l={t("s_minted")} v={compact(p.totalMinted)} u="YAN" />
        </div>
      </section>

      <section className="sec">
        <div className="g2" style={{ alignItems: "start" }}>
          <div>
            <SecHead no="二" h={zh ? "地址" : "Addresses"} />
            <table>
              <tbody>
                <tr><td>{zh ? "项目金库" : "Treasury"}</td><td><Addr a={d.treasury} n={8} /></td></tr>
                <tr><td>{t("c_vault")}</td><td><Addr a={d.liquidityVault} n={8} /></td></tr>
                <tr><td>{t("c_raffle")}</td><td><Addr a={d.raffle} n={8} /></td></tr>
                <tr><td>{t("c_pair")}</td><td><Addr a={d.pair} n={8} /></td></tr>
                <tr><td>{t("c_stable")}</td><td><Addr a={d.priceFeed} n={8} /></td></tr>
                <tr><td>Chainlink VRF</td><td><Addr a={d.vrfCoordinator} n={8} /></td></tr>
              </tbody>
            </table>
          </div>
          <div>
            <SecHead no="三" h={zh ? "去向" : "Where it goes"} />
            <div className="kvl">
              <div><span>{zh ? "BNB" : "BNB"}</span><b>{zh ? "100% 进入项目金库" : "100% to the treasury"}</b></div>
              <div><span>{zh ? "YAN · 智能体" : "YAN · agent"}</span><b>70%</b></div>
              <div><span>{zh ? "YAN · 流动性金库" : "YAN · liquidity vault"}</span><b>25%</b></div>
              <div><span>{zh ? "YAN · 天选三器" : "YAN · raffle vessels"}</span><b>5%</b></div>
              <div><span>{zh ? "卖出税" : "Sell tax"}</span><b>{zh ? "0.5% YAN 入天选" : "0.5% YAN to the raffle"}</b></div>
            </div>
            <p className="hint" style={{ marginTop: 16, maxWidth: "60ch" }}>
              {zh
                ? "每次铸造在同一笔交易里完成拆分。流动性金库里的 YAN 只能添加为 PancakeSwap 流动性，LP 直接销毁；天选三器里的 YAN 只能作为奖金派给中签者。所有者只能暂停铸造，两处都碰不到。"
                : "Every mint is split in the same transaction. YAN in the liquidity vault can only become PancakeSwap liquidity, with the LP burned; YAN in the raffle vessels can only leave as prizes. The owner can only pause minting and cannot touch either."}
            </p>
            <p className="hint"><Link to="/raffle">{zh ? "看三器与金榜 →" : "See the vessels and winners →"}</Link></p>
          </div>
        </div>
      </section>
    </div>
  );
}
