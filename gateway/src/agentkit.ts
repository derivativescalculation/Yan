/**
 * Helpers for a script-driven agent wallet (tests, local development, any EOA agent): mine with BNB.
 * Binance Agentic Wallets do the same through `baw contract-call`; see SKILL.md.
 */
import { createWalletClient, http, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chain, client, MINTER, minterAbi } from "./chain";
import { env } from "./config";

export function wallet(pk: Hex) {
  const account = privateKeyToAccount(pk);
  return { account, wc: createWalletClient({ account, chain, transport: http(env.RPC_URL) }) };
}

/** Pay `bnb` to YanMinter.mine(); the caller must hold a .ai Agent ID. */
export async function mine(pk: Hex, bnb: string) {
  const { wc } = wallet(pk);
  const hash = await wc.writeContract({ address: MINTER, abi: minterAbi, functionName: "mine", args: [], value: parseEther(bnb) });
  const rc = await client.waitForTransactionReceipt({ hash });
  return { hash, status: rc.status };
}

/** Same as mine(), by sending BNB straight to the minter. */
export async function mineBySend(pk: Hex, bnb: string) {
  const { wc } = wallet(pk);
  const hash = await wc.sendTransaction({ to: MINTER, value: parseEther(bnb) });
  const rc = await client.waitForTransactionReceipt({ hash });
  return { hash, status: rc.status };
}
