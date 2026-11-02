import { z } from "zod";

const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

const Env = z.object({
  PORT: z.coerce.number().default(8787),
  CHAIN_ID: z.coerce.number().default(97),
  RPC_URL: z.string().default("https://bsc-testnet-rpc.publicnode.com"),
  /// RPC used for eth_getLogs scans (the official BNB dataseed endpoints refuse log queries)
  LOGS_RPC_URL: z.string().optional(),
  PUBLIC_URL: z.string().default("http://localhost:8787"),
  MINTER_ADDRESS: addr,
  TOKEN_ADDRESS: addr,
  RAFFLE_ADDRESS: addr,
  VAULT_ADDRESS: addr,
  /// Binance .ai Agent ID registry (SPACE ID); mainnet 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F
  AGENT_ID_REGISTRY_ADDRESS: addr,
  /// left out of every ticket list, together with the protocol contracts, the pair and the keeper
  TREASURY_ADDRESS: addr,
  DEPLOYER_ADDRESS: addr,
  EXCLUDED_ADDRESSES: z.string().default(""),
  /// block the contracts were deployed at; required on 56/97 so the event scan is complete
  DEPLOY_BLOCK: z.coerce.bigint().default(0n),
  /// blocks the indexer stays behind the head
  CONFIRMATIONS: z.coerce.bigint().default(3n),
  /// ticket balances are the lowest balance over this many seconds before the snapshot
  TICKET_WINDOW_SEC: z.coerce.number().default(3600),
  /// when set, this process also runs the raffle keeper (sync, commit, settle, retry)
  KEEPER_PRIVATE_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional()),
  KEEPER_INTERVAL_MS: z.coerce.number().default(15_000),
});

export const env = Env.parse(process.env);
export type Env = z.infer<typeof Env>;

export const TICKET_UNIT = 10_000n * 10n ** 18n;

export function assertServerConfig() {
  if (env.CHAIN_ID !== 31337 && env.DEPLOY_BLOCK === 0n) throw new Error("DEPLOY_BLOCK is required outside chain 31337");
}
