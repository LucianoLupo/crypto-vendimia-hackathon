# Testnet Deployment Plan

## Goal
Refactor SatsPilotDCA.sol to accept constructor params (not hardcoded constants), deploy to RSK testnet, get tRBTC from faucet, test the full DCA flow for free.

## Testnet Addresses (Verified On-Chain)

| Contract | Mainnet | Testnet |
|----------|---------|---------|
| DOC | `0xe700691dA7b9851F2F35f8b8182c69c53CcaD9Db` | `0xCB46c0ddc60D18eFEB0E586C17Af6ea36452Dae0` |
| MoC | `0xf773B590aF754D597770937Fa8ea7AbDf2668370` | `0x2820f6d4D199B8D8838A4B26F9917754B86a0c1F` |
| kDOC | `0x544Eb90e766B405134b3B3F62b6b4C23Fcd5fDa2` | `0x71e6B108d823C2786f8EF63A3E0589576B4F3914` |
| kRBTC | `0x0AEAdb9d4C6A80462A47e87E76E487Fa8B9a37d7` | `0x5b35072cd6110606c8421e013304110fa04a32a3` |

## Tasks

### Task 1: Refactor SatsPilotDCA.sol — constructor params
Change from `constant` to `immutable` + constructor params:

```solidity
// Before
IERC20 public constant DOC = IERC20(0xe700...);

// After
IERC20 public immutable DOC;

constructor(
    address _keeper,
    address _doc,
    address _moc,
    address _kdoc,
    address _krbtc
) {
    owner = msg.sender;
    keeper = _keeper;
    DOC = IERC20(_doc);
    MOC = IMoC(_moc);
    KDOC = ICToken(_kdoc);
    KRBTC = ICRbtc(_krbtc);
}
```

Also update `receive()` to check against the immutable addresses.

### Task 2: Update Deploy.s.sol for multi-network
Create a deploy script that reads addresses from env vars:

```solidity
address doc = vm.envAddress("DOC_ADDRESS");
address moc = vm.envAddress("MOC_ADDRESS");
address kdoc = vm.envAddress("KDOC_ADDRESS");
address krbtc = vm.envAddress("KRBTC_ADDRESS");
address keeper = vm.envAddress("KEEPER_ADDRESS");

SatsPilotDCA dca = new SatsPilotDCA(keeper, doc, moc, kdoc, krbtc);
```

### Task 3: Update foundry.toml with RSK testnet config
```toml
[rpc_endpoints]
rsk_mainnet = "https://public-node.rsk.co"
rsk_testnet = "https://public-node.testnet.rsk.co"
```

### Task 4: Get tRBTC from faucet
- Visit https://faucet.rootstock.io/
- Request tRBTC for deployer address: 0x36cA46C6b7E93282F89A29b593e593dF0Dc3b3D1

### Task 5: Deploy to RSK testnet
```bash
cd contracts

# Testnet deploy
DEPLOYER_PRIVATE_KEY=<key> \
KEEPER_ADDRESS=0x36cA46C6b7E93282F89A29b593e593dF0Dc3b3D1 \
DOC_ADDRESS=0xCB46c0ddc60D18eFEB0E586C17Af6ea36452Dae0 \
MOC_ADDRESS=0x2820f6d4D199B8D8838A4B26F9917754B86a0c1F \
KDOC_ADDRESS=0x71e6B108d823C2786f8EF63A3E0589576B4F3914 \
KRBTC_ADDRESS=0x5b35072cd6110606c8421e013304110fa04a32a3 \
forge script script/Deploy.s.sol \
  --rpc-url https://public-node.testnet.rsk.co \
  --broadcast
```

### Task 6: Update backend to point to testnet
- Change RSK_RPC_URL in Railway env to testnet
- Update token addresses in config/tokens.ts for testnet
- Add the deployed SatsPilotDCA contract address to config
- Redeploy backend to Railway

### Task 7: Test full flow via WhatsApp
1. Get tRBTC from faucet
2. Get testnet DOC (from MoC testnet — mint DOC by sending RBTC)
3. Send "hola" on WhatsApp → verify wallet creation
4. Send "comprar 25 RBTC diario" → create DCA order
5. Send "invertir" → park DOC in testnet kDOC
6. Wait for cron → verify DCA execution
7. Send "saldo" → check balances
8. Send "retirar" → test withdrawal

## Dependency Order
```
Task 1 (refactor contract)
    ↓
Task 2 + 3 (deploy script + foundry config)
    ↓
Task 4 (get tRBTC) — can happen in parallel
    ↓
Task 5 (deploy to testnet)
    ↓
Task 6 (update backend)
    ↓
Task 7 (test)
```

## Estimated Time
- Task 1-3: 15 min (contract + scripts)
- Task 4: 5 min (faucet)
- Task 5: 5 min (deploy)
- Task 6: 10 min (backend update)
- Task 7: 15 min (testing)
- Total: ~50 min
