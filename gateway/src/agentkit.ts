/**
 * Helpers for a script-driven agent wallet (tests, local development, any EOA agent):
 * mine with BNB, log in with EIP-712, call the gateway. Binance Agentic Wallets do the same steps
 * through `baw contract-call` and `baw sign-message`; see SKILL.md.
 */
import { createWalletClient, http, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chain, client, POI, poiAbi } from "./chain";
import { env } from "./config";

export function wallet(pk: Hex) {
  const account = privateKeyToAccount(pk);
  return { account, wc: createWalletClient({ account, chain, transport: http(env.RPC_URL) }) };
}

/** Pay `bnb` to ProofOfInference.mine(); the caller must hold a .ai Agent ID. */
export async function mine(pk: Hex, bnb: string) {
  const { wc } = wallet(pk);
  const hash = await wc.writeContract({ address: POI, abi: poiAbi, functionName: "mine", args: [], value: parseEther(bnb) });
  const rc = await client.waitForTransactionReceipt({ hash });
  return { hash, status: rc.status };
}

/** Same as mine(), by sending BNB straight to the contract. */
export async function mineBySend(pk: Hex, bnb: string) {
  const { wc } = wallet(pk);
  const hash = await wc.sendTransaction({ to: POI, value: parseEther(bnb) });
  const rc = await client.waitForTransactionReceipt({ hash });
  return { hash, status: rc.status };
}

/** EIP-712 login against the gateway; returns a bearer token. */
export async function login(gateway: string, pk: Hex) {
  const { account } = wallet(pk);
  const ch = await (await fetch(`${gateway}/v1/login/challenge?wallet=${account.address}`)).json();
  const { EIP712Domain: _omit, ...types } = ch.typedData.types;
  const signature = await account.signTypedData({ domain: ch.typedData.domain, types, primaryType: "Login", message: { ...ch.message, issuedAt: BigInt(ch.message.issuedAt) } });
  const r = await fetch(`${gateway}/v1/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...ch.message, signature }) });
  const j = await r.json();
  if (!r.ok) throw new Error(`login failed: ${JSON.stringify(j)}`);
  return j.token as string;
}

export async function infer(gateway: string, token: string, body: Record<string, unknown>) {
  const res = await fetch(`${gateway}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...body, stream: false }),
  });
  const data = await res.json();
  return { status: res.status, cost: res.headers.get("x-yansuan-cost-usd"), data };
}
