# On-Chain DCA Contract — SatsPilotDCA

## Goal
Replace custodial server-side swaps with a non-custodial smart contract. User deposits DOC into the contract, configures DCA schedule, server only triggers execution (no fund access). Idle DOC earns yield in Tropykus kDOC.

## Architecture (Simplified from BitChill)

BitChill has ~15 contracts with multiple inheritance layers. We need ONE contract:

```
SatsPilotDCA.sol
├── Users deposit DOC
├── DOC auto-lent to Tropykus kDOC (yield while idle)
├── Keeper (our server) calls executeDCA() when schedule is due
├── Contract redeems DOC from kDOC → swaps via Uniswap V3 → accumulates RBTC
└── Users withdraw accumulated RBTC anytime
```

## Contract Interface

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract SatsPilotDCA {
    struct Schedule {
        uint256 docBalance;        // DOC deposited
        uint256 purchaseAmount;    // DOC to spend per execution
        uint256 purchasePeriod;    // seconds between executions
        uint256 lastExecution;     // timestamp of last execution
        uint256 accumulatedRbtc;   // RBTC accumulated from purchases
        bool active;
    }

    // User → Schedule (one schedule per user for simplicity)
    mapping(address => Schedule) public schedules;

    // Roles
    address public owner;
    address public keeper; // our server — can only trigger executions

    // External contracts (RSK mainnet)
    IERC20 constant DOC = IERC20(0xe700691dA7b9851F2F35f8b8182c69c53CcaD9Db);
    IWETH constant WRBTC = IWETH(0x542fDA317318eBF1d3DEAf76E0b632741A7e677d);
    ICToken constant kDOC = ICToken(0x544Eb90e766B405134b3B3F62b6b4c23Fcd5fDa2);
    ISwapRouter constant ROUTER = ISwapRouter(0x0B14ff67f0014046b4b99057Aec4509640b3947A);

    // User functions
    function createSchedule(uint256 depositAmount, uint256 purchaseAmount, uint256 purchasePeriod) external;
    function depositMore(uint256 amount) external;
    function withdrawDoc(uint256 amount) external;
    function withdrawRbtc() external;
    function cancelSchedule() external;

    // Keeper function (only callable by keeper address)
    function executeDCA(address user) external;
    function batchExecuteDCA(address[] calldata users) external;

    // View functions
    function getSchedule(address user) external view returns (Schedule memory);
    function getDocBalance(address user) external view returns (uint256); // includes kDOC yield
    function pendingRbtc(address user) external view returns (uint256);
}
```

## Execution Flow

```
executeDCA(user):
1. Require msg.sender == keeper
2. Require schedule.active == true
3. Require block.timestamp >= lastExecution + purchasePeriod
4. Require schedule.docBalance >= purchaseAmount
5. Redeem DOC from kDOC: kDOC.redeemUnderlying(purchaseAmount)
6. Approve DOC to SwapRouter02
7. Swap DOC → WRBTC via exactInputSingle wrapped in multicall(deadline)
8. Unwrap WRBTC → native RBTC
9. schedule.accumulatedRbtc += received RBTC
10. schedule.docBalance -= purchaseAmount
11. schedule.lastExecution = block.timestamp
12. Emit DCAExecuted(user, purchaseAmount, rbtcReceived)
```

## Integration with SatsPilot Backend

The backend changes from "executing swaps" to "calling contract functions":

```
Old: wallet = getUserWallet() → executeSwap(wallet, ...) → depositToYield(wallet, ...)
New: contract = SatsPilotDCA.connect(keeperWallet)
     → contract.executeDCA(userAddress)
     (contract handles everything: redeem kDOC → swap → accumulate RBTC)
```

User wallet is no longer custodial — users approve DOC to the contract and interact via WhatsApp commands that translate to contract calls.

## Deployment

- Hardhat with RSK mainnet config
- Deploy SatsPilotDCA with keeper = our server's wallet address
- Server needs a single wallet (keeper) that can only trigger executions
- User funds stay in the contract — keeper cannot withdraw

## Estimated Effort
- Write contract: 30 min
- Write tests: 20 min
- Deploy to mainnet: 10 min
- Update backend integration: 30 min
- Total: ~90 min
