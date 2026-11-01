/**
 * Register the gateway itself as an ERC-8004 agent (so it is discoverable in the BNB agent directory).
 *   AGENT_PRIVATE_KEY=0x... bun src/register.ts https://yansuan.ai/agent.json
 */
import type { Hex } from "viem";
import { registerAgent } from "./agentkit";

const uri = process.argv[2];
const pk = process.env.AGENT_PRIVATE_KEY as Hex | undefined;
if (!uri || !pk) {
  console.error("usage: AGENT_PRIVATE_KEY=0x.. bun src/register.ts <agentURI>");
  process.exit(1);
}
const r = await registerAgent(pk, uri);
console.log(JSON.stringify({ tx: r.hash, agentId: r.agentId?.toString() }, null, 2));
