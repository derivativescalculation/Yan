/**
 * MCP server (stdio) so any MCP-capable agent (OpenClaw, BNB Agent Studio, ElizaOS, custom runtimes) can mine and use 衍算.
 *
 * Env: AGENT_PRIVATE_KEY, AGENT_ID, GATEWAY_URL, plus the chain/env vars from config.ts.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Hex } from "viem";
import { formatUnits } from "viem";
import { mine, redeem, stake, quote, infer, registerAgent, tokenBalance, wallet } from "./agentkit";
import { env } from "./config";

const PK = process.env.AGENT_PRIVATE_KEY as Hex | undefined;
const GATEWAY = process.env.GATEWAY_URL ?? env.PUBLIC_URL;
const agentId = () => {
  const id = process.env.AGENT_ID;
  if (!id) throw new Error("AGENT_ID not set. Run yansuan_register first.");
  return BigInt(id);
};
const pk = () => {
  if (!PK) throw new Error("AGENT_PRIVATE_KEY not set");
  return PK;
};
const text = (o: unknown) => ({ content: [{ type: "text" as const, text: typeof o === "string" ? o : JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) }] });

const server = new McpServer({ name: "yansuan", version: "0.1.0" });

server.tool("yansuan_status", "Protocol stats: epoch, tokens per USD, total mined, agents.", {}, async () => {
  const r = await fetch(`${GATEWAY}/v1/stats`);
  return text(await r.json());
});

server.tool("yansuan_quote", "How many YAN a BNB payment would mint right now, and its USD value.", { bnb: z.string().describe("amount in BNB, e.g. '0.01'") }, async ({ bnb }) => text(await quote(bnb)));

server.tool(
  "yansuan_mine",
  "Pay BNB on-chain for inference credit (valued in USD by Chainlink). Mints YAN to your wallet at the current epoch rate. Requires an ERC-8004 agent you operate.",
  { bnb: z.string().describe("amount in BNB, e.g. '0.01'") },
  async ({ bnb }) => text(await mine(pk(), agentId(), bnb)),
);

server.tool("yansuan_redeem", "Burn tokens for inference credit at the genesis rate x redeemBps (constant, independent of epoch).", { tokens: z.string() }, async ({ tokens }) =>
  text(await redeem(pk(), agentId(), tokens)),
);

server.tool("yansuan_stake", "Stake tokens against your agentId for a higher tier (discount + rate limit).", { tokens: z.string() }, async ({ tokens }) =>
  text(await stake(pk(), agentId(), tokens)),
);

server.tool("yansuan_balance", "Credit balance, tier and recent usage for your agent.", {}, async () => {
  const r = await fetch(`${GATEWAY}/v1/agents/${agentId()}`);
  const { account } = wallet(pk());
  const bal = await tokenBalance(account.address);
  return text({ ...(await r.json()), wallet: account.address, tokenBalance: formatUnits(bal, 18) });
});

server.tool(
  "yansuan_infer",
  "Run a Claude request through the 衍算 gateway, paid from your on-chain credit.",
  {
    prompt: z.string(),
    system: z.string().optional(),
    model: z.enum(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]).optional(),
    max_tokens: z.number().int().optional(),
  },
  async ({ prompt, system, model, max_tokens }) => {
    const r = await infer(GATEWAY, pk(), agentId(), {
      model,
      system,
      max_tokens: max_tokens ?? 4096,
      messages: [{ role: "user", content: prompt }],
    });
    if (r.status !== 200) return text({ error: r.data, status: r.status });
    const out = (r.data.content as any[]).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    return text(`${out}\n\n[cost ${r.cost} USD]`);
  },
);

server.tool(
  "yansuan_register",
  "Register a new ERC-8004 agent identity for this wallet (one-time). Returns agentId; set AGENT_ID to it.",
  { agentURI: z.string().describe("URL of the agent's registration JSON") },
  async ({ agentURI }) => text(await registerAgent(pk(), agentURI)),
);

await server.connect(new StdioServerTransport());
