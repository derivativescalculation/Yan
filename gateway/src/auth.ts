/**
 * Agent authentication. No API keys: the agent proves it controls a wallet that operates the
 * ERC-8004 agentId (owner or agent wallet, checked on-chain via ProofOfInference.isOperator).
 *
 * Headers:
 *   x-agent-id       ERC-8004 agentId (decimal)
 *   x-agent-address  signer address
 *   x-agent-ts       unix seconds, digits only, within 5 minutes
 *   x-agent-nonce    random 0x-hex (8-32 bytes), unique per request
 *   x-agent-sig      personal_sign of authMessage(chainId, agentId, ts, nonce, sha256(body))
 *
 * The message binds chain, agentId, time and the exact request body, so a captured header set
 * cannot be replayed on another chain/gateway or with a different body. Each signature is also
 * accepted only once within the window.
 */
import { verifyMessage, type Address, type Hex } from "viem";
import { isOperator } from "./chain";
import { env } from "./config";

export interface AgentAuth {
  agentId: bigint;
  address: Address;
}

export function authMessage(chainId: number, agentId: bigint | string, ts: number | string, nonce: string, bodyHash: string) {
  return `yansuan:${chainId}:${agentId}:${ts}:${nonce}:${bodyHash}`;
}

export function randomNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return "0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(body: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return "0x" + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// signatures seen within the window: sig -> expiry ms
const seen = new Map<string, number>();
function markSeen(sig: string, now: number): boolean {
  if (seen.size > 50_000) {
    for (const [k, exp] of seen) if (exp < now) seen.delete(k);
  }
  const key = sig.toLowerCase();
  if (seen.has(key)) return false;
  seen.set(key, now + 6 * 60_000);
  return true;
}

export async function authenticate(h: Headers, body: string): Promise<AgentAuth | { error: string; status: number }> {
  const id = h.get("x-agent-id");
  const address = h.get("x-agent-address") as Address | null;
  const ts = h.get("x-agent-ts");
  const sig = h.get("x-agent-sig") as Hex | null;
  const nonce = h.get("x-agent-nonce");
  if (!id || !address || !ts || !sig || !nonce) return { error: "missing x-agent-* headers", status: 401 };
  if (!/^0x[0-9a-fA-F]{16,64}$/.test(nonce)) return { error: "bad nonce", status: 401 };
  if (!/^\d{1,30}$/.test(id)) return { error: "bad agent id", status: 400 };
  if (!/^\d{1,12}$/.test(ts)) return { error: "bad timestamp", status: 401 };
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return { error: "bad address", status: 400 };
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) return { error: "bad signature format", status: 401 };
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(ts)) > 300) return { error: "stale timestamp", status: 401 };

  const message = authMessage(env.CHAIN_ID, id, ts, nonce, await sha256Hex(body));
  let ok = false;
  try {
    ok = await verifyMessage({ address, message, signature: sig });
  } catch {
    ok = false;
  }
  if (!ok) return { error: "bad signature", status: 401 };
  if (!markSeen(sig, Date.now())) return { error: "signature already used", status: 401 };

  const agentId = BigInt(id);
  if (!(await isOperator(agentId, address))) return { error: "address does not operate this agent", status: 403 };
  return { agentId, address };
}
