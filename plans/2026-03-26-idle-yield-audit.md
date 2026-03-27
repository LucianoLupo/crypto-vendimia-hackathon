# Idle Yield Audit Report — Tropykus kDOC Integration

**Date:** 2026-03-26
**Target:** Plan at `plans/2026-03-26-idle-yield.md`
**Protocol:** Tropykus kDOC (Compound V2 fork on RSK Mainnet)
**Contract:** `0x544eb90e766b405134b3b3f62b6b4c23fcd5fda2`
**Method:** On-chain verification via `scripts/verify-kdoc.mjs` against `https://public-node.rsk.co`

---

## 1. On-Chain Verification Results

### 1.1 Contract Deployment — PASS

kDOC has live bytecode deployed (46,688 hex characters). The contract is active and responding to calls.

### 1.2 Underlying Token — PASS

`kDOC.underlying()` returns `0xe700691dA7b9851F2F35f8b8182c69c53CcaD9Db`, which matches the expected DOC address. Token metadata confirms: "Dollar on Chain" (DOC), 18 decimals.

### 1.3 Compound V2 Interface — PASS

All four required function selectors are present in the bytecode:

| Function | Selector | Found |
|----------|----------|-------|
| `mint(uint256)` | `0xa0712d68` | Yes |
| `redeem(uint256)` | `0xdb006a75` | Yes |
| `redeemUnderlying(uint256)` | `0x852a12e3` | Yes |
| `balanceOfUnderlying(address)` | `0x3af9e669` | Yes |

Successfully called `exchangeRateStored()`, `totalSupply()`, `totalBorrows()`, `getCash()`, and other Compound V2 view functions. The interface is confirmed standard Compound V2.

**Important ABI difference from Sovryn:** kDOC uses `mint(uint256 mintAmount) returns (uint256)`, not Sovryn's `mint(address receiver, uint256 depositAmount)`. The plan's ABI is correct. The existing `yield.ts` service uses Sovryn's ABI — it will NOT work for kDOC without a separate code path.

### 1.4 Exchange Rate — PASS (with correction)

| Metric | Value |
|--------|-------|
| `exchangeRateStored` (raw) | `26665901795296265` |
| 1 kDOC = | **0.02667 DOC** |
| 1 DOC mints = | **~37.5 kDOC** |

**Plan correction needed:** kDOC uses **18 decimals** (not 8 like standard Compound V2 cTokens). The exchange rate is scaled by `10^(18 - kDOC_decimals + DOC_decimals)` = `10^(18-18+18)` = `10^18`. Code must use `formatUnits(exchangeRateStored, 18)`, not the typical `10^28` for 8-decimal cTokens.

Cross-verification: `totalSupply * exchangeRate / 10^18` = **3,811,332 DOC** matches `getCash + totalBorrows - totalReserves` = **3,811,332 DOC**.

### 1.5 Market Health — CAUTION

| Metric | Value |
|--------|-------|
| Total assets (DOC) | 3,811,332 |
| Total borrows (DOC) | 3,146,671 |
| Cash available (DOC) | 676,833 |
| Total reserves (DOC) | 12,171 |
| **Utilization rate** | **82.56%** |
| Reserve factor | 40% |
| Supply APR | 5.11% |
| Borrow APR | 10.31% |
| Last accrual | ~2.6 hours ago (316 blocks) |

**Concern: High utilization at 82.56%.** Only 676,833 DOC is available as cash for withdrawals. If the DCA bot holds a significant fraction of this, a sudden withdrawal could fail if utilization spikes above ~95%. In Compound V2, `redeemUnderlying` reverts when `getCash < redeemAmount`. This is the primary liquidity risk.

However, the accrual recency (2.6 hours) suggests the market is actively used and maintained — not abandoned.

### 1.6 Comptroller & Pause Risk — PRESENT BUT NOT ACTIVE

| Check | Result |
|-------|--------|
| Comptroller address matches research | Yes (`0x962308...`) |
| `mintGuardianPaused(kDOC)` | **false** |
| `borrowGuardianPaused(kDOC)` | **false** |
| `transferGuardianPaused` | **false** |
| `seizeGuardianPaused` | **false** |
| kDOC listed in `getAllMarkets()` | Yes (8 total markets) |
| Comptroller admin | `0x784024A1F91564743Cf7c17f4D5E994A8ee002e7` |
| Pause guardian | `0xCd43D892BD81d1e6249c040D764A5DBd754094C2` |

**The pause guardian can pause minting and borrowing at any time.** The admin can also delist the market. Currently everything is active, but the bot must handle pause gracefully.

### 1.7 DOC ERC777 Check — PASS (NO REENTRANCY RISK)

| Check | Result |
|-------|--------|
| `granularity()` | Not implemented (reverts) |
| `defaultOperators()` | Not implemented (reverts) |
| ERC1820 Registry ERC777Token implementer | `0x0000...0000` (not registered) |

**DOC is NOT ERC777.** It is a standard ERC20 token. No reentrancy concerns from token hooks.

For comparison, rUSDT on RSK **does** have ERC777 selectors (`granularity`, `send`) in its bytecode, confirming the known ERC777 nature of rUSDT. DOC does not.

---

## 2. Safety Analysis: Withdraw-Swap-Redeposit Cycle

### The Proposed Flow

```
1. redeemUnderlying(dcaAmount)    → withdraw exact DOC from kDOC
2. approve(router, dcaAmount)     → approve DOC to SwapRouter
3. exactInputSingle(DOC → WRBTC)  → swap
4. mint(remainingDOC)             → redeposit remaining DOC into kDOC
```

### What If the Withdraw Fails?

**`redeemUnderlying` can fail for three reasons:**

1. **Insufficient liquidity** (`getCash < redeemAmount`): At 82.56% utilization, there is 676,833 DOC available. For typical DCA amounts ($10-$50), this is not a risk. But if utilization spikes to 95%+ (only ~190K DOC available), large withdrawals could revert.

2. **Market paused**: Compound V2 checks `redeemAllowed` in the Comptroller before redeeming. If the guardian pauses the market, all redeems revert.

3. **Exchange rate stale**: If `accrualBlockNumber` is very old, `redeemUnderlying` first calls `accrueInterest()`, which can consume extra gas. This is not a failure but adds gas cost unpredictability.

**Recommendation:** The plan MUST add a fallback path:
```
if redeemUnderlying fails:
  1. Try to execute DCA from any free DOC balance in wallet
  2. If no free DOC, skip this DCA cycle and notify user
  3. Do NOT silently swallow the error
```

The plan currently has no fallback. If `redeemUnderlying` reverts, the entire DCA cycle fails, matching the P1-4 issue from AUDIT-REPORT.md (no circuit breaker).

### Atomicity Concern

The 4-step cycle is **not atomic**. If step 1 succeeds but step 3 (swap) fails, DOC sits in the wallet un-parked. This is not fund loss — just missed yield until the next cycle re-deposits it. Acceptable for a hackathon, but log it and notify the user.

---

## 3. Gas Cost Analysis — THE ECONOMICS DON'T WORK FOR SMALL AMOUNTS

Current RSK gas price: **0.0261 Gwei** (extremely cheap compared to Ethereum).

| Operation | Gas Units | Cost (RBTC) | Cost (USD @ $85K BTC) |
|-----------|-----------|-------------|----------------------|
| ERC20 approve | ~46,000 | 0.0000012 | $0.10 |
| kDOC mint (deposit) | ~150,000-250,000 | 0.0000039-0.0000065 | $0.33-$0.55 |
| kDOC redeemUnderlying | ~150,000 | 0.0000039 | $0.33 |
| **Full idle-yield cycle** | **~596,000** | **0.0000155** | **$1.32** |
| Plain DCA (no yield) | ~296,000 | 0.0000077 | $0.66 |

**Extra gas per DCA cycle for idle yield: ~$0.66**

### Break-Even Analysis

At 5.11% APR, for the yield to cover the extra gas cost per daily DCA cycle:

```
Required idle DOC = ($0.66 * 365) / 0.0511 = ~$4,757
```

**For a daily DCA of $10:** The user needs **$4,757** sitting idle in kDOC just to break even on gas. Since a $10/day DCA depletes the pool, the actual idle amount shrinks every day, making break-even even harder.

**For a weekly DCA of $10:** Break-even is ~$680 idle DOC — more reasonable but still requires a meaningful deposit upfront.

**Verdict:** For the hackathon demo amounts ($10-$50 per DCA), idle yield is a **net negative** on gas economics. The feature makes sense narratively (for the pitch) but loses money in practice at small scale. Consider:

1. **Only deposit to kDOC if idle DOC > $100** (minimum threshold)
2. **Only withdraw/redeposit if the yield earned since last cycle > gas cost**
3. **For the demo:** mention the yield APR in the pitch but use amounts large enough ($500+) to make the economics work

---

## 4. Tropykus Pause / Liquidity Exhaustion Scenarios

### If kDOC Mint Gets Paused

- **Deposits fail**: `mint(amount)` reverts. The deposit-watcher auto-park step fails silently (currently no error handling for this in the plan).
- **Withdrawals may still work**: Compound V2 typically allows redeems even when minting is paused, but this is Comptroller-configurable. Need to check `redeemAllowed`.
- **Impact**: DCA continues to work (swap is independent), but DOC sits un-yielded.
- **Mitigation**: Catch mint failures gracefully, keep DOC in wallet, log warning. Do NOT retry indefinitely.

### If kDOC Market Runs Out of Liquidity

- `redeemUnderlying(amount)` reverts with "insufficient cash" when `getCash < amount`.
- Currently 676K DOC available. Would need massive borrowing to drain this.
- **Mitigation**: Before calling `redeemUnderlying`, call `getCash()` to verify liquidity. If insufficient, withdraw what's available or use wallet's free DOC balance.

### If Tropykus Gets Exploited/Rugged

- All DOC deposited in kDOC is at risk. This is the standard DeFi composability risk.
- kDOC is an upgradeable protocol (admin address exists). The admin could theoretically drain funds.
- **Mitigation for hackathon**: Disclose this risk. Cap maximum DOC in kDOC to a reasonable amount. For production: add monitoring for Comptroller admin changes.

---

## 5. DOC ERC777 / Reentrancy Analysis — NO ISSUE

DOC is a plain ERC20. Confirmed via:
1. `granularity()` and `defaultOperators()` revert (functions don't exist)
2. ERC1820 Registry returns zero address for ERC777Token interface
3. DOC bytecode lacks ERC777 selectors

This is in contrast to rUSDT on RSK, which IS ERC777 (has `granularity()` and `send()` selectors). The plan's choice to use DOC instead of rUSDT as the source token is safer from a reentrancy perspective.

No special reentrancy guards needed for the DOC-to-kDOC flow.

---

## 6. Implementation Concerns for the Plan

### 6.1 ABI Mismatch with Existing yield.ts

The existing `yield.ts` uses Sovryn's iToken interface:
```
mint(address receiver, uint256 depositAmount)
burn(address receiver, uint256 burnAmount)
```

Tropykus kDOC uses Compound V2's interface:
```
mint(uint256 mintAmount) returns (uint256)
redeem(uint256 redeemTokens) returns (uint256)
redeemUnderlying(uint256 redeemAmount) returns (uint256)
```

These are fundamentally different. The plan correctly identifies this but the implementation must use a **separate ABI**, not the existing `ITOKEN_ABI`. The return value semantics also differ: Compound V2 `mint` returns 0 on success (not the minted amount), while Sovryn's `mint` returns the minted iTokens.

### 6.2 kDOC Decimals = 18 (Non-Standard)

Standard Compound V2 cTokens use 8 decimals. Tropykus uses 18. This affects:
- Exchange rate interpretation (divide by 10^18, not 10^28)
- `balanceOf` formatting
- Any balance display logic

### 6.3 Missing `approve` Step in Plan

The plan's ABI snippet omits the approve step. Before calling `kDOC.mint(amount)`, DOC must be approved to the kDOC contract:
```
DOC.approve(KDOC_ADDRESS, amount)
kDOC.mint(amount)
```

The plan's flow text mentions this but the ABI/code snippet does not include it.

### 6.4 Return Value Check

Compound V2 `mint` returns `0` on success and a non-zero error code on failure. The implementation should check:
```
const result = await kDOC.mint(amount);
// In Compound V2, the return value is an error code (0 = success)
// But since this is called as a transaction, check receipt.status instead
```

### 6.5 `balanceOfUnderlying` is NOT a View Function

In Compound V2, `balanceOfUnderlying(address)` is a **non-view function** that calls `accrueInterest()` internally. It cannot be called as a static call without modification. To read the value without a transaction:
```
// Use exchangeRateStored() * balanceOf() / 10^18 instead
const kDocBalance = await kDOC.balanceOf(address);
const rate = await kDOC.exchangeRateStored();
const docValue = kDocBalance * rate / 10n**18n;
```

The plan lists `balanceOfUnderlying` as a view function in the ABI — this will fail on static calls. Use the manual calculation above.

---

## 7. Verdict & Recommendations

### What Works

1. **kDOC contract is live and functional** — confirmed deployed, correct underlying, standard Compound V2 interface
2. **Market is active** — last accrual 2.6 hours ago, 8 listed markets, no pauses
3. **DOC is safe** — plain ERC20, no ERC777 reentrancy risks
4. **5.11% Supply APR** — reasonable yield, close to the "~6%" claimed in the plan
5. **The integration is technically feasible** — all the right functions exist at the right addresses

### What Needs Fixing

| Issue | Severity | Action |
|-------|----------|--------|
| Gas overhead makes yield unprofitable for <$4,757 idle DOC (daily DCA) | **High** | Add minimum threshold ($100+) before parking in kDOC |
| No fallback if `redeemUnderlying` fails | **High** | Add try/catch with free-DOC fallback path |
| `balanceOfUnderlying` listed as `view` but is mutative | **Medium** | Use `exchangeRateStored() * balanceOf() / 10^18` instead |
| kDOC decimals = 18, not standard 8 | **Medium** | Update exchange rate math throughout |
| ABI differs from existing Sovryn yield.ts | **Medium** | Create separate code path, do not reuse `ITOKEN_ABI` |
| Missing DOC approve step in plan snippet | **Low** | Add approve before mint |
| 82.56% utilization = liquidity risk for large withdrawals | **Low** | Pre-check `getCash()` before redeem |
| Comptroller can pause market at any time | **Low** | Handle mint/redeem failures gracefully |

### Bottom Line

**The Tropykus kDOC integration is technically sound but economically questionable at hackathon demo amounts.** The protocol is live, the interface matches Compound V2, DOC is a safe ERC20, and nothing is paused. However, the extra gas cost of the deposit/withdraw cycle ($0.66/cycle) means you need $4,757+ idle DOC to break even on a daily DCA, or $680+ on a weekly DCA.

**For the hackathon demo**: Implement it — the narrative is compelling ("your idle stablecoins earn 5% while waiting for the next DCA"). But demo with a $500+ deposit to make the economics believable, and mention that the feature is designed for users with meaningful idle balances, not $10 DCA amounts.

**For production**: Add a minimum idle threshold, a gas-cost estimator that skips the yield cycle when unprofitable, and graceful fallbacks for all failure modes.
