# SatsPilot Audit Fixes Plan

Based on AUDIT-REPORT.md findings from 6 expert agents. Organized into waves that can be executed with parallel sub-agents where dependencies allow.

---

## Wave 1 — Quick Wins (1-3 min each, no dependencies)

These are single-line or few-line fixes that don't depend on each other. Can all run in parallel.

### 1A. Re-enable webhook HMAC verification
**File:** `src/routes/webhook.ts:56-59`
**Fix:** Add `return res.status(401)` after signature mismatch. Remove the "allowing through" bypass.
**Audit ref:** P0-4

### 1B. Validate `fromToken` against SUPPORTED_TOKENS
**File:** `src/services/commands.ts:112`
**Fix:** After `const fromToken = params.fromToken ?? 'RUSDT'`, add validation:
```typescript
if (!SUPPORTED_TOKENS.includes(fromToken.toUpperCase())) {
  await sendMessage(whatsappId, `Token fuente "${fromToken}" no soportado.`);
  return;
}
```
Also normalize: `const fromToken = (params.fromToken ?? 'RUSDT').toUpperCase();`
**Audit ref:** P1-5

### 1C. Guard against fromToken === toToken
**File:** `src/services/commands.ts` (after fromToken validation)
**Fix:** Add check:
```typescript
if (fromToken === normalizedToken) {
  await sendMessage(whatsappId, 'El token de origen y destino no pueden ser el mismo.');
  return;
}
```
**Audit ref:** P2-5

### 1D. Fix frequency error message to Spanish
**File:** `src/services/commands.ts:106-108`
**Fix:** Change "Usa: hourly, daily o weekly" to "Usa: cada hora, diario o semanal"
**Audit ref:** P3-5

### 1E. Remove unused env vars from schema
**File:** `src/config/env.ts`
**Fix:** Remove `ANTHROPIC_API_KEY` and `WALLET_ENCRYPTION_KEY` from schema. Remove `Env` type export.
**Audit ref:** P3-7

### 1F. Use validated env for OpenRouter key
**File:** `src/services/parser.ts:128`
**Fix:** Import `env` and use `env.OPENROUTER_API_KEY` instead of `process.env.OPENROUTER_API_KEY`.
Add `OPENROUTER_API_KEY` to env schema as optional.
**Audit ref:** P1-10

### 1G. Rename DB file to satspilot.db
**File:** `src/db/index.ts:7`
**Fix:** Change `./autostack.db` to `./satspilot.db`
**Audit ref:** P3-2

### 1H. Reduce log spam
**Files:** `src/services/scheduler.ts`, `src/services/deposit-watcher.ts`
**Fix:** Remove the "Tick — checking due orders..." and "Checking wallet balances..." logs that fire every 60s. Keep only meaningful logs (found N orders, deposit detected, etc).
**Audit ref:** P3-4

---

## Wave 2 — On-Chain Verification (requires RPC calls)

### 2A. Verify token decimals on-chain
**File:** `src/config/tokens.ts:25-33`
**Action:** Query `decimals()` on each token contract on RSK mainnet. Update TOKEN_DECIMALS with real values.
**Critical for:** rUSDT and USDC which could be 6 instead of 18.
**Audit ref:** P0-6

### 2B. Verify SwapRouter02 ABI — does it include deadline in struct?
**File:** `src/services/swap.ts:12-14`
**Action:** Fetch the contract ABI from RSK explorer or call the function selector to determine if the deployed contract is SwapRouter (with deadline in struct) or SwapRouter02 (deadline via multicall).
**Audit ref:** P0-2

### 2C. Verify Sovryn iRBTC mint semantics
**File:** `src/services/yield.ts:40`
**Action:** Check the deployed iRBTC contract — does `mint(address, depositAmount)` expect `depositAmount == msg.value` or `depositAmount == 0` with `msg.value`?
**Audit ref:** P1-12

---

## Wave 3 — WRBTC/RBTC Fix (depends on 2B)

### 3A. Fix WRBTC/native RBTC confusion
**Files:** `src/services/swap.ts`, `src/services/yield.ts`
**Fix:** After Uniswap V3 swap, the output is WRBTC (ERC-20), not native RBTC. Options:
- Option A: Add `WRBTC.withdraw()` call after swap to unwrap to native RBTC, then yield deposit works as-is
- Option B: Change yield deposit to handle WRBTC directly (ERC-20 approval + mint)
- Option C: Use SwapRouter02's `multicall` with `unwrapWETH9` for atomic unwrap
**Also fix:** Balance measurement — check WRBTC ERC-20 balance, not native balance, for swap output
**Audit ref:** P0-3

---

## Wave 4 — Resilience & Safety (parallel, no cross-deps)

### 4A. Add RPC timeout to provider
**File:** `src/services/wallet.ts`
**Fix:** Configure ethers.js provider with timeout:
```typescript
_provider = new JsonRpcProvider(env.RSK_RPC_URL, { chainId: 30 }, { staticNetwork: true });
```
Also add periodic health check or recreate on failure.
**Audit ref:** P1-1, P1-2, P2-8

### 4B. Add circuit breaker for failed DCA orders
**Files:** `src/services/scheduler.ts`, `src/db/schema.ts`, `src/db/index.ts`
**Fix:** Add `failure_count` column to dca_orders. Increment on failure. After 3 consecutive failures, auto-pause the order and notify user. Reset on success.
**Audit ref:** P1-4

### 4C. Pre-check gas balance before swap
**File:** `src/services/scheduler.ts`
**Fix:** Before `executeSwap()`, check `provider.getBalance(wallet.address)` against minimum gas threshold (~0.00001 RBTC). Skip order with user notification if insufficient.
**Audit ref:** P1-6, P2-6

### 4D. Fix DCA execution time drift
**Files:** `src/services/scheduler.ts:14-28`, `src/services/commands.ts:29-35`
**Fix:** Extract `calcNextExecution` to shared utility. Calculate next execution from the SCHEDULED time, not from `new Date()`:
```typescript
function calcNextExecution(frequency: string, fromTime: string): string {
  const next = new Date(fromTime);
  // ... add interval
}
```
**Audit ref:** P1-7, P2-7

### 4E. Suppress false-positive deposit notifications after DCA
**File:** `src/services/deposit-watcher.ts`
**Fix:** Track a `lastDcaExecution` timestamp per user. Skip deposit notification if a DCA executed within the last 2 minutes for that user.
**Audit ref:** P1-9

---

## Wave 5 — UX Polish (parallel)

### 5A. Add accent marks to all Spanish strings
**Files:** `src/services/commands.ts`, `src/services/scheduler.ts`, `src/services/deposit-watcher.ts`, `src/services/smart-dca.ts`
**Fix:** Replace all unaccented words:
- direccion → dirección, ejecución, próxima, depósito, canceló, pausó, reanudó, etc.
**Audit ref:** P3-1

### 5B. Add emoji to WhatsApp status messages
**File:** `src/services/commands.ts:182-183`
**Fix:** Replace `[ok]` → ✅, `[error]` → ❌, `[pendiente]` → ⏳
Also add relevant emoji to key messages (wallet 🏦, swap 🔄, yield 📈, etc.)
**Audit ref:** P3-3

### 5C. Define status constants
**New file:** `src/config/constants.ts`
**Fix:** Create:
```typescript
export const ORDER_STATUS = { ACTIVE: 'active', PAUSED: 'paused', CANCELLED: 'cancelled' } as const;
export const EXEC_STATUS = { COMPLETED: 'completed', FAILED: 'failed', PENDING: 'pending' } as const;
```
Replace all raw status strings across codebase.
**Audit ref:** P1-11

### 5D. Extract shared ERC20_ABI and calcNextExecution
**Files:** `src/config/tokens.ts` (add ERC20_ABI), `src/utils/time.ts` (new, calcNextExecution)
**Fix:** Remove duplicated ABI from wallet.ts, swap.ts, yield.ts. Remove duplicated calcNextExecution.
**Audit ref:** P1-7, P2-15

### 5E. Add graceful shutdown handler
**File:** `src/index.ts`
**Fix:**
```typescript
process.on('SIGTERM', () => { stopScheduler(); stopDepositWatcher(); process.exit(0); });
process.on('SIGINT', () => { stopScheduler(); stopDepositWatcher(); process.exit(0); });
```
**Audit ref:** P3-8

---

## Wave 6 — Smart DCA Completeness (after waves 1-5)

### 6A. Add CoinGecko ID mapping for all supported tokens
**File:** `src/services/smart-dca.ts`
**Fix:** Add mappings for DLLR, rUSDT, USDC. For tokens without CoinGecko IDs, use the Uniswap quote as price source instead.
**Audit ref:** P2-1

### 6B. Warn users about auto-yield token limitations
**File:** `src/services/commands.ts` (handleDca)
**Fix:** When creating a DCA order for a token NOT in YIELD_MAP (RIF, SOV, RUSDT, USDC), inform user that auto-yield is not available for this token.
**Audit ref:** P2-2

---

## Wave 7 — Final Verification

### 7A. Compile check
Run `npx tsc --noEmit` — must pass with 0 errors.

### 7B. Deploy to Railway
`railway up --detach`

### 7C. End-to-end test via WhatsApp
1. Send "hola" → verify Spanish welcome + wallet
2. Send "ayuda" → verify command list with accents + emoji
3. Send "saldo" → verify balance display
4. Send "comprar 1 RBTC diario" → verify DCA creation with quote
5. Send "estado" → verify status with emoji icons
6. Send "cancelar" → verify cancellation

### 7D. Update README if any new features/behaviors changed

---

## Dependency Graph

```
Wave 1 (all parallel, no deps)
    │
    ▼
Wave 2 (on-chain verification, parallel)
    │
    ├── 2B result needed for Wave 3
    ▼
Wave 3 (WRBTC fix, depends on 2B)
    │
    ▼
Wave 4 + Wave 5 (parallel, no cross-deps)
    │
    ▼
Wave 6 (Smart DCA, after core is stable)
    │
    ▼
Wave 7 (verification)
```

## Estimated Total Effort
- Wave 1: ~15 min (8 quick fixes)
- Wave 2: ~30 min (on-chain queries)
- Wave 3: ~30 min (WRBTC/RBTC fix)
- Wave 4: ~45 min (resilience)
- Wave 5: ~30 min (UX polish)
- Wave 6: ~15 min (Smart DCA)
- Wave 7: ~15 min (verify + deploy)

**Total: ~3 hours**
