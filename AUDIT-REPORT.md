# SatsPilot Deep Audit Report

**Date:** 2026-03-26
**Auditors:** 6 parallel expert sub-sessions (Blockchain Correctness, Integration Gaps, Error Scenarios, Demo Readiness, Codebase Hygiene, Blind Spots)
**Codebase:** `/Users/lucianolupo/projects/crypto-vendimia-hackathon` — commit `a0d9265` (main)
**Scope:** All 15 TypeScript source files, README.md, package.json, config

---

## Executive Summary

SatsPilot is a WhatsApp-based DCA bot on Rootstock with a compelling value proposition (WhatsApp + crypto for LatAm). However, the codebase has **6 P0 critical issues** that would cause fund loss, broken UX, or security breaches in production. The most impactful is a one-character bug where every successful DCA execution reports as a failure to the user.

| Priority | Count | Theme |
|----------|-------|-------|
| **P0** | 6 | Broken notifications, ABI mismatch, WRBTC confusion, auth bypass, mnemonic security, decimal errors |
| **P1** | 12 | No timeouts, no circuit breaker, silent send failures, missing validation, duplicated logic, scale issues |
| **P2** | 18 | Smart DCA gaps, race conditions, type safety, chain reorgs, prompt injection, message ordering |
| **P3** | 12 | DB filename, log spam, accents, derivation path, regulatory, persistence |

---

## P0 — Critical (Fix before any usage)

### P0-1: Success notification NEVER sent — status value mismatch
**File:** `src/services/scheduler.ts:54,104`
**Found by:** All 6 experts

The scheduler initializes `executionStatus = 'completed'` (line 54), but the notification branch checks `executionStatus === 'success'` (line 104). These never match. **100% of successful DCA executions send the failure message** to users:

```
"Fallo la ejecucion DCA de 10 RUSDT → RBTC. Error: null"
```

The success message block (lines 105-118) is **dead code**. Users believe every DCA is failing when they're actually succeeding.

**Fix:** Change line 104 from `=== 'success'` to `=== 'completed'`. One-character fix.

---

### P0-2: SwapRouter02 ABI mismatch — `deadline` field position
**File:** `src/services/swap.ts:12-14`, `src/config/tokens.ts:13`
**Found by:** Expert 1 (Blockchain Correctness)

The code uses the **original SwapRouter** ABI signature with `deadline` inside the `ExactInputSingleParams` struct. The canonical **SwapRouter02** removes `deadline` from the struct and passes it via `multicall(uint256 deadline, bytes[] data)`.

If the deployed contract at `0x0b14ff67f0014046b4b99057aec4509640b3947a` is SwapRouter02, the ABI encoding shifts all fields by one slot:
- `deadline` (timestamp ~1.7B) gets interpreted as `amountIn`
- `amountIn` gets interpreted as `amountOutMinimum`
- Every swap either reverts or produces undefined behavior

**Fix:** Verify the deployed contract version. If SwapRouter02, remove `deadline` from struct and wrap call in `multicall(deadline, [encodedSwapCall])`. If original SwapRouter, rename the config key.

---

### P0-3: WRBTC/native RBTC confusion — swap output + yield deposit broken
**Files:** `src/services/swap.ts:108-109,144-175`, `src/services/yield.ts:17-21,38-40`, `src/services/scheduler.ts:71-76`
**Found by:** Experts 1, 2, 6

Three interrelated bugs:

1. **Swap output measurement is wrong:** When `toToken === 'RBTC'`, `resolveTokenAddress` returns the WRBTC ERC-20 address. Uniswap sends **WRBTC tokens** to the wallet. But the code checks **native RBTC** balance (`provider.getBalance()`). `actualOut ≈ 0` (or negative due to gas), so it falls back to `amountOutMinimum` — a wrong estimate.

2. **Yield deposit fails:** `YIELD_MAP` marks RBTC as `isNative: true`, so `depositToYield` calls `iToken.mint()` with `{ value: parsedAmount }`, sending native RBTC. But the wallet holds **WRBTC tokens**, not native RBTC. The transaction reverts.

3. **No WRBTC unwrap:** There is no `WRBTC.withdraw()` call anywhere. Users accumulate WRBTC they may not know how to use.

**Fix:** Either (a) check WRBTC ERC-20 balance instead of native, add `WRBTC.withdraw()` after swap, or (b) use SwapRouter02's `multicall` with `unwrapWETH9` for atomic unwrap.

---

### P0-4: Webhook HMAC verification disabled — complete auth bypass
**File:** `src/routes/webhook.ts:56-59`
**Found by:** Experts 3, 4, 6

```typescript
if (!verifyHmacSignature(rawBody, signature)) {
    console.log('[webhook] Signature mismatch — allowing through for hackathon');
    // No return! No 401! Processing continues.
}
```

Failed signature checks are logged but **not rejected**. Any HTTP client can forge webhook events as any phone number: create orders, cancel orders, view wallet addresses, trigger swaps. Combined with no replay protection (message IDs are not tracked), captured payloads can be replayed indefinitely.

**Fix:** Add `return res.status(401).json({ error: 'Invalid signature' })` after the log. Add message ID deduplication.

---

### P0-5: Master mnemonic — single point of failure for all user funds
**Files:** `src/config/env.ts:8`, `src/services/wallet.ts:24-25`
**Found by:** Expert 3

All user wallets are derived from a single `MASTER_MNEMONIC` via HD path `m/44'/137'/0'/0/{index}`. The mnemonic is stored as a plaintext environment variable. Compromise of this single value exposes **every user's funds**.

Risk vectors: `.env` file on disk, `/proc/PID/environ`, error stack traces, deployment platform dashboard, process manager logs. The declared `WALLET_ENCRYPTION_KEY` env var (`env.ts:13`) was never implemented.

**Fix:** For hackathon: acknowledge in README as a known limitation. For production: implement per-user key derivation with encryption at rest.

---

### P0-6: Token decimals potentially wrong — USDC/rUSDT listed as 18
**File:** `src/config/tokens.ts:25-33`, `src/services/wallet.ts:43`
**Found by:** Experts 1, 6

All tokens in `TOKEN_DECIMALS` are hardcoded to 18. USDC and rUSDT are commonly 6 decimals on many chains. If RSK's rUSDT at `0xef213441a85df4d7acbdae0cf78004e1e486bb96` uses 6 decimals:
- `parseUnits("10", 18)` produces `10^19` instead of `10^7` — a swap of 10 trillion units
- `getTokenBalance` at `wallet.ts:43` hardcodes `formatUnits(raw, 18)` — all balances display wrong by 10^12

**Fix:** Query each contract's `decimals()` function on RSK mainnet and update `TOKEN_DECIMALS`. Use the config values in `getTokenBalance` instead of hardcoding 18.

---

## P1 — High (Should fix before demo/production)

### P1-1: No RPC timeouts — silent hangs block scheduler permanently
**Files:** `src/services/swap.ts:57`, `src/services/wallet.ts:32`, `src/services/yield.ts:43-52`, `src/services/deposit-watcher.ts:19-22`
**Found by:** Expert 3

No timeouts on any ethers.js RPC call. A slow/hanging RPC node causes:
- `processDueOrders()` hangs indefinitely on one order, blocking all subsequent orders
- The `isProcessing` guard (`scheduler.ts:31`) means a hung order **permanently blocks the scheduler**
- No crash, no error, no timeout — just frozen processing

**Fix:** Add timeouts to RPC calls. Use `Promise.race` with a timeout or configure ethers.js provider timeout.

---

### P1-2: Provider singleton with no reconnection
**File:** `src/services/wallet.ts:14-20`
**Found by:** Experts 1, 3

The `JsonRpcProvider` is created once and cached. If the RPC connection drops (common for 24/7 bots), all subsequent operations fail until process restart. No health check, no reconnection logic, no provider rotation.

**Fix:** Add periodic health check (`eth_blockNumber` on a timer), recreate provider on failure. Consider a fallback RPC URL.

---

### P1-3: WhatsApp send failures silently swallowed
**File:** `src/services/whatsapp.ts:23-31`
**Found by:** Expert 3

If the Kapso API returns non-200 or throws, the error is logged but `sendMessage` does NOT throw. Every caller succeeds even if the message was never delivered. Users never receive DCA execution results, deposit confirmations, or error messages. No retry mechanism.

**Fix:** Throw on non-200 responses, or return a success boolean that callers check.

---

### P1-4: No circuit breaker — failed orders retry infinitely
**File:** `src/services/scheduler.ts:100-101`
**Found by:** Experts 3, 6

After a failed execution, `updateOrderNextExecution` schedules the next attempt with no retry limit or backoff. An order that fails due to insufficient balance fires and fails every cycle forever, potentially draining RBTC gas balance on reverts.

**Fix:** Add a failure counter. After N consecutive failures (e.g., 3), auto-pause the order and notify the user.

---

### P1-5: fromToken never validated in DCA order creation
**File:** `src/services/commands.ts:112`
**Found by:** Expert 2

`toToken` is validated against `SUPPORTED_TOKENS` (line 95), but `fromToken` is stored directly without validation. The LLM can return any value. A bad `fromToken` creates an order that fails at swap execution time, every cycle, forever (see P1-4).

**Fix:** Validate `fromToken` against `SUPPORTED_TOKENS` before creating the order.

---

### P1-6: No gas balance check before swap execution
**Files:** `src/services/scheduler.ts:59-86`, `src/services/swap.ts:100-182`
**Found by:** Experts 3, 6

No check for sufficient RBTC gas before transactions. For ERC-20 swaps: approval costs gas, then the swap reverts — double gas waste. Users who deposit only ERC-20 tokens get stuck in an infinite failure loop.

**Fix:** Check `provider.getBalance(wallet.address)` against estimated gas cost before executing.

---

### P1-7: `calcNextExecution` duplicated with different behavior
**Files:** `src/services/commands.ts:29-35`, `src/services/scheduler.ts:14-28`
**Found by:** Expert 5

Two implementations: commands.ts uses `if/else` chain (returns `now` for unknown frequency), scheduler.ts uses `switch/case` (defaults to daily). Behavior diverges on edge cases.

**Fix:** Extract to a single shared utility function.

---

### P1-8: Scheduler processes orders sequentially — O(n) RPC calls per tick
**File:** `src/services/scheduler.ts:40-130`
**Found by:** Expert 6

Each order requires ~5 RPC calls taking 2-5 seconds. At 100 orders: 200-500s per tick vs 60s cron interval. The `isProcessing` guard silently skips ticks, causing unbounded delay. At scale, DCA orders execute hours late.

**Fix:** For hackathon scale this is fine. For production: parallelize with concurrency limit, or use batched RPC calls.

---

### P1-9: Deposit watcher fires false positives on DCA swaps
**File:** `src/services/deposit-watcher.ts:12-56`
**Found by:** Expert 6

Polls balances every 60s. When a DCA swap deposits tokens, the watcher detects the balance increase and sends a spurious "Deposito detectado!" notification on top of the DCA notification. Double-notification confuses users.

**Fix:** Either track DCA-originated balance changes, or add a cooldown after DCA executions.

---

### P1-10: `process.env` access bypasses centralized env config
**File:** `src/services/parser.ts:128`
**Found by:** Expert 5

`const openRouterKey = process.env.OPENROUTER_API_KEY` bypasses the Zod-validated `env` object from `config/env.ts`.

**Fix:** Use `env.OPENROUTER_API_KEY`.

---

### P1-11: Status strings scattered without central enum
**Files:** Multiple across `scheduler.ts`, `commands.ts`, `schema.ts`, `db/index.ts`
**Found by:** Expert 5

Order statuses (`'active'`, `'paused'`, `'cancelled'`, `'completed'`, `'failed'`) and execution statuses (`'completed'`, `'success'`, `'failed'`) appear as raw strings with no single source of truth. The P0-1 bug was caused by this exact problem.

**Fix:** Define `ORDER_STATUS` and `EXECUTION_STATUS` const objects or union types.

---

### P1-12: Sovryn iRBTC `mint` call — depositAmount semantics unverified
**File:** `src/services/yield.ts:40`
**Found by:** Expert 1

```typescript
tx = await iToken.mint(wallet.address, parsedAmount, { value: parsedAmount });
```

Some Sovryn versions expect `depositAmount = 0` with `msg.value`, others require `depositAmount == msg.value`. If the deployed contract expects `depositAmount = 0`, all yield deposits revert.

**Fix:** Verify against the deployed Sovryn contract's ABI.

---

## P2 — Medium (Quality, correctness, UX)

### P2-1: Smart DCA only works for 4 of 7 supported tokens
**File:** `src/services/smart-dca.ts:1-6`
Missing CoinGecko IDs for DLLR, RUSDT, USDC. Smart DCA silently falls back to base amount for these tokens. README advertises it as a core feature without this caveat.

### P2-2: Auto-yield defaults to ON but only supports 3 of 7 tokens
**Files:** `src/services/yield.ts:17-21`, `src/db/schema.ts:20`
Orders for RIF, SOV, RUSDT, USDC attempt yield deposit and fail with "Token X not supported for yield." No way for user to disable auto-yield.

### P2-3: Race condition in `getOrCreateUser` — walletIndex collision
**File:** `src/db/index.ts:62-91`
`max(walletIndex)` read + insert is not atomic. Concurrent new user registrations can collide. SQLite UNIQUE constraint catches it, but error is unhandled gracefully.

### P2-4: Yield `iTokensReceived` returns deposit amount, not actual minted tokens
**File:** `src/services/yield.ts:54`
`parsedAmount` is the INPUT amount, not the iTokens minted. The iToken exchange rate means actual received differs. Fix: parse `Mint` event from transaction receipt.

### P2-5: No guard against `fromToken === toToken`
**File:** `src/services/commands.ts:71-137`
Users could create a self-swap DCA that loses money to fees every cycle.

### P2-6: Scheduler doesn't pre-check wallet balance before swap
**File:** `src/services/scheduler.ts:59-86`
`ensureApproval` costs gas even when the swap will revert due to insufficient balance.

### P2-7: DCA execution time drifts
**Files:** `src/services/scheduler.ts:14-28`, `src/services/commands.ts:29-35`
`calcNextExecution` adds interval to `new Date()` (current time), not to the scheduled time. Over 30 days, a daily order could drift 30+ minutes.

### P2-8: No chain ID validation on provider
**File:** `src/services/wallet.ts:17-20`
Provider created without specifying `chainId: 30`. Misconfigured RPC URL could send transactions to wrong network.

### P2-9: No minimum output validation against oracle price
**File:** `src/services/swap.ts:115-121`
Slippage is relative to the Uniswap quote, not a market oracle. Low-liquidity pools produce bad quotes; 1% slippage applies to an already-bad price.

### P2-10: LLM prompt injection via user message
**File:** `src/services/parser.ts:146-153`
User message is passed directly as `user` content to Claude. Backend validation mitigates worst outcomes, but combined with P0-4, an attacker could trigger actions on other users' behalf.

### P2-11: Message processing is fire-and-forget with no ordering
**File:** `src/routes/webhook.ts:99-101`
Messages dispatched without `await`. Rapid messages from same user process concurrently — cancel could execute before DCA creation.

### P2-12: No message deduplication
**File:** `src/routes/webhook.ts:82-101`
Message ID is available but never checked. Redelivered webhooks create duplicate orders.

### P2-13: Schema defined twice (Drizzle ORM + raw SQL)
**Files:** `src/db/schema.ts`, `src/db/index.ts:10-50`
Raw SQL `CREATE TABLE IF NOT EXISTS` duplicates the Drizzle schema and can drift.

### P2-14: Chain reorg not handled
**File:** `src/services/swap.ts:162-163`
`tx.wait()` with 1 confirmation. RSK can have 2-3 block reorgs. A confirmed swap could silently revert.

### P2-15: ERC20 ABI duplicated across 3 files
**Files:** `src/services/wallet.ts:12`, `src/services/swap.ts:20-23`, `src/services/yield.ts:12-15`
Four separate ABI definitions for ERC20 fragments. Extract to shared constant.

### P2-16: Token approval logic duplicated
**Files:** `src/services/swap.ts:74-98` (ensureApproval), `src/services/yield.ts:42-47` (inline)
Yield reimplements approval instead of calling shared `ensureApproval`.

### P2-17: Unsafe `as` type assertions on JSON responses
**Files:** `webhook.ts:64`, `smart-dca.ts:17,33`, `parser.ts:163-164`
All parse JSON and assert types without runtime validation. Zod is already a dependency.

### P2-18: Executions table grows unbounded — no cleanup, no indexes
**Files:** `src/db/schema.ts:27-39`, `src/db/index.ts:142-144`
No cleanup mechanism. With 100 hourly orders: 876K rows/year. No indexes on `user_id`, `dca_order_id`, or `executed_at`. Queries get progressively slower.

---

## P3 — Low (Polish, best practices)

### P3-1: Missing accent marks in ALL Spanish strings
**Files:** Throughout `commands.ts`, `scheduler.ts`, `deposit-watcher.ts`
Every accent is missing: "direccion" → "dirección", "ejecucion" → "ejecución", "Proxima" → "Próxima". Noticeable to any native Spanish speaker.

### P3-2: Database filename still named `autostack.db`
**File:** `src/db/index.ts:7`
Project rebranded from AutoStack to SatsPilot but DB filename not updated.

### P3-3: Status icons are plain text instead of emoji
**File:** `src/services/commands.ts:182-183`
Renders `[ok]`, `[error]`, `[pendiente]` — looks like debug output in WhatsApp. Use ✅, ❌, ⏳.

### P3-4: Scheduler/deposit-watcher log spam every 60 seconds
**Files:** `src/services/scheduler.ts:138`, `src/services/deposit-watcher.ts:65`
`[scheduler] Tick` and `[deposit-watcher] Checking` fire every minute. Clutters demo logs.

### P3-5: Frequency error message shows English values to Spanish users
**File:** `src/services/commands.ts:106-108`
Shows "Usa: hourly, daily o weekly" but regex accepts Spanish: "diario, semanal, cada hora".

### P3-6: HD derivation path uses coin type 137 (Polygon) not 30 (RSK)
**File:** `src/services/wallet.ts:25`
`m/44'/137'/0'/0` — technically valid but non-standard for RSK. MetaMask import would derive different addresses.

### P3-7: Unused env vars: `ANTHROPIC_API_KEY`, `WALLET_ENCRYPTION_KEY`
**File:** `src/config/env.ts:10,13`
Declared as optional but never referenced. Dead configuration.

### P3-8: No graceful shutdown handler
**File:** `src/index.ts`
No SIGTERM/SIGINT handler. `stopScheduler()` and `stopDepositWatcher()` are exported but never called.

### P3-9: Verbose ethers.js error objects in console.error
**Files:** `swap.ts:69,95,179`, `yield.ts:56`, `scheduler.ts:44,77,83,128`
Full error objects may contain RPC URLs, gas estimates, ABI data. Log only `err.message`.

### P3-10: SQLite on ephemeral filesystem (Railway)
**File:** `src/db/index.ts:7`
Relative path `./autostack.db`. On Railway, redeploy **deletes all user data**. README doesn't mention this.

### P3-11: No rate limiting on webhook endpoint
**File:** `src/routes/webhook.ts:46-104`
An attacker can flood the webhook, exhausting OpenRouter credits, Kapso quota, and RPC rate limits.

### P3-12: Regulatory — no KYC/AML, no cumulative limits
No identity verification beyond phone number. No per-user transaction limits, sanctions checking, or suspicious activity monitoring. A user could move ~$1M/month through the system.

---

## DCA Execution Path — End-to-End Trace

```
1.  WhatsApp msg → Kapso → POST /webhook (webhook.ts:46)
2.  HMAC check: logged but NON-BLOCKING ← P0-4
3.  Payload parsed, batch iterated (webhook.ts:80-101)
4.  processMessage(phone, text) — fire-and-forget ← P2-11
5.  parseMessage: regex local → LLM fallback (parser.ts:121-191)
6.  getOrCreateUser(phone) — race condition ← P2-3
7.  New user redirect: handleStart creates wallet, returns early (commands.ts:353)
8.  handleDca validates toToken ✓, amount ✓, frequency ✓
9.  fromToken NOT validated ← P1-5
10. createDCAOrder stores in DB (commands.ts:115-123)
11. getQuote for confirmation (commands.ts:127) ← P0-2 (ABI may be wrong)
12. WhatsApp confirmation sent (commands.ts:133) ← P1-3 (send may silently fail)

--- Scheduler (every minute) ---

13. getDueOrders: status='active' AND nextExecution <= now
14. For each order: lookup user, derive wallet (scheduler.ts:42-48)
15. calculateSmartAmount: CoinGecko price vs 7d SMA ← P2-1 (only 4/7 tokens)
16. executeSwap(wallet, fromToken, toToken, amount)
    16a. resolveTokenAddress: RBTC → WRBTC address (swap.ts:27)
    16b. getQuote via QuoterV2 ← P0-2 (ABI mismatch)
    16c. ensureApproval if not native ← P2-6 (gas waste if underfunded)
    16d. exactInputSingle on SwapRouter02 ← P0-2
    16e. Balance measurement: WRONG for RBTC output ← P0-3
17. depositToYield if autoYield=1
    17a. RBTC: tries native RBTC but wallet has WRBTC ← P0-3
    17b. RIF/SOV/RUSDT/USDC: throws unsupported ← P2-2
18. logExecution to DB (scheduler.ts:88-98) ✓
19. updateOrderNextExecution ← no circuit breaker (P1-4)
20. Send WhatsApp notification
    20a. Status check: 'completed' !== 'success' → ALWAYS failure msg ← P0-1
```

---

## Top 10 Fixes by Impact (Effort-Sorted)

| # | Fix | Effort | Impact | Files |
|---|-----|--------|--------|-------|
| 1 | Change `'success'` → `'completed'` in status check | 1 min | Fixes broken core UX | `scheduler.ts:104` |
| 2 | Add `return res.status(401)` on HMAC failure | 2 min | Closes auth bypass | `webhook.ts:58` |
| 3 | Validate `fromToken` against SUPPORTED_TOKENS | 3 min | Prevents permanent failure orders | `commands.ts:112` |
| 4 | Verify token decimals on-chain | 10 min | Prevents catastrophic amount errors | `tokens.ts:25-33` |
| 5 | Fix frequency error message to Spanish | 1 min | UX consistency | `commands.ts:106` |
| 6 | Add emoji to WhatsApp messages | 15 min | Looks like a real product | `commands.ts`, `scheduler.ts` |
| 7 | Verify SwapRouter ABI against deployed contract | 30 min | Prevents all swap failures | `swap.ts:12-14` |
| 8 | Add WRBTC unwrap step or fix balance check | 30 min | Fixes RBTC DCA + yield | `swap.ts`, `yield.ts` |
| 9 | Define status enums/constants | 20 min | Prevents future string mismatch bugs | New shared file |
| 10 | Add RPC timeout to swap operations | 15 min | Prevents scheduler deadlock | `swap.ts`, `yield.ts` |

---

## Innovation Angle Assessment

**Core differentiator (WhatsApp + DCA + RSK) is clear but undersold:**

1. **WhatsApp as crypto interface** — genuinely novel. Most crypto bots are Telegram/Discord. WhatsApp reaches a larger, less technical audience in LatAm. This should be the headline.

2. **Smart DCA (buy-the-dip automation)** — underplayed. Coinbase/Binance DCA doesn't do this. Highlight prominently.

3. **Auto-yield on Sovryn** — "Your DCA buys earn yield while you sleep" is a strong pitch line.

4. **Rootstock angle** — "Bitcoin-secured EVM chain" narrative is strong but unused in user-facing messages.

**Recommended lead for README:**
> "500M+ usuarios de WhatsApp en LatAm. Bitcoin es la alternativa, pero las wallets son complicadas. SatsPilot convierte WhatsApp en tu broker cripto: un mensaje, y tu DCA empieza a correr."

---

## Judge Question Readiness

| Question | Readiness |
|----------|-----------|
| "How do you handle private key security?" | ⚠️ Honest disclosure but no mitigation |
| "What happens if the RPC node is down?" | ❌ No retry/fallback |
| "How do you prevent double-execution?" | ✅ Concurrency guard exists |
| "What's the Smart DCA algorithm?" | ✅ SMA 7d vs current price |
| "Why SQLite?" | ✅ Hackathon scope — fine |
| "Do you have tests?" | ❌ Zero tests |
| "Revenue model?" | ❌ Not addressed |
| "Regulatory compliance?" | ❌ Not addressed |

---

*Report generated by 6 parallel expert sub-sessions, synthesized and deduplicated by coordinator agent.*
