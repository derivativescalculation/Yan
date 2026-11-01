import { NavLink, Link } from "react-router-dom";
import { useAccount, useConnect, useDisconnect, useBlockNumber } from "wagmi";
import { useProtocol } from "../hooks";
import { fmt, compact } from "../chain";
import type { ReactNode } from "react";
import { useT } from "../i18n";
import { short, deployment, explorer, CHAIN_ID } from "../chain";

export function Seal({ size = 28 }: { size?: number }) {
  return <img className="seal" src="/seal.svg" width={size} height={size} alt="衍算" />;
}

function Wallet() {
  const { t } = useT();
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  if (isConnected && address)
    return (
      <button className="btn ghost" onClick={() => disconnect()} title={t("disconnect")}>
        <span className="live" />
        <span className="mono">{short(address)}</span>
      </button>
    );
  return (
    <button className="btn" disabled={isPending} onClick={() => connect({ connector: connectors[0] })}>
      {t("connect")}
    </button>
  );
}

function Ticker() {
  const { t } = useT();
  const p = useProtocol();
  const bn = useBlockNumber({ watch: true });
  const chainName = CHAIN_ID === 56 ? "BNB Chain" : CHAIN_ID === 97 ? "BSC Testnet" : `chain ${CHAIN_ID}`;
  return (
    <div className="ticker">
      <div className="wrap">
        <span><span className="live" />{chainName}</span>
        <span>BLOCK <b>{bn.data?.toString() ?? "—"}</b></span>
        <span>{t("s_epoch").toUpperCase()} <b>{p.currentEpoch?.toString() ?? "—"} / 10</b></span>
        <span>{t("s_rate").toUpperCase()} <b>{fmt(p.tokensPerUsd, 18, 0)}</b> YAN/USD</span>
        <span>{t("s_minted").toUpperCase()} <b>{compact(p.totalMinted)}</b> YAN</span>
        <span>{t("s_paid").toUpperCase()} <b>{fmt(p.totalUsdPaid, 18, 0)}</b> USD</span>
        <span>{t("s_agents").toUpperCase()} <b>{p.agentCount?.toString() ?? "—"}</b></span>
      </div>
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { t, lang, setLang } = useT();
  const nav = [
    ["/", t("nav_protocol")],
    ["/mine", t("nav_mine")],
    ["/agent", t("nav_agents")],
    ["/treasury", t("nav_treasury")],
    ["/docs", t("nav_docs")],
  ] as const;
  return (
    <>
      <header className="top">
        <div className="wrap">
          <Link to="/" className="brand">
            <Seal />
            衍算<small>YAN</small>
          </Link>
          <nav className="nav">
            {nav.map(([to, label]) => (
              <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => (isActive ? "on" : "")}>
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="right">
            <button className="lang" onClick={() => setLang(lang === "zh" ? "en" : "zh")}>
              {lang === "zh" ? <><b>中</b> / EN</> : <>中 / <b>EN</b></>}
            </button>
            <Wallet />
          </div>
        </div>
      </header>
      {deployment ? <Ticker /> : null}
      <main>{children}</main>
      <footer className="foot">
        <div className="mark" aria-hidden>衍算</div>
        <div className="wrap">
          <div>
            <div className="brand">
              <Seal /> 衍算
            </div>
            <p style={{ marginTop: 12, color: "var(--ink-3)", fontSize: 12, letterSpacing: "0.1em" }} className="mono">
              {t("foot_tag")}
            </p>
            <p className="mono" style={{ marginTop: 8, fontSize: 12, color: "var(--ink-3)" }}>
              chain {CHAIN_ID}
              {deployment && explorer ? (
                <>
                  {" · "}
                  <a href={`${explorer}/address/${deployment.token}`} target="_blank" rel="noreferrer" style={{ display: "inline" }}>
                    {short(deployment.token, 6)}
                  </a>
                </>
              ) : null}
            </p>
          </div>
          <div>
            <h4>{t("foot_proto")}</h4>
            <Link to="/">{t("nav_protocol")}</Link>
            <Link to="/mine">{t("nav_mine")}</Link>
            <Link to="/treasury">{t("nav_treasury")}</Link>
          </div>
          <div>
            <h4>{t("foot_build")}</h4>
            <Link to="/docs">{t("nav_docs")}</Link>
            <a href="https://github.com" target="_blank" rel="noreferrer">GitHub</a>
            <a href="https://bnbchain.org/en/bnb-agent-studio" target="_blank" rel="noreferrer">BNB Agent Studio</a>
          </div>
          <div>
            <h4>{t("foot_social")}</h4>
            <a href="https://x.com" target="_blank" rel="noreferrer">X</a>
          </div>
          <div className="legal">
            <span className="mono">yansuan.ai</span>
            <span>© 2026 衍算</span>
          </div>
        </div>
      </footer>
    </>
  );
}
