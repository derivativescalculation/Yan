/**
 * Wallet login for agents. Binance Agentic Wallets can only sign EIP-712 typed data, so login is one
 * EIP-712 "Login" signature. The gateway returns a session token (HMAC, 7 days) that the agent sends
 * as `Authorization: Bearer <token>` on every request. No API keys, no per-request signing.
 *
 *   GET  /v1/login/challenge?wallet=0x…  -> typed data (and a ready eth_signTypedData_v4 request)
 *   POST /v1/login { wallet, issuedAt, nonce, signature } -> { token, expiresAt }
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { verifyTypedData, getAddress, type Address, type Hex } from "viem";
import { env } from "./config";

const SESSION_TTL_S = 7 * 24 * 3600;
const LOGIN_WINDOW_S = 600;
const secret = env.SESSION_SECRET ?? (env.CHAIN_ID === 31337 ? "local-dev-session-secret-not-for-production" : "");

export const loginDomain = { name: "Yansuan", version: "1", chainId: env.CHAIN_ID } as const;
export const loginTypes = {
  Login: [
    { name: "wallet", type: "address" },
    { name: "issuedAt", type: "uint256" },
    { name: "nonce", type: "string" },
  ],
} as const;

export function challenge(wallet: Address) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(12).toString("hex");
  const message = { wallet: getAddress(wallet), issuedAt, nonce };
  const typedData = {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
      ],
      ...loginTypes,
    },
    primaryType: "Login",
    domain: loginDomain,
    message,
  };
  return {
    message,
    typedData,
    /** exactly what `baw sign-message preview --signType EIP712 --message '<this>'` expects */
    signRequest: JSON.stringify({ method: "eth_signTypedData_v4", params: [message.wallet, JSON.stringify(typedData)] }),
    expiresAt: issuedAt + LOGIN_WINDOW_S,
  };
}

// nonces used within the login window
const usedNonces = new Map<string, number>();
function useNonce(nonce: string, now: number): boolean {
  if (usedNonces.size > 50_000) for (const [k, exp] of usedNonces) if (exp < now) usedNonces.delete(k);
  if (usedNonces.has(nonce)) return false;
  usedNonces.set(nonce, now + LOGIN_WINDOW_S * 2);
  return true;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sign = (payload: string) => createHmac("sha256", secret).update(payload).digest();

export async function login(body: { wallet?: string; issuedAt?: number | string; nonce?: string; signature?: string }) {
  const { wallet, nonce, signature } = body;
  const issuedAt = Number(body.issuedAt);
  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) return { error: "bad wallet", status: 400 as const };
  if (!nonce || !/^[0-9a-f]{8,64}$/.test(nonce)) return { error: "bad nonce", status: 400 as const };
  if (!signature || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return { error: "bad signature format", status: 400 as const };
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(issuedAt) || Math.abs(now - issuedAt) > LOGIN_WINDOW_S) return { error: "challenge expired; request a new one", status: 401 as const };
  let ok = false;
  try {
    ok = await verifyTypedData({
      address: wallet as Address,
      domain: loginDomain,
      types: loginTypes,
      primaryType: "Login",
      message: { wallet: getAddress(wallet), issuedAt: BigInt(issuedAt), nonce },
      signature: signature as Hex,
    });
  } catch {
    ok = false;
  }
  if (!ok) return { error: "bad signature", status: 401 as const };
  if (!useNonce(nonce, now)) return { error: "challenge already used", status: 401 as const };
  const exp = now + SESSION_TTL_S;
  const payload = b64(JSON.stringify({ w: getAddress(wallet), c: env.CHAIN_ID, exp }));
  return { token: `ys1.${payload}.${b64(sign(payload))}`, wallet: getAddress(wallet), expiresAt: exp };
}

/** Bearer token -> wallet, or an error */
export function authenticate(h: Headers): { wallet: Address } | { error: string; status: number } {
  const m = (h.get("authorization") ?? "").match(/^Bearer\s+(ys1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/);
  if (!m) return { error: "missing bearer token; log in at /v1/login", status: 401 };
  const [, payload, mac] = m[1].split(".");
  const expected = sign(payload);
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { error: "invalid token", status: 401 };
  let p: { w: string; c: number; exp: number };
  try {
    p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { error: "invalid token", status: 401 };
  }
  if (p.c !== env.CHAIN_ID) return { error: "token for another chain", status: 401 };
  if (p.exp < Math.floor(Date.now() / 1000)) return { error: "token expired; log in again", status: 401 };
  return { wallet: p.w as Address };
}
