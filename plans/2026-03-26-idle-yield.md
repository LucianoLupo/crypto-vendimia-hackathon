# Idle Yield — DOC + Tropykus kDOC

## Goal
User deposits DOC (BTC-backed stablecoin, $1 peg). While idle, DOC earns yield in Tropykus kDOC (~6% APY, $11.2M TVL). When DCA triggers, DOC is withdrawn from kDOC, swapped to target token, and remaining DOC goes back into kDOC.

## Flow

```
User deposits DOC to wallet
    │
    ▼ Deposit watcher detects new DOC balance
    │
    ▼ Auto-deposit all DOC into Tropykus kDOC (earn ~6% APY)
    │
    ▼ ... time passes, yield accrues ...
    │
    ▼ DCA scheduler triggers
    │
    ├── 1. Withdraw needed DOC amount from kDOC (burn kDOC → get DOC)
    ├── 2. Swap DOC → RBTC on Uniswap V3
    ├── 3. Deposit RBTC into Sovryn iRBTC (earn ~5% APY)
    ├── 4. Re-deposit any remaining DOC back into kDOC
    └── 5. Notify user via WhatsApp
```

## Architecture Changes

### New: Idle Yield Service (`src/services/idle-yield.ts`)
Manages parking/unparking source tokens in lending protocols.

```typescript
// Tropykus kDOC (Compound V2 fork)
const KDOC_ADDRESS = '0x544eb90e766b405134b3b3f62b6b4c23fcd5fda2';
const KDOC_ABI = [
  'function mint(uint256 mintAmount) returns (uint256)',      // deposit DOC → get kDOC
  'function redeem(uint256 redeemTokens) returns (uint256)',  // burn kDOC → get DOC
  'function redeemUnderlying(uint256 redeemAmount) returns (uint256)', // withdraw exact DOC amount
  'function balanceOf(address) view returns (uint256)',       // kDOC balance
  'function balanceOfUnderlying(address) view returns (uint256)', // DOC value of kDOC holdings
];

Functions:
- depositIdleFunds(wallet, tokenSymbol, amount) → deposit DOC into kDOC
- withdrawIdleFunds(wallet, tokenSymbol, amount) → withdraw exact DOC from kDOC
- getIdleYieldBalance(walletAddress, tokenSymbol) → check kDOC balance + underlying value
```

### Modified: Scheduler (`src/services/scheduler.ts`)
Before swap: withdraw DCA amount from idle yield pool.
After swap: re-deposit remaining DOC into idle yield pool.

```
// In processDueOrders, for each order:
1. Check if fromToken has idle yield config
2. If yes: withdrawIdleFunds(wallet, fromToken, effectiveAmount)
3. Execute swap as before
4. Check remaining DOC balance
5. If remaining > 0: depositIdleFunds(wallet, fromToken, remaining)
```

### Modified: Deposit Watcher (`src/services/deposit-watcher.ts`)
After detecting a new DOC deposit, auto-park it in kDOC.

```
// When DOC balance increases:
1. Notify user of deposit
2. Auto-deposit DOC into Tropykus kDOC
3. Notify user: "Tus DOC fueron depositados en Tropykus para generar yield (~6% APY)"
```

### Modified: Balance Display (`src/services/commands.ts`)
Show both free balance AND yield balance for DOC.

```
DOC: 0.00 (libre) + 50.23 (en yield, Tropykus kDOC)
```

### Modified: Config (`src/config/tokens.ts`)
Add Tropykus kDOC contract address.

### Modified: Default Source Token
Change default fromToken from RUSDT to DOC.

## Verification

### On-Chain Check Needed
1. Verify kDOC at 0x544eb90e766b405134b3b3f62b6b4c23fcd5fda2:
   - Confirm it's a Compound V2 cToken (has mint/redeem/balanceOfUnderlying)
   - Confirm underlying is DOC (0xe700691da7b9851f2f35f8b8182c69c53ccad9db)
   - Check current exchange rate

### Implementation Order
1. Verify kDOC on-chain (5 min)
2. Create idle-yield.ts service (15 min)
3. Update scheduler with withdraw/re-deposit cycle (15 min)
4. Update deposit watcher with auto-park (10 min)
5. Update balance display (5 min)
6. Update default fromToken to DOC (2 min)
7. Update parser system prompt (2 min)
8. Update README (5 min)
9. Compile + deploy (5 min)

Total: ~60 min
