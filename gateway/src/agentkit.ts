/**
 * Client-side helpers an agent uses to mine, redeem and call the gateway.
 * Used by the MCP server and by the register script. Needs AGENT_PRIVATE_KEY.
 */
import { createWalletClient, http, formatEther, formatUnits, parseEther, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chain, client, POI, TOKEN, STAKE, REGISTRY, poiAbi, tokenAbi, stakeAbi, erc20Abi, registryAbi } from "./chain";
import { authMessage, sha256Hex, randomNonce } from "./auth";
import { env } from "./config";

export function wallet(pk: Hex) {
  const account = privateKeyToAccount(pk);
  return { account, wc: createWalletClient({ account, chain, transport: http(env.RPC_URL) }) };
}

/** USD (1e18) per BNB from the minter's Chainlink feed */
export async function bnbUsd(): Promise<bigint> {
  return (await client.readContract({ address: POI, abi: poiAbi, functionName: "bnbUsd" })) as bigint;
}

/** tokens and USD value for paying `bnb` right now */
export async function quote(bnb: string) {
  const wei = parseEther(bnb);
  const [tokens, usd18] = await Promise.all([
    client.readContract({ address: POI, abi: poiAbi, functionName: "quote", args: [wei] }) as Promise<bigint>,
    client.readContract({ address: POI, abi: poiAbi, functionName: "usdOf", args: [wei] }) as Promise<bigint>,
  ]);
  return { wei, tokens, tokensFmt: formatUnits(tokens, 18), usd: formatUnits(usd18, 18) };
}

async function ensureAllowance(pk: Hex, token: Address, spender: Address, amount: bigint) {
  const { account, wc } = wallet(pk);
  const cur = (await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account.address, spender] })) as bigint;
  if (cur >= amount) return null;
  const hash = await wc.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, amount] });
  await client.waitForTransactionReceipt({ hash });
  return hash;
}

/** Pay `bnb` for inference credit on `agentId`; mints YAN to the signer. */
export async function mine(pk: Hex, agentId: bigint, bnb: string) {
  const { account, wc } = wallet(pk);
  const value = parseEther(bnb);
  const bal = await client.getBalance({ address: account.address });
  if (bal < value) throw new Error(`BNB balance ${formatEther(bal)} < ${bnb} (plus gas)`);
  const ok = (await client.readContract({ address: POI, abi: poiAbi, functionName: "isOperator", args: [agentId, account.address] })) as boolean;
  if (!ok) throw new Error(`${account.address} is not the owner or agent wallet of agent ${agentId}`);
  const hash = await wc.writeContract({ address: POI, abi: poiAbi, functionName: "mine", args: [agentId], value });
  const rc = await client.waitForTransactionReceipt({ hash });
  return { hash, status: rc.status, block: rc.blockNumber };
}

export async function redeem(pk: Hex, agentId: bigint, tokens: string) {
  const { wc } = wallet(pk);
  const amount = parseUnits(tokens, 18);
  await ensureAllowance(pk, TOKEN, POI, amount);
  const hash = await wc.writeContract({ address: POI, abi: poiAbi, functionName: "redeem", args: [agentId, amount] });
  const rc = await client.waitForTransactionReceipt({ hash });
  return { hash, status: rc.status };
}

export async function stake(pk: Hex, agentId: bigint, tokens: string) {
  const { wc } = wallet(pk);
  const amount = parseUnits(tokens, 18);
  await ensureAllowance(pk, TOKEN, STAKE, amount);
  const hash = await wc.writeContract({ address: STAKE, abi: stakeAbi, functionName: "stake", args: [agentId, amount] });
  const rc = await client.waitForTransactionReceipt({ hash });
  return { hash, status: rc.status };
}

export async function registerAgent(pk: Hex, agentURI: string) {
  const { wc } = wallet(pk);
  const hash = await wc.writeContract({ address: REGISTRY, abi: registryAbi, functionName: "register", args: [agentURI] });
  const rc = await client.waitForTransactionReceipt({ hash });
  // ERC-721 Transfer(from=0, to, tokenId): tokenId is topic[3]
  const transfer = rc.logs.find((l) => l.topics[0] === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
  const agentId = transfer?.topics[3] ? BigInt(transfer.topics[3]) : null;
  return { hash, agentId };
}

export async function agentsOf(address: Address): Promise<bigint> {
  return (await client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "balanceOf", args: [address] })) as bigint;
}

export async function tokenBalance(address: Address) {
  return (await client.readContract({ address: TOKEN, abi: tokenAbi, functionName: "balanceOf", args: [address] })) as bigint;
}

/** Signed auth headers for the gateway. The signature binds chain, agentId, time and the exact body. */
export async function authHeaders(pk: Hex, agentId: bigint, body: string) {
  const { account } = wallet(pk);
  const ts = Math.floor(Date.now() / 1000);
  const nonce = randomNonce();
  const sig = await account.signMessage({ message: authMessage(env.CHAIN_ID, agentId, ts, nonce, await sha256Hex(body)) });
  return {
    "x-agent-id": agentId.toString(),
    "x-agent-address": account.address,
    "x-agent-ts": String(ts),
    "x-agent-nonce": nonce,
    "x-agent-sig": sig,
  };
}

export async function infer(gateway: string, pk: Hex, agentId: bigint, body: Record<string, unknown>) {
  const raw = JSON.stringify({ ...body, stream: false });
  const res = await fetch(`${gateway}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(pk, agentId, raw)) },
    body: raw,
  });
  const data = await res.json();
  return { status: res.status, cost: res.headers.get("x-yansuan-cost-usd"), data };
}
