import type { ReactNode } from "react";
import { explorer, short } from "../chain";

export function SecHead({ no, h, p }: { no: string; h: string; p?: string }) {
  return (
    <div className="sec-h">
      <div className="no">{no}</div>
      <div>
        <h2>{h}</h2>
        {p ? <p>{p}</p> : null}
      </div>
    </div>
  );
}

export function Stat({ l, v, u }: { l: string; v: ReactNode; u?: string }) {
  return (
    <div>
      <div className="l">{l}</div>
      <div className="v">
        {v}
        {u ? <small>{u}</small> : null}
      </div>
    </div>
  );
}

export function Addr({ a, n = 6, kind = "address" }: { a: string; n?: number; kind?: "address" | "tx" }) {
  const text = short(a, n);
  if (!explorer) return <span className="addr">{text}</span>;
  return (
    <a className="addr" href={`${explorer}/${kind}/${a}`} target="_blank" rel="noreferrer">
      {text}
    </a>
  );
}

export function Panel({ h, m, children }: { h: string; m?: string; children: ReactNode }) {
  return (
    <div className="panel">
      <div className="ph">
        <h3>{h}</h3>
        {m ? <span className="m">{m}</span> : null}
      </div>
      <div className="pb">{children}</div>
    </div>
  );
}

export function Tier({ name }: { name: string }) {
  const cls = name === "玄" ? "seal" : name === "金" ? "gold" : name === "银" ? "" : "";
  return <span className={`tag ${cls}`}>{name}</span>;
}
