import { createConfig, http } from "wagmi";
import { bsc, bscTestnet, foundry } from "wagmi/chains";
import { parseAbi, type Address } from "viem";
import PoiAbi from "./abi/ProofOfInference.json";
import TokenAbi from "./abi/SuanToken.json";
import StakeAbi from "./abi/SuanStake.json";
import BurnerAbi from "./abi/BuybackBurner.json";

export interface Deployment {
  chainId: number;
  token: Address;
  proofOfInference: Address;
  burner: Address;
  stake: Address;
  priceFeed: Address;
  agentIds: Address;
  maxPerAgentPerEpoch?: string;
  router: Address;
  opsTreasury: Address;
}

const files = import.meta.glob("./deployments/*.json", { eager: true, import: "default" }) as Record<
  string,
  Deployment
>;

export const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 97);
export const GATEWAY = (import.meta.env.VITE_GATEWAY_URL as string | undefined) ?? "";
export const RPC = import.meta.env.VITE_RPC_URL as string | undefined;

export const deployment: Deployment | undefined = Object.values(files).find((d) => d.chainId === CHAIN_ID);

export const chain =
  CHAIN_ID === 56 ? bsc : CHAIN_ID === 97 ? bscTestnet : { ...foundry, id: CHAIN_ID as 31337, contracts: {} };

export const explorer =
  CHAIN_ID === 56 ? "https://bscscan.com" : CHAIN_ID === 97 ? "https://testnet.bscscan.com" : "";

export const wagmiConfig = createConfig({
  chains: [chain],
  transports: { [chain.id]: http(RPC) } as any,
});

export const poiAbi = PoiAbi as any;
export const tokenAbi = TokenAbi as any;
export const stakeAbi = StakeAbi as any;
export const burnerAbi = BurnerAbi as any;
export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

export const E18 = 10n ** 18n;
export const EPOCH = 100_000_000n * E18;

export function short(a: string, n = 4) {
  return a ? `${a.slice(0, 2 + n)}…${a.slice(-n)}` : "";
}

/** format a bigint with decimals, thousands separators, fixed dp */
export function fmt(v: bigint | undefined, decimals = 18, dp = 2): string {
  if (v === undefined) return "—";
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = a / base;
  const frac = dp > 0 ? ((a % base) * 10n ** BigInt(dp)) / base : 0n;
  const w = whole.toLocaleString("en-US");
  return `${neg ? "-" : ""}${w}${dp > 0 ? "." + frac.toString().padStart(dp, "0") : ""}`;
}

/** compact: 1.2M, 34.5K (en) or 1.2亿 / 3.4万 (zh) */
export function compact(v: bigint | undefined, decimals = 18, lang: "zh" | "en" = currentLang()): string {
  if (v === undefined) return "—";
  const n = Number(v / 10n ** BigInt(Math.max(0, decimals - 6))) / 1e6;
  if (lang === "zh") {
    if (n >= 1e8) return trim(n / 1e8) + "亿";
    if (n >= 1e4) return trim(n / 1e4) + "万";
    return n.toFixed(n >= 100 ? 0 : 2);
  }
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return n.toFixed(2);
}
function trim(x: number) {
  return x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2);
}
function currentLang(): "zh" | "en" {
  try {
    return (localStorage.getItem("lang") as "zh" | "en") || "zh";
  } catch {
    return "zh";
  }
}
