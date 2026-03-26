# WhatsApp DCA + Auto-Yield Bot on Rootstock — Research Report

**Project**: Hackathon MVP — WhatsApp-controlled DCA bot that buys crypto on Rootstock and auto-deposits into DeFi yield protocols.

**Date**: 2026-03-25

---

## Executive Summary

Build a WhatsApp bot (via Kapso.ai) where users send natural language messages like _"invest $10 in Bitcoin every week"_ and the bot:
1. Parses the intent with an LLM
2. Executes periodic swaps on Rootstock (via Uniswap V3)
3. Auto-deposits purchased tokens into yield protocols (Sovryn/Tropykus)
4. Reports back via WhatsApp with tx links and portfolio summaries

**Unique angle**: "Robinhood's recurring investments, but for Bitcoin, on WhatsApp, with AI that buys the dips and earns yield for you."

---

## 1. Kapso.ai — WhatsApp Interface

### What It Is
WhatsApp-for-developers platform wrapping Meta's official WhatsApp Cloud API. Founded in Chile (Platanus-backed), ~4,000 developers. **Not** a reverse-engineered library — zero ban risk.

### Key Integration Points

| Feature | Details |
|---------|---------|
| **API Base** | `https://api.kapso.ai/meta/whatsapp/v24.0` |
| **Auth** | `X-API-Key` header |
| **SDK** | `@kapso/whatsapp-cloud-api` (TypeScript) |
| **GitHub** | [github.com/gokapso](https://github.com/gokapso) |
| **Message Types** | Text, images, interactive buttons/lists, WhatsApp Flows |
| **Webhooks** | HMAC-SHA256 signed, retry at 10s/40s/90s |
| **Free Tier** | 2,000 messages/mo, 1 WhatsApp number, 1GB storage |

### Webhook Events
- `whatsapp.message.received` — incoming user message
- `whatsapp.message.sent` / `delivered` / `read` — delivery tracking
- `whatsapp.message.failed` — send failures

### Sending Messages
```
POST https://api.kapso.ai/meta/whatsapp/v24.0/{phoneNumberId}/messages
X-API-Key: YOUR_API_KEY

{
  "messaging_product": "whatsapp",
  "to": "15551234567",
  "type": "text",
  "text": { "body": "Your DCA executed! Bought 0.00015 RBTC" }
}
```

### Built-in AI Agent
Kapso's workflow builder includes an AgentNode (Claude Sonnet) with tool calling. However, for our hackathon with custom blockchain logic, **use webhooks to our own backend** for full control.

### Key Decision
Use Kapso as a thin WhatsApp transport layer. Our backend handles all logic (NLP, scheduling, blockchain interaction).

---

## 2. Rootstock (RSK) Blockchain

### Network Details

| Property | Value |
|----------|-------|
| **Chain ID** | 30 (mainnet), 31 (testnet) |
| **RPC Mainnet** | `https://public-node.rsk.co` |
| **RPC Testnet** | `https://public-node.testnet.rsk.co` |
| **Block Time** | ~30 seconds |
| **Gas Token** | RBTC (Bitcoin-pegged via 2-way peg) |
| **EVM Compatible** | Yes — ethers.js, viem, web3.js all work |
| **Explorer** | https://explorer.rootstock.io |
| **Testnet Faucet** | https://faucet.rsk.co |

### Key Token Addresses (Mainnet)

| Token | Address | Decimals |
|-------|---------|----------|
| WRBTC | `0x542fda317318ebf1d3deaf76e0b632741a7e677d` | 18 |
| DOC | `0xe700691da7b9851f2f35f8b8182c69c53ccad9db` | 18 |
| RIF | `0x2aCc95758f8b5F583470bA265Eb685a8f45fC9D5` | 18 |
| rUSDT | `0xEf213441a85DF4d7acBdAe0Cf78004E1e486BB96` | 18 |
| USDRIF | _(verify on explorer)_ | 18 |
| SOV | `0xEFc78fc7d48b64958315949279Ba181c2114ABBd` | 18 |
| DLLR | `0xc1411567D2670E24D9c4Daaa7CdA95686E1250Aa` | 18 |
| USDC | `0xbB739A6e04d07b08E38B66ba137d0c9Cd270c750` | - |

### Gas Pricing
- `minimumGasPrice` embedded in block headers, fluctuates up to 1% per block
- Recommended: add ~10% buffer to minimum gas price
- Block gas limit: 6,800,000 units
- RSK gas is significantly cheaper than Ethereum mainnet

---

## 3. DEX — Uniswap V3 on Rootstock (via OKU)

Uniswap V3 is **fully active** on Rootstock. Deployed by GFX Labs (OKU). TVL hit $35M by Q2 2025 (14.2% of RSK DeFi TVL).

### Contract Addresses (Mainnet)

| Contract | Address |
|----------|---------|
| V3 Core Factory | `0xaF37EC98A00FD63689CF3060BF3B6784E00caD82` |
| **SwapRouter02** | `0x0B14ff67f0014046b4b99057Aec4509640b3947A` |
| **Universal Router** | `0x244f68e77357f86a8522323eBF80b5FC2F814d3E` |
| **QuoterV2** | `0xb51727c996C68E60F598A923a5006853cd2fEB31` |
| NonfungiblePositionManager | `0x9d9386c042F194B460Ec424a1e57ACDE25f5C4b1` |
| Permit2 | `0xFcf5986450E4A014fFE7ad4Ae24921B589D039b5` |

### Active Pools
| Pool | Address | Notes |
|------|---------|-------|
| rUSDT/WRBTC | `0xd2ffe51ab4e622a411abbe634832a19d919e9c55` | ~$118K liquidity |
| RIF/rUSDT | `0x620d9331a3e981a00857790e4575c319cca9471a` | Active |
| DOC/rUSDT | Active | Active |

### Swap Execution Pattern (SwapRouter02)
```typescript
import { Contract, Wallet, parseUnits } from 'ethers';

const SWAP_ROUTER = '0x0B14ff67f0014046b4b99057Aec4509640b3947A';
const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
];

const router = new Contract(SWAP_ROUTER, ROUTER_ABI, wallet);
const tx = await router.exactInputSingle({
  tokenIn: RUSDT_ADDRESS,
  tokenOut: WRBTC_ADDRESS,
  fee: 3000, // 0.3% fee tier
  recipient: wallet.address,
  amountIn: parseUnits('10', 18),
  amountOutMinimum: 0, // set proper slippage in production
  sqrtPriceLimitX96: 0,
});
```

### Quote Before Swap
```typescript
const QUOTER = '0xb51727c996C68E60F598A923a5006853cd2fEB31';
const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];
```

---

## 4. Yield Protocols on Rootstock

### Sovryn Lend (TVL ~$43.7M) — RECOMMENDED

The dominant lending protocol on RSK. Deposit tokens, receive iTokens that accrue interest.

| iToken | Address | Underlying | Est. APY |
|--------|---------|------------|----------|
| iRBTC | `0xa9DcDC63eaBb8a2b6f39D7fF9429d88340044a7A` | RBTC | 4.5-6.5% |
| iDOC | `0xd8D25f03EBbA94E15Df2eD4d6D38276B595593c1` | DOC | Variable |
| iXUSD | `0x8F77ecf69711a4b346f23109c40416BE3dC7f129` | XUSD | ~11% |
| iDLLR | `0x077FCB01cAb070a30bC14b44559C96F529eE017F` | DLLR | Variable |
| SovrynProtocol | `0x5A0D867e0D70Fcc6Ade25C3F1B89d618b5B4Eaa7` | - | - |

**Deposit**: `iToken.mint(address receiver, uint256 depositAmount)` — returns iTokens
**Withdraw**: `iToken.burn(address receiver, uint256 burnAmount)` — burns iTokens, returns underlying

### Tropykus (TVL ~$12.2M) — Compound V2 Fork

| kToken | Address | Underlying |
|--------|---------|------------|
| kRBTC | `0x0aeadb9d4c6a80462a47e87e76e487fa8b9a37d7` | RBTC |
| kDOC | `0x544eb90e766b405134b3b3f62b6b4c23fcd5fda2` | DOC |
| kUSDRIF | `0xDdf3CE45fcf080DF61ee61dac5Ddefef7ED4F46C` | USDRIF |
| Comptroller | `0x962308Fef8EdfAdD705384840e7701f8F39ed0c0` | - |

**Deposit**: `kToken.mint(uint256 mintAmount)` — standard Compound V2 interface
**APY**: ~6% on BTC/stablecoins

### Other Options
- **Money on Chain**: BPro token earns passive yield (protocol fees)
- **LayerBank**: ~$6.2M TVL, launched Sep 2025, auto-looping BTC strategies
- **Avalon Finance**: BTC-collateralized lending
- **Beefy Finance**: Yield aggregator, auto-compounds from Sovryn/Uniswap LP

### Recommended for Hackathon: Sovryn iRBTC
Simplest integration — one `mint()` call after each DCA swap. User DCA's into RBTC, RBTC auto-deposits into Sovryn iRBTC to earn ~5% APY in BTC. The iToken balance grows over time.

---

## 5. Architecture

### System Flow

```
User (WhatsApp)
    │ "invest $10 in Bitcoin every week"
    ▼
Kapso.ai (webhook)
    │ POST /webhook { message, sender }
    ▼
Backend (Node.js/TypeScript)
    ├── LLM Parser (Claude API)
    │   └── Extract: token=RBTC, amount=$10, frequency=weekly
    ├── Command Handler
    │   └── Create DCA order in DB
    ├── Scheduler (node-cron, every minute)
    │   └── Check for due DCA orders
    ├── Swap Executor
    │   ├── Get quote (QuoterV2)
    │   ├── Approve token to SwapRouter02
    │   └── Execute swap (exactInputSingle)
    ├── Yield Depositor
    │   ├── Approve token to iToken contract
    │   └── Deposit via iToken.mint()
    └── Notifier
        └── Send WhatsApp message with tx hash + portfolio summary
```

### Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Runtime | Node.js 20+ / TypeScript | ethers.js native, fast iteration |
| Framework | Express or Hono | Simple webhook handling |
| Database | SQLite (better-sqlite3) + Drizzle ORM | Zero config for hackathon |
| Blockchain | ethers.js v6 | Best docs, RSK-compatible |
| Scheduling | node-cron | No Redis needed |
| AI/NLP | Claude API (claude-sonnet) | Parse natural language DCA commands |
| WhatsApp | Kapso.ai SDK | Official API, free tier |
| Hosting | Railway | Persistent process for cron + long txs |

### Database Schema

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_id TEXT NOT NULL UNIQUE,
  wallet_index INTEGER NOT NULL UNIQUE,
  wallet_address TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE dca_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  from_token TEXT NOT NULL,        -- e.g., 'rUSDT'
  to_token TEXT NOT NULL,          -- e.g., 'RBTC'
  amount TEXT NOT NULL,            -- amount per execution in from_token
  frequency TEXT NOT NULL,         -- 'hourly' | 'daily' | 'weekly'
  auto_yield BOOLEAN DEFAULT TRUE, -- auto-deposit into yield protocol
  yield_protocol TEXT DEFAULT 'sovryn', -- 'sovryn' | 'tropykus'
  status TEXT DEFAULT 'active',
  next_execution DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dca_order_id INTEGER REFERENCES dca_orders(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  swap_tx_hash TEXT,
  yield_tx_hash TEXT,              -- tx for yield deposit
  amount_in TEXT NOT NULL,
  amount_out TEXT,
  yield_tokens_received TEXT,      -- iTokens / kTokens received
  status TEXT DEFAULT 'pending',
  error TEXT,
  executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Wallet Management (HD Wallets)

```typescript
import { HDNodeWallet, Mnemonic, Wallet } from 'ethers';

const MASTER_MNEMONIC = process.env.MASTER_MNEMONIC!;

// Derive unique wallet per user: m/44'/137'/0'/0/{userIndex}
// 137 = RSK's registered coin type
export function getUserWallet(userIndex: number): Wallet {
  const mnemonic = Mnemonic.fromPhrase(MASTER_MNEMONIC);
  const hdNode = HDNodeWallet.fromMnemonic(mnemonic, `m/44'/137'/0'/0`);
  return new Wallet(hdNode.deriveChild(userIndex).privateKey, provider);
}
```

### DCA + Yield Execution Flow

```typescript
async function executeDCAWithYield(order: DCAOrder, user: User) {
  const wallet = getUserWallet(user.wallet_index).connect(provider);

  // 1. Execute swap: rUSDT → RBTC via Uniswap V3
  const swapTxHash = await executeSwap(wallet, order.from_token, order.to_token, order.amount);

  // 2. Auto-deposit RBTC into Sovryn iRBTC for yield
  if (order.auto_yield) {
    const iRBTC = new Contract(SOVRYN_IRBTC, ['function mint(address, uint256)'], wallet);
    const rbtcBalance = await provider.getBalance(wallet.address);
    const yieldTx = await iRBTC.mint(wallet.address, rbtcBalance - GAS_RESERVE);
    await yieldTx.wait();
  }

  // 3. Notify user via WhatsApp
  await sendWhatsAppMessage(user.whatsapp_id,
    `DCA executed! Swapped ${order.amount} ${order.from_token} → ${order.to_token}\n` +
    `Auto-deposited into Sovryn for ~5% APY\n` +
    `Tx: https://explorer.rootstock.io/tx/${swapTxHash}`
  );
}
```

---

## 6. AI Features (Differentiation)

### Tier 1 — Build These (Must-Have)

1. **NLP Command Parsing** (Claude API)
   - "buy $10 of BTC every Monday" → `{ token: 'RBTC', amount: 10, frequency: 'weekly' }`
   - "how's my portfolio?" → `{ action: 'status' }`
   - "pause my DCA" → `{ action: 'pause' }`

2. **Smart DCA (Dip Buying)**
   - Compare current price to 7-day SMA
   - If price >5% below SMA → buy 50% more
   - If price >5% above SMA → buy 50% less
   - One simple conditional — sounds impressive in demo

3. **Conversational Explanations**
   - "Bought $15 of RBTC (50% more than usual — price dropped 7% below weekly average). Deposited into Sovryn earning ~5% APY. Your average cost: $42,300."

### Tier 2 — Nice to Have
- Weekly sentiment digest via WhatsApp
- Portfolio performance vs lump-sum comparison
- Yield earnings tracker

---

## 7. Hackathon Strategy

### Demo Flow (3 Minutes)

**[0:00-0:30] Hook:**
"2 billion people use WhatsApp. Most have never touched DeFi. Watch this."

**[0:30-1:30] Live Demo:**
1. Open WhatsApp, send: "I want to invest $10 in Bitcoin every week"
2. Bot parses, confirms plan, mentions Smart DCA + auto-yield
3. Send: "Start now"
4. Bot executes swap on Rootstock + deposits into Sovryn
5. Click tx hash link → show on Rootstock explorer

**[1:30-2:15] Show Intelligence:**
1. "How's my portfolio?" → AI summary with yield earnings
2. "Buy extra if Bitcoin dips" → Smart DCA confirmation

**[2:15-3:00] Close:**
- Architecture diagram
- "DCA + Auto-Yield on Bitcoin, from WhatsApp, powered by AI"
- Mention: Bitcoin security via RSK merge-mining, Sovryn yield

### What Impresses Judges
1. **Live on-chain tx** during demo (pre-fund wallets!)
2. **WhatsApp UX** — no MetaMask, no wallet connect, just messaging
3. **AI is central**, not bolted on — every interaction is conversational
4. **DeFi composability** — DCA + yield = more than the sum of parts
5. **Rootstock-native features** — RBTC, Sovryn, RSK explorer links

### Suggested Name
"AutoStack" — auto-stack sats + auto-stack yield. Alternatives: "BitDCA", "StackSats", "YieldWhats"

### One-Liner
"Robinhood's recurring investments, but for Bitcoin, on WhatsApp, with AI that buys the dips and earns yield for you — all secured by Bitcoin's hashrate."

---

## 8. Implementation Timeline

### Hour 0-4: Foundation
- [ ] Init project (TypeScript, Express, Drizzle, ethers.js)
- [ ] Kapso.ai setup (account, API key, webhook endpoint)
- [ ] Rootstock testnet wallet + fund with test RBTC
- [ ] Basic webhook receiver + message echo

### Hour 4-10: Core Loop
- [ ] LLM intent parser (Claude API)
- [ ] DCA order creation + storage (SQLite)
- [ ] Token swap on Rootstock testnet (Uniswap V3 SwapRouter02)
- [ ] Wire: WhatsApp → parse → confirm → swap → respond

### Hour 10-16: Yield + Polish
- [ ] Auto-deposit into Sovryn iRBTC after swap
- [ ] Smart DCA logic (price vs SMA comparison)
- [ ] Portfolio status command
- [ ] Error handling for demo path

### Hour 16-20: Demo Prep
- [ ] Switch to mainnet (small amounts)
- [ ] Pre-fund demo wallets
- [ ] Record backup demo video
- [ ] Build 3-4 slide pitch deck

### Hour 20+: NO NEW FEATURES. Polish and practice.

---

## 9. Security Notes (Hackathon Context)

### Acceptable Shortcuts
- Custodial HD wallets (server holds master seed in .env)
- SQLite (no Postgres needed)
- Skip rate limiting
- Hardcoded 1% slippage
- WhatsApp phone number as user identity (no separate auth)

### Non-Negotiable Even for Demo
- Never commit private keys/mnemonic to git
- Encrypt stored keys at rest (AES-256-GCM)
- Use testnet for development, mainnet only for demo
- Cap transaction amounts ($50 max per swap)
- Validate all amounts before executing

---

## 10. Key Links & Resources

| Resource | URL |
|----------|-----|
| Kapso Docs | https://docs.kapso.ai/docs/platform/getting-started |
| Kapso SDK | https://github.com/gokapso/whatsapp-cloud-api-js |
| Rootstock Dev Portal | https://dev.rootstock.io |
| RSK Testnet Faucet | https://faucet.rsk.co |
| RSK Explorer | https://explorer.rootstock.io |
| OKU (Uniswap V3 on RSK) | https://oku.trade/app/rootstock |
| Sovryn Wiki | https://wiki.sovryn.com |
| Sovryn Contracts | https://github.com/DistributedCollective/Sovryn-smart-contracts |
| Tropykus GitHub | https://github.com/Tropykus/protocol-rsk |
| ChatterPay (competitor ref) | https://github.com/P4-Games/ChatterPay |
