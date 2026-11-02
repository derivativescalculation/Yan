import { useT } from "../i18n";
import { deployment, GATEWAY, CHAIN_ID } from "../chain";
import { SecHead, Code } from "../components/Bits";

export default function Docs() {
  const { t, lang } = useT();
  const d = deployment!;
  const gw = GATEWAY || "https://api.yansuan.io";
  const zh = lang === "zh";
  return (
    <div className="wrap doc">
      <section className="sec" style={{ paddingTop: 56 }}>
        <SecHead no="一" h={t("docs_h")} p={t("docs_p")} />

        <h3>{zh ? "一、身份：币安 .ai Agent ID" : "1. Identity: Binance .ai Agent ID"}</h3>
        <p>
          {zh
            ? "铸造合约只接受持有 .ai Agent ID 的钱包。Agent ID 在币安 App 里免费领取（钱包 → Web3 钱包 → Agent ID），每个用户一个，不可转让，绑定在你的 Agentic Wallet 上。合约通过 SPACE ID 注册表的 handleOf(钱包) 校验。"
            : "The minter only accepts wallets holding a .ai Agent ID. Claim one free in the Binance app (Wallet → Web3 wallet → Agent ID): one per user, non-transferable, bound to your Agentic Wallet. The contract checks handleOf(wallet) on the SPACE ID registry."}
        </p>
        <Code label={zh ? "安装币安 Agentic Wallet 技能" : "Install the Binance Agentic Wallet skill"}>{`npx skills add binance/binance-skills-hub/skills/binance-web3/binance-agentic-wallet`}</Code>

        <h3>{zh ? "二、铸造" : "2. Mint"}</h3>
        <p>
          {zh
            ? "智能体以 BNB 调用 mine()，或直接向合约发送 BNB。按 Chainlink BNB/USD 计价，不低于 1 美元；每个 Agent ID 每轮最多一百万枚（七十万枚到账）。同一笔交易里，七成 YAN 铸给智能体，两成五进入流动性金库，半成落入天选三器，BNB 全部进入项目金库。最简单的方式是在矿场页生成指令后粘贴给智能体。"
            : "The agent calls mine() with BNB, or simply sends BNB to the contract. Valued by Chainlink BNB/USD, at least $1; at most 1M YAN per Agent ID per round (700,000 to the agent). In the same transaction 70% of the YAN goes to the agent, 25% to the liquidity vault and 5% to the 天选 vessels, and all BNB goes to the project treasury. The easiest way is to generate the prompt on the Mine page and paste it into the agent."}
        </p>
        <Code label={zh ? "先查询报价与剩余额度" : "Quote and allowance first"}>{`GET ${gw}/v1/quote?bnb=0.01&agent=<wallet or name.ai>
→ { usd, total, toAgent, toVault, toRaffle, canMine, reason, agent: { handle, remainingThisEpoch } }`}</Code>
        <Code label={zh ? "币安 Agentic Wallet（开发者模式）" : "Binance Agentic Wallet (Developer Mode)"}>{`baw wallet agent-id --json        # claimed must be true
baw wallet settings --json        # devMode.enabled must be true
baw wallet address --json         # <wallet>
baw contract-call preview --binanceChainId 56 --from <wallet> \\
  --to ${d.minter} --value <wei> --inputData 0x99f4b251 --json
baw contract-call execute --requestId <requestId> --json`}</Code>
        <Code label={zh ? "原始交易" : "Raw transaction"}>{`to:    ${d.minter}
value: <wei>          # any amount worth at least $1
data:  0x99f4b251     # mine(); empty data also mines
chain: ${CHAIN_ID}`}</Code>

        <h3>{zh ? "三、天选" : "3. The 天选 raffle"}</h3>
        <ul>
          <li>{zh ? "流入：每次铸造的 5%，以及流动性上线后每笔卖出的 0.5%（以 YAN 计）。按 40% / 20% / 40% 落入青罐、朱瓶、金鼎。" : "Inflows: 5% of every mint, and 0.5% of every sale (in YAN) once liquidity is live, split 40% / 20% / 40% into the jade jar, the cinnabar vase and the gold cauldron."}</li>
          <li>{zh ? "开器：青罐满 20,000、朱瓶满 100,000、金鼎满 1,000,000 YAN 即开。满额的那个区块被合约记为快照。" : "Draws: the jade jar opens at 20,000, the cinnabar vase at 100,000 and the gold cauldron at 1,000,000 YAN. The block a vessel fills in is recorded by the contract as the snapshot."}</li>
          <li>{zh ? "签：钱包里每 10,000 YAN 一支签，按快照前一小时内的最低余额计算，无需报名。流动性池、协议合约、项目金库与部署地址不参与。" : "Tickets: one per 10,000 YAN, counted on each wallet's lowest balance in the hour before the snapshot, with no sign-up. Liquidity pools, protocol contracts, the treasury and the deployer are left out."}</li>
          <li>{zh ? "抽签：签册的 Merkle 根先写入链上，再由 Chainlink VRF 给出随机数，中签号 = 随机数 mod 总签数。任何人都能提交证明完成派奖，奖金在同一笔交易里转入中签钱包。" : "Drawing: the ticket list's Merkle root is committed on-chain first, then Chainlink VRF supplies the random word; the winning ticket is random mod total. Anyone can submit the proof to settle, and the prize moves to the winning wallet in the same transaction."}</li>
        </ul>
        <Code label={zh ? "查签与核验" : "Tickets and verification"}>{`GET ${gw}/v1/raffle                         # vessels, holders, tickets, recent draws
GET ${gw}/v1/raffle/tickets/<wallet or name.ai>
GET ${gw}/v1/raffle/draws/<id>              # the full committed ticket list
GET ${gw}/v1/raffle/draws/<id>/winner       # range and proof, enough to call settle()

leaf = keccak256(keccak256(abi.encode(account, start, count)))
sorted-pair hashing; a node without a sibling is carried up unchanged`}</Code>

        <h3>{zh ? "四、流动性与卖出税" : "4. Liquidity and the sell tax"}</h3>
        <ul>
          <li>{zh ? "流动性金库里的 YAN 只能添加为 PancakeSwap V2 流动性，LP 直接发到销毁地址。第七轮结束后由团队提供 BNB 一侧并添加。" : "YAN in the liquidity vault can only become PancakeSwap V2 liquidity, with the LP sent to the dead address. The team supplies the BNB side and adds it after round 7."}</li>
          <li>{zh ? "卖入 YAN/WBNB 交易对的每一笔收 0.5% 的 YAN，进入天选。买入、转账与其它交易场所不收税。卖出请使用支持转账手续费代币的路由，并留出至少 1% 的滑点。" : "Every sale into the YAN/WBNB pair pays 0.5% in YAN to the raffle. Buys, transfers and other venues are untaxed. Sell through a route that supports fee-on-transfer tokens and allow at least 1% slippage."}</li>
        </ul>

        <h3>{zh ? "五、读接口" : "5. Read endpoints"}</h3>
        <Code>{`GET ${gw}/v1/stats
GET ${gw}/v1/leaderboard[?agent=<wallet or name.ai>]
GET ${gw}/v1/agents/<wallet or name.ai>
GET ${gw}/v1/quote?bnb=<amount>[&agent=<wallet or name.ai>]
GET ${gw}/skill.md`}</Code>
      </section>
    </div>
  );
}
