import { z } from "zod";

const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

const Env = z
  .object({
    PORT: z.coerce.number().default(8787),
    CHAIN_ID: z.coerce.number().default(97),
    RPC_URL: z.string().default("https://bsc-testnet-rpc.publicnode.com"),
    POI_ADDRESS: addr,
    TOKEN_ADDRESS: addr,
    STAKE_ADDRESS: addr,
    REGISTRY_ADDRESS: addr,
    /// block the contracts were deployed at; required on 56/97 so the event scan is complete
    DEPLOY_BLOCK: z.coerce.bigint().default(0n),
    /// Postgres (Neon). Required outside the local anvil chain: usage must survive restarts.
    DATABASE_URL: z.string().optional(),
    LEDGER_PATH: z.string().default("./ledger.sqlite"),
    /// markup over raw model cost, in bps. Solvency: (1-burn)*(1+markup*(1-maxDiscount)) >= 1+redeem,
    /// checked at startup against BURN_BPS / REDEEM_BPS below.
    MARKUP_BPS: z.coerce.number().default(7500),
    BURN_BPS: z.coerce.number().default(2000),
    REDEEM_BPS: z.coerce.number().default(1000),
    /// max concurrent in-flight requests per agent (reservations are held for each)
    MAX_INFLIGHT: z.coerce.number().default(4),
    DEFAULT_MODEL: z.string().default("claude-opus-5-5"),
    PUBLIC_URL: z.string().default("http://localhost:8787"),
    /// ERC-8004 agentId of the gateway itself (after `bun src/register.ts`)
    GATEWAY_AGENT_ID: z.coerce.bigint().optional(),
  });

export const env = Env.parse(process.env);
export type Env = z.infer<typeof Env>;

/** The HTTP gateway needs a persistent ledger and a complete event scan; agent-side tools (MCP, genesis) do not. */
export function assertServerConfig() {
  const local = env.CHAIN_ID === 31337;
  if (!local && !env.DATABASE_URL) throw new Error("DATABASE_URL is required outside chain 31337 (usage ledger must persist)");
  if (!local && env.DEPLOY_BLOCK === 0n) throw new Error("DEPLOY_BLOCK is required outside chain 31337");
}
