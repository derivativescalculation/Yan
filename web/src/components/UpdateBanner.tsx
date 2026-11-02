import { useEffect, useState } from "react";
import { useT } from "../i18n";

/** Name of the entry bundle this page is running, e.g. "index-B1ekhtbY.js". */
function currentBundle(): string | null {
  const s = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]');
  return s ? s.src.split("/").pop() ?? null : null;
}

/**
 * Polls the server's index.html. When a new release is deployed, a hidden tab reloads itself and a
 * visible tab offers a one-click refresh, so nobody keeps reading a superseded build.
 */
export function UpdateBanner() {
  const { lang } = useT();
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const mine = currentBundle();
    if (!mine) return; // dev server
    let stop = false;
    const check = async () => {
      try {
        const html = await (await fetch("/", { cache: "no-store" })).text();
        const live = html.match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/)?.[1];
        if (live && live !== mine && !stop) {
          if (document.hidden) location.reload();
          else setStale(true);
        }
      } catch {}
    };
    const id = setInterval(check, 60_000);
    const onVis = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  if (!stale) return null;
  return (
    <div className="update" role="status">
      <span>{lang === "zh" ? "新版本已发布。" : "A new version is live."}</span>
      <button type="button" onClick={() => location.reload()}>{lang === "zh" ? "刷新" : "Refresh"}</button>
    </div>
  );
}
