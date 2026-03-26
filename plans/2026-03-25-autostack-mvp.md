# AutoStack MVP — Implementation Plan

## Overview
WhatsApp DCA + Auto-Yield bot on Rootstock. User sends tokens, sets up DCA via natural language, bot swaps on Uniswap V3 and deposits into Sovryn for yield.

## Architecture

```
WhatsApp User
    │
    ▼
Kapso.ai (webhook)
    │
    ▼
Express Backend (TypeScript)
    ├── Webhook Handler (receive WhatsApp messages)
    ├── AI Command Parser (Claude API → intent extraction)
    ├── Command Router (swap, dca, balance, status, help)
    ├── Wallet Manager (HD wallet derivation per user)
    ├── Swap Executor (Uniswap V3 SwapRouter02 on RSK)
    ├── Yield Depositor (Sovryn iToken mint)
    ├── DCA Scheduler (node-cron, check due orders every minute)
    ├── Balance Watcher (poll for new deposits)
    └── WhatsApp Sender (respond via Kapso API)
        │
        ▼
    SQLite (users, dca_orders, executions)
```

## Implementation Batches

### Batch 1: Project Skeleton + Kapso Webhook
Files:
- `package.json` — dependencies
- `tsconfig.json` — TypeScript config
- `.env.example` — env template
- `.gitignore`
- `src/index.ts` — Express app entry
- `src/config/tokens.ts` — RSK token addresses + contract constants
- `src/config/env.ts` — env validation with zod
- `src/routes/webhook.ts` — Kapso webhook handler (receive + verify)
- `src/services/whatsapp.ts` — send messages via Kapso API

Verify: `npm run dev` starts, webhook receives test POST.

### Batch 2: Database + Wallet Manager
Files:
- `src/db/schema.ts` — Drizzle schema (users, dca_orders, executions)
- `src/db/index.ts` — SQLite + Drizzle setup
- `src/services/wallet.ts` — HD wallet derivation (m/44'/137'/0'/0/{index})

Verify: Can create user, derive wallet, store in DB.

### Batch 3: AI Command Parser
Files:
- `src/services/parser.ts` — Claude API call to parse natural language → structured intent
- `src/services/commands.ts` — Command router (dispatch to handlers)

Supported intents:
- `start` → create wallet, show deposit address
- `dca` → create DCA order (token, amount, frequency)
- `balance` → show token balances
- `status` → show active DCA orders + yield earned
- `pause` / `resume` / `cancel` → manage DCA orders
- `help` → show available commands
- `deposit` → show deposit address again

Verify: Send WhatsApp message → get parsed intent → get response.

### Batch 4: Swap Executor (Uniswap V3)
Files:
- `src/services/swap.ts` — quote + execute swaps via SwapRouter02
  - `getQuote()` — QuoterV2.quoteExactInputSingle
  - `executeSwap()` — approve + SwapRouter02.exactInputSingle
  - Handle RBTC (native) vs ERC20 token swaps

Verify: Execute a test swap on RSK testnet.

### Batch 5: Yield Depositor (Sovryn)
Files:
- `src/services/yield.ts` — deposit into Sovryn iToken
  - `depositToYield()` — approve + iToken.mint()
  - `getYieldBalance()` — check iToken balance + accrued interest
  - `withdrawFromYield()` — iToken.burn()

Verify: Deposit test tokens into Sovryn on testnet.

### Batch 6: DCA Scheduler + Balance Watcher
Files:
- `src/services/scheduler.ts` — node-cron job, runs every minute
  - Query due DCA orders
  - Execute swap → deposit to yield → log execution → notify user
- `src/services/deposit-watcher.ts` — poll user wallets for new deposits
  - On new deposit, notify user via WhatsApp

Verify: Create DCA order → cron triggers → swap executes → yield deposited → WhatsApp notification sent.

### Batch 7: Smart DCA Logic
Files:
- `src/services/smart-dca.ts` — price comparison logic
  - Fetch current price (CoinGecko or DEX quote)
  - Compare to 7-day SMA
  - Adjust amount: +50% if dip, -50% if pump

Verify: Smart DCA adjusts amounts based on price.

## Key Decisions
- **Custodial HD wallets** — server holds master mnemonic, derives per-user
- **SQLite** — zero config, Drizzle ORM for type safety
- **node-cron** — no Redis needed
- **Testnet first** — RSK testnet for all development
- **Pre-fund for demo** — skip deposit flow complexity

## Dependencies
```
express, ethers (v6), better-sqlite3, drizzle-orm, drizzle-kit,
node-cron, zod, dotenv, @anthropic-ai/sdk
```

## Environment Variables
```
KAPSO_API_KEY=
KAPSO_WEBHOOK_SECRET=
KAPSO_PHONE_NUMBER_ID=
MASTER_MNEMONIC=
WALLET_ENCRYPTION_KEY=
RSK_RPC_URL=https://public-node.testnet.rsk.co
ANTHROPIC_API_KEY=
```
