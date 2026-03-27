/**
 * On-chain verification of Tropykus kDOC (Compound V2 fork) on RSK Mainnet
 *
 * Checks:
 * 1. Contract has deployed code
 * 2. Underlying token is DOC
 * 3. Has Compound V2 interface (mint, redeem, redeemUnderlying, balanceOfUnderlying)
 * 4. Current exchange rate
 * 5. Total supply / total borrows (market health)
 * 6. Comptroller (pause risk)
 * 7. DOC token properties (ERC777 check)
 */

import { JsonRpcProvider, Contract, formatUnits, Interface } from 'ethers';

const RPC_URL = 'https://public-node.rsk.co';
const KDOC_ADDRESS = '0x544eb90e766b405134b3b3f62b6b4c23fcd5fda2';
const DOC_ADDRESS = '0xe700691da7b9851f2f35f8b8182c69c53ccad9db';
const COMPTROLLER_ADDRESS = '0x962308Fef8EdfAdD705384840e7701f8F39ed0c0';

// ERC1820 Registry — used by ERC777 tokens to register interfaces
const ERC1820_REGISTRY = '0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24';

const provider = new JsonRpcProvider(RPC_URL, { chainId: 30, name: 'rsk' });

const KDOC_ABI = [
  // Core Compound V2 cToken interface
  'function mint(uint256 mintAmount) returns (uint256)',
  'function redeem(uint256 redeemTokens) returns (uint256)',
  'function redeemUnderlying(uint256 redeemAmount) returns (uint256)',
  'function balanceOfUnderlying(address owner) returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  // Market state
  'function underlying() view returns (address)',
  'function exchangeRateCurrent() returns (uint256)',
  'function exchangeRateStored() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function totalBorrows() view returns (uint256)',
  'function totalReserves() view returns (uint256)',
  'function getCash() view returns (uint256)',
  'function reserveFactorMantissa() view returns (uint256)',
  'function supplyRatePerBlock() view returns (uint256)',
  'function borrowRatePerBlock() view returns (uint256)',
  // Admin / pause
  'function comptroller() view returns (address)',
  'function accrualBlockNumber() view returns (uint256)',
  // Token metadata
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

const DOC_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  // ERC777 detection
  'function granularity() view returns (uint256)',
  'function defaultOperators() view returns (address[])',
  'function isOperatorFor(address operator, address tokenHolder) view returns (bool)',
];

const COMPTROLLER_ABI = [
  'function mintGuardianPaused(address) view returns (bool)',
  'function borrowGuardianPaused(address) view returns (bool)',
  'function transferGuardianPaused() view returns (bool)',
  'function seizeGuardianPaused() view returns (bool)',
  'function admin() view returns (address)',
  'function pauseGuardian() view returns (address)',
  'function getAllMarkets() view returns (address[])',
];

const ERC1820_ABI = [
  'function getInterfaceImplementer(address account, bytes32 interfaceHash) view returns (address)',
];

const results = {};

async function safeCall(label, fn) {
  try {
    const result = await fn();
    return result;
  } catch (err) {
    console.log(`  [FAIL] ${label}: ${err.message?.substring(0, 120)}`);
    return null;
  }
}

async function main() {
  console.log('=' .repeat(80));
  console.log('TROPYKUS kDOC ON-CHAIN VERIFICATION REPORT');
  console.log('Network: RSK Mainnet (chainId 30)');
  console.log('RPC: ' + RPC_URL);
  console.log('Date: ' + new Date().toISOString());
  console.log('=' .repeat(80));

  // ── 1. Check kDOC has deployed code ──
  console.log('\n─── 1. CONTRACT DEPLOYMENT CHECK ───');
  const kdocCode = await provider.getCode(KDOC_ADDRESS);
  const hasCode = kdocCode && kdocCode !== '0x' && kdocCode.length > 2;
  console.log(`  kDOC (${KDOC_ADDRESS}): ${hasCode ? 'DEPLOYED (' + kdocCode.length + ' bytes hex)' : 'NO CODE'}`);
  results.hasCode = hasCode;

  if (!hasCode) {
    console.log('\n  FATAL: No contract at kDOC address. Aborting.');
    return;
  }

  const kdoc = new Contract(KDOC_ADDRESS, KDOC_ABI, provider);

  // ── 2. Check underlying is DOC ──
  console.log('\n─── 2. UNDERLYING TOKEN CHECK ───');
  const underlying = await safeCall('underlying()', () => kdoc.underlying());
  if (underlying) {
    const isDocUnderlying = underlying.toLowerCase() === DOC_ADDRESS.toLowerCase();
    console.log(`  underlying(): ${underlying}`);
    console.log(`  Expected DOC: ${DOC_ADDRESS}`);
    console.log(`  Match: ${isDocUnderlying ? 'YES' : 'NO — MISMATCH!'}`);
    results.underlyingMatch = isDocUnderlying;
  }

  // kDOC metadata
  const kdocName = await safeCall('name()', () => kdoc.name());
  const kdocSymbol = await safeCall('symbol()', () => kdoc.symbol());
  const kdocDecimals = await safeCall('decimals()', () => kdoc.decimals());
  console.log(`  kDOC name: ${kdocName}`);
  console.log(`  kDOC symbol: ${kdocSymbol}`);
  console.log(`  kDOC decimals: ${kdocDecimals}`);

  // ── 3. Compound V2 Interface Check ──
  console.log('\n─── 3. COMPOUND V2 INTERFACE CHECK ───');

  // We'll check if the contract has the function selectors in its bytecode
  const iface = new Interface(KDOC_ABI);
  const requiredFunctions = ['mint', 'redeem', 'redeemUnderlying', 'balanceOfUnderlying'];

  for (const fnName of requiredFunctions) {
    const selector = iface.getFunction(fnName).selector;
    const hasSelector = kdocCode.toLowerCase().includes(selector.slice(2).toLowerCase());
    console.log(`  ${fnName}() [${selector}]: ${hasSelector ? 'FOUND in bytecode' : 'NOT FOUND'}`);
  }

  // Also try static calls where possible
  const exchangeRateStored = await safeCall('exchangeRateStored()', () => kdoc.exchangeRateStored());
  const totalSupply = await safeCall('totalSupply()', () => kdoc.totalSupply());
  const totalBorrows = await safeCall('totalBorrows()', () => kdoc.totalBorrows());
  const totalReserves = await safeCall('totalReserves()', () => kdoc.totalReserves());
  const getCash = await safeCall('getCash()', () => kdoc.getCash());
  const reserveFactor = await safeCall('reserveFactorMantissa()', () => kdoc.reserveFactorMantissa());
  const supplyRate = await safeCall('supplyRatePerBlock()', () => kdoc.supplyRatePerBlock());
  const borrowRate = await safeCall('borrowRatePerBlock()', () => kdoc.borrowRatePerBlock());
  const accrualBlock = await safeCall('accrualBlockNumber()', () => kdoc.accrualBlockNumber());

  // ── 4. Exchange Rate ──
  console.log('\n─── 4. EXCHANGE RATE ───');
  if (exchangeRateStored !== null) {
    // Compound V2: exchangeRate = (totalCash + totalBorrows - totalReserves) / totalSupply
    // Scaled by 10^(18 - 8 + underlyingDecimals) = 10^(18-8+18) = 10^28 for DOC
    console.log(`  exchangeRateStored (raw): ${exchangeRateStored.toString()}`);
    // For DOC (18 decimals), exchangeRate has 18 + 18 - 8 = 28 decimals of precision
    const rateFormatted = formatUnits(exchangeRateStored, 28);
    console.log(`  exchangeRateStored (formatted, 28 decimals): ${rateFormatted}`);
    console.log(`  Meaning: 1 kDOC = ${rateFormatted} DOC`);
    results.exchangeRate = rateFormatted;
  }

  // ── 5. Market Health ──
  console.log('\n─── 5. MARKET HEALTH ───');
  if (totalSupply !== null) {
    console.log(`  totalSupply (kDOC tokens, raw): ${totalSupply.toString()}`);
    console.log(`  totalSupply (kDOC tokens): ${formatUnits(totalSupply, 8)}`);
  }
  if (totalBorrows !== null) {
    console.log(`  totalBorrows (DOC): ${formatUnits(totalBorrows, 18)}`);
  }
  if (totalReserves !== null) {
    console.log(`  totalReserves (DOC): ${formatUnits(totalReserves, 18)}`);
  }
  if (getCash !== null) {
    console.log(`  getCash (DOC available): ${formatUnits(getCash, 18)}`);
  }
  if (reserveFactor !== null) {
    console.log(`  reserveFactor: ${formatUnits(reserveFactor, 18)} (${Number(formatUnits(reserveFactor, 16))}%)`);
  }

  // Utilization rate
  if (totalBorrows !== null && getCash !== null && totalReserves !== null) {
    const borrows = BigInt(totalBorrows);
    const cash = BigInt(getCash);
    const reserves = BigInt(totalReserves);
    const totalAssets = cash + borrows - reserves;
    if (totalAssets > 0n) {
      const utilization = Number(borrows * 10000n / totalAssets) / 100;
      console.log(`  Utilization rate: ${utilization.toFixed(2)}%`);
      console.log(`  Total assets (DOC): ${formatUnits(totalAssets, 18)}`);
      results.utilization = utilization;
    }
  }

  // Interest rates
  if (supplyRate !== null) {
    // RSK ~30s blocks, ~1,051,200 blocks/year
    const blocksPerYear = 1051200n;
    const supplyAPY = Number(supplyRate * blocksPerYear) / 1e18 * 100;
    console.log(`  supplyRatePerBlock (raw): ${supplyRate.toString()}`);
    console.log(`  Estimated Supply APR: ${supplyAPY.toFixed(4)}%`);
    results.supplyAPR = supplyAPY;
  }
  if (borrowRate !== null) {
    const blocksPerYear = 1051200n;
    const borrowAPY = Number(borrowRate * blocksPerYear) / 1e18 * 100;
    console.log(`  borrowRatePerBlock (raw): ${borrowRate.toString()}`);
    console.log(`  Estimated Borrow APR: ${borrowAPY.toFixed(4)}%`);
    results.borrowAPR = borrowAPY;
  }

  if (accrualBlock !== null) {
    const currentBlock = await provider.getBlockNumber();
    const blocksBehind = currentBlock - Number(accrualBlock);
    console.log(`  Last accrual block: ${accrualBlock.toString()}`);
    console.log(`  Current block: ${currentBlock}`);
    console.log(`  Blocks since last accrual: ${blocksBehind} (~${(blocksBehind * 30 / 3600).toFixed(1)} hours)`);
    results.blocksBehind = blocksBehind;
  }

  // ── 6. Comptroller / Pause Risk ──
  console.log('\n─── 6. COMPTROLLER & PAUSE RISK ───');
  const comptrollerAddr = await safeCall('comptroller()', () => kdoc.comptroller());
  console.log(`  comptroller(): ${comptrollerAddr}`);

  if (comptrollerAddr) {
    const expectedComptroller = COMPTROLLER_ADDRESS.toLowerCase();
    console.log(`  Expected: ${expectedComptroller}`);
    console.log(`  Match: ${comptrollerAddr.toLowerCase() === expectedComptroller ? 'YES' : 'NO'}`);

    const comptroller = new Contract(comptrollerAddr, COMPTROLLER_ABI, provider);

    const mintPaused = await safeCall('mintGuardianPaused(kDOC)', () => comptroller.mintGuardianPaused(KDOC_ADDRESS));
    const borrowPaused = await safeCall('borrowGuardianPaused(kDOC)', () => comptroller.borrowGuardianPaused(KDOC_ADDRESS));
    const transferPaused = await safeCall('transferGuardianPaused()', () => comptroller.transferGuardianPaused());
    const seizePaused = await safeCall('seizeGuardianPaused()', () => comptroller.seizeGuardianPaused());

    console.log(`  mintGuardianPaused(kDOC): ${mintPaused}`);
    console.log(`  borrowGuardianPaused(kDOC): ${borrowPaused}`);
    console.log(`  transferGuardianPaused: ${transferPaused}`);
    console.log(`  seizeGuardianPaused: ${seizePaused}`);

    const admin = await safeCall('admin()', () => comptroller.admin());
    const pauseGuardian = await safeCall('pauseGuardian()', () => comptroller.pauseGuardian());
    console.log(`  admin: ${admin}`);
    console.log(`  pauseGuardian: ${pauseGuardian}`);

    // Check all markets
    const allMarkets = await safeCall('getAllMarkets()', () => comptroller.getAllMarkets());
    if (allMarkets) {
      console.log(`  Total markets: ${allMarkets.length}`);
      const isListed = allMarkets.some(m => m.toLowerCase() === KDOC_ADDRESS.toLowerCase());
      console.log(`  kDOC is listed: ${isListed}`);
    }

    results.mintPaused = mintPaused;
    results.borrowPaused = borrowPaused;
  }

  // ── 7. DOC Token Analysis (ERC777 Check) ──
  console.log('\n─── 7. DOC TOKEN ANALYSIS (ERC777 CHECK) ───');
  const docCode = await provider.getCode(DOC_ADDRESS);
  console.log(`  DOC contract at ${DOC_ADDRESS}: ${docCode.length > 2 ? 'DEPLOYED' : 'NO CODE'}`);

  const doc = new Contract(DOC_ADDRESS, DOC_ABI, provider);
  const docName = await safeCall('name()', () => doc.name());
  const docSymbol = await safeCall('symbol()', () => doc.symbol());
  const docDecimals = await safeCall('decimals()', () => doc.decimals());
  const docTotalSupply = await safeCall('totalSupply()', () => doc.totalSupply());

  console.log(`  DOC name: ${docName}`);
  console.log(`  DOC symbol: ${docSymbol}`);
  console.log(`  DOC decimals: ${docDecimals}`);
  if (docTotalSupply) {
    console.log(`  DOC totalSupply: ${formatUnits(docTotalSupply, 18)} DOC`);
  }

  // Check for ERC777 interface
  const granularity = await safeCall('granularity()', () => doc.granularity());
  const defaultOperators = await safeCall('defaultOperators()', () => doc.defaultOperators());

  console.log(`  granularity(): ${granularity ?? 'NOT FOUND (not ERC777)'}`);
  console.log(`  defaultOperators(): ${defaultOperators ?? 'NOT FOUND (not ERC777)'}`);

  // Check ERC1820 registry for ERC777 interface
  const erc1820Code = await provider.getCode(ERC1820_REGISTRY);
  if (erc1820Code && erc1820Code !== '0x') {
    const erc1820 = new Contract(ERC1820_REGISTRY, ERC1820_ABI, provider);
    // keccak256("ERC777Token")
    const erc777Hash = '0xac7fbab5f54a3ca8194167523c6753bfeb96a445279294b6125b68cce2177054';
    // keccak256("ERC777TokensSender")
    const senderHash = '0x29ddb589b1fb5fc7cf394961c1adf5f8c6454761adf795e67fe149f658abe895';
    // keccak256("ERC777TokensRecipient")
    const recipientHash = '0xb281fc8c12954d22544db45de3159a39272895b169a852b314f9cc762e44c53b';

    const erc777Impl = await safeCall('ERC1820 ERC777Token', () => erc1820.getInterfaceImplementer(DOC_ADDRESS, erc777Hash));
    console.log(`  ERC1820 ERC777Token implementer: ${erc777Impl ?? 'NOT REGISTERED'}`);

    const isERC777 = erc777Impl && erc777Impl !== '0x0000000000000000000000000000000000000000';
    console.log(`  DOC is ERC777: ${isERC777 ? 'YES — REENTRANCY RISK' : 'NO'}`);
    results.docIsERC777 = isERC777;
  } else {
    console.log(`  ERC1820 Registry not deployed on RSK — cannot check ERC777 registration`);
    // Fallback: check bytecode for ERC777 function selectors
    const docIface = new Interface([
      'function granularity() view returns (uint256)',
      'function send(address to, uint256 amount, bytes data)',
      'function operatorSend(address from, address to, uint256 amount, bytes data, bytes operatorData)',
    ]);
    for (const fnName of ['granularity', 'send', 'operatorSend']) {
      const sel = docIface.getFunction(fnName).selector;
      const found = docCode.toLowerCase().includes(sel.slice(2).toLowerCase());
      console.log(`  DOC bytecode has ${fnName}() [${sel}]: ${found ? 'YES' : 'NO'}`);
    }
  }

  // Also check rUSDT for comparison (known ERC777 on RSK)
  console.log('\n  --- rUSDT ERC777 comparison ---');
  const RUSDT_ADDRESS = '0xef213441a85df4d7acbdae0cf78004e1e486bb96';
  const rusdtCode = await provider.getCode(RUSDT_ADDRESS);
  if (rusdtCode.length > 2) {
    const rusdtIface = new Interface([
      'function granularity() view returns (uint256)',
      'function send(address to, uint256 amount, bytes data)',
    ]);
    for (const fnName of ['granularity', 'send']) {
      const sel = rusdtIface.getFunction(fnName).selector;
      const found = rusdtCode.toLowerCase().includes(sel.slice(2).toLowerCase());
      console.log(`  rUSDT bytecode has ${fnName}() [${sel}]: ${found ? 'YES' : 'NO'}`);
    }
  }

  // ── Summary ──
  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));
  console.log(`  Contract deployed: ${results.hasCode ? 'YES' : 'NO'}`);
  console.log(`  Underlying is DOC: ${results.underlyingMatch ? 'YES' : 'UNKNOWN/NO'}`);
  console.log(`  Exchange rate (1 kDOC = X DOC): ${results.exchangeRate ?? 'UNKNOWN'}`);
  console.log(`  Utilization rate: ${results.utilization !== undefined ? results.utilization.toFixed(2) + '%' : 'UNKNOWN'}`);
  console.log(`  Supply APR: ${results.supplyAPR !== undefined ? results.supplyAPR.toFixed(4) + '%' : 'UNKNOWN'}`);
  console.log(`  Borrow APR: ${results.borrowAPR !== undefined ? results.borrowAPR.toFixed(4) + '%' : 'UNKNOWN'}`);
  console.log(`  Mint paused: ${results.mintPaused ?? 'UNKNOWN'}`);
  console.log(`  DOC is ERC777: ${results.docIsERC777 !== undefined ? (results.docIsERC777 ? 'YES' : 'NO') : 'UNKNOWN'}`);
  console.log(`  Blocks since last accrual: ${results.blocksBehind ?? 'UNKNOWN'}`);
}

main().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
