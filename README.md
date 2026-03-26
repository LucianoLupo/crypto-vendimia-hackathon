# AutoStack

**WhatsApp DCA + Auto-Yield bot on Rootstock** — Dollar-cost average into Bitcoin from WhatsApp, with AI-powered commands and automatic yield generation.

> "Robinhood's recurring investments, but for Bitcoin, on WhatsApp, with AI that buys the dips and earns yield for you."

## What It Does

1. **Send a WhatsApp message** → "Buy 10 RBTC every week"
2. **AI parses your intent** → Creates a DCA order
3. **Bot executes swaps** on Uniswap V3 (Rootstock) at your chosen frequency
4. **Auto-deposits** purchased tokens into Sovryn lending for ~5% APY
5. **Smart DCA** — buys more when price dips, less when price spikes

No MetaMask. No wallet connect. Just WhatsApp.

## Architecture

```
WhatsApp User
    │ "invest $10 in Bitcoin every week"
    ▼
Kapso.ai (WhatsApp Cloud API)
    │ Webhook POST
    ▼
AutoStack Backend (Node.js / TypeScript)
    ├── AI Parser (Claude Haiku via OpenRouter)
    ├── Command Router (start, dca, balance, status, help...)
    ├── Wallet Manager (HD derivation per user)
    ├── Swap Executor (Uniswap V3 on Rootstock)
    ├── Yield Depositor (Sovryn iToken lending)
    ├── DCA Scheduler (cron, every minute)
    ├── Smart DCA (7-day SMA price analysis)
    └── Deposit Watcher (RBTC + rUSDT monitoring)
        │
        ▼
    Rootstock Blockchain (EVM, secured by Bitcoin hashrate)
```

## Features

- **Natural Language DCA** — "Buy 5 RBTC daily", "Stack 10 DOC every week"
- **Smart DCA** — Adjusts buy amounts based on price vs 7-day moving average
- **Auto-Yield** — DCA'd tokens auto-deposited into Sovryn lending (~5% APY)
- **Multi-Token** — RBTC, DOC, RIF, SOV, DLLR, rUSDT, USDC
- **Wallet Management** — HD wallet per user, balances, deposit detection
- **Order Management** — Pause, resume, cancel DCA orders via WhatsApp

## Tech Stack

| Layer | Technology |
|-------|-----------|
| WhatsApp API | [Kapso.ai](https://kapso.ai) |
| AI/NLP | Claude 3.5 Haiku via [OpenRouter](https://openrouter.ai) + local regex fallback |
| Blockchain | [Rootstock](https://rootstock.io) (EVM, Bitcoin sidechain) |
| DEX | Uniswap V3 (SwapRouter02 on RSK) |
| Yield | [Sovryn](https://sovryn.app) iToken lending |
| Backend | Node.js, TypeScript, Express |
| Database | SQLite via Drizzle ORM |
| Scheduling | node-cron |
| Hosting | [Railway](https://railway.app) |

## Rootstock Contract Addresses

| Contract | Address |
|----------|---------|
| SwapRouter02 | `0x0b14ff67f0014046b4b99057aec4509640b3947a` |
| QuoterV2 | `0xb51727c996c68e60f598a923a5006853cd2feb31` |
| Sovryn iRBTC | `0xa9dcdc63eabb8a2b6f39d7ff9429d88340044a7a` |
| WRBTC | `0x542fda317318ebf1d3deaf76e0b632741a7e677d` |

## Setup

### Prerequisites

- Node.js 20+
- [Kapso.ai](https://kapso.ai) account (free tier — 2,000 msgs/mo)
- [OpenRouter](https://openrouter.ai) API key
- [Railway](https://railway.app) account (for deployment)

### Install

```bash
git clone https://github.com/LucianoLupo/crypto-vendimia-hackathon.git
cd crypto-vendimia-hackathon
npm install
```

### Environment Variables

```bash
cp .env.example .env
```

| Variable | Description | Required |
|----------|-------------|----------|
| `KAPSO_API_KEY` | Kapso.ai API key | Yes |
| `KAPSO_WEBHOOK_SECRET` | Webhook HMAC secret from Kapso | Yes |
| `KAPSO_PHONE_NUMBER_ID` | WhatsApp phone number ID | Yes |
| `MASTER_MNEMONIC` | BIP39 mnemonic for HD wallet derivation | Yes |
| `RSK_RPC_URL` | Rootstock RPC (`https://public-node.rsk.co`) | Yes |
| `OPENROUTER_API_KEY` | OpenRouter API key for AI parsing | Optional* |
| `PORT` | Server port (default: 3000) | No |

*Common commands (help, balance, status, start, DCA patterns) work via local regex without any API key. OpenRouter is only needed for natural language parsing ("I want to invest 5 dollars in bitcoin every week").

### Run

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

### Deploy to Railway

```bash
railway init
railway up
railway domain  # Get your public URL
```

Then set the Railway URL + `/webhook` as your Kapso webhook endpoint.

## WhatsApp Commands

| Command | Example |
|---------|---------|
| **Start** | "hello", "start" |
| **DCA** | "buy 10 RBTC daily", "stack 5 DOC weekly" |
| **Balance** | "check my balance", "balance" |
| **Status** | "show my orders", "status" |
| **Pause** | "pause order #3" |
| **Resume** | "resume" |
| **Cancel** | "cancel order #2" |
| **Deposit** | "deposit", "my address" |
| **Help** | "help" |

## How DCA + Yield Works

```
User sets up: "Buy 10 rUSDT worth of RBTC daily"
    │
    ▼ Every day (cron scheduler)
    │
    ├── Smart DCA checks price vs 7-day SMA
    │   ├── Price 5%+ below SMA → buy 15 rUSDT (50% more)
    │   ├── Price 5%+ above SMA → buy 5 rUSDT (50% less)
    │   └── Normal range → buy 10 rUSDT (base amount)
    │
    ├── Execute swap on Uniswap V3 (rUSDT → RBTC)
    │
    ├── Auto-deposit RBTC into Sovryn iRBTC (~5% APY)
    │
    └── Notify user via WhatsApp with tx links
```

## Project Structure

```
src/
├── index.ts                  # Express app entry
├── config/
│   ├── env.ts                # Zod-validated environment
│   └── tokens.ts             # RSK token/contract addresses
├── db/
│   ├── schema.ts             # Drizzle schema (users, orders, executions)
│   └── index.ts              # SQLite + queries
├── routes/
│   └── webhook.ts            # Kapso webhook handler
└── services/
    ├── parser.ts             # AI intent parser (local regex + Claude 3.5 Haiku via OpenRouter)
    ├── commands.ts           # Command router & handlers
    ├── wallet.ts             # HD wallet derivation
    ├── swap.ts               # Uniswap V3 swap execution
    ├── yield.ts              # Sovryn iToken deposit/withdraw
    ├── scheduler.ts          # Cron-based DCA execution
    ├── smart-dca.ts          # Price vs SMA analysis
    ├── deposit-watcher.ts    # Balance change detection
    └── whatsapp.ts           # Kapso message sender
```

## Built For

[Vendimia Hackathon](https://vendimia.io) — Crypto / Web3 / AI

## License

MIT
