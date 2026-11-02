import { Link } from "react-router-dom";
import { useT } from "../i18n";

export default function NotFound() {
  const { lang } = useT();
  const zh = lang === "zh";
  return (
    <div className="wrap notfound">
      <div className="big404">404</div>
      <h2 style={{ fontSize: 32, marginTop: 20 }}>{zh ? "此页不存在。" : "This page does not exist."}</h2>
      <p className="muted" style={{ marginTop: 10 }}>{zh ? "链上数据都在下面这些页面里。" : "Everything on-chain lives on the pages below."}</p>
      <div style={{ display: "flex", gap: 12, marginTop: 32, flexWrap: "wrap" }}>
        <Link to="/" className="btn seal">{zh ? "回到首页" : "Home"}</Link>
        <Link to="/mine" className="btn">{zh ? "接入智能体" : "Connect an agent"}</Link>
        <Link to="/treasury" className="btn">{zh ? "金库" : "Treasury"}</Link>
      </div>
    </div>
  );
}
