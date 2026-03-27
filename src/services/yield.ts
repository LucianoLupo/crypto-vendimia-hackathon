import { Contract, Wallet, parseUnits, formatUnits } from 'ethers';
import { YIELD_CONTRACTS, TOKEN_ADDRESSES, TOKEN_DECIMALS, ERC20_ABI } from '../config/tokens';

const ITOKEN_ABI = [
  // ERC20 iTokens (DOC, DLLR)
  'function mint(address receiver, uint256 depositAmount) external payable returns (uint256 mintAmount)',
  'function burn(address receiver, uint256 burnAmount) external returns (uint256 loanAmountPaid)',
  'function balanceOf(address owner) view returns (uint256)',
];

const IRBTC_ABI = [
  // Sovryn iRBTC uses mintWithBTC, not mint, for native RBTC deposits
  'function mintWithBTC(address receiver, bool useLM) external payable returns (uint256 mintAmount)',
  'function burn(address receiver, uint256 burnAmount) external returns (uint256 loanAmountPaid)',
  'function balanceOf(address owner) view returns (uint256)',
];

// Build yield map from available contracts (testnet vs mainnet have different sets)
const YIELD_MAP: Record<string, { iToken: string; underlying: string; isNative: boolean }> = {};

if (YIELD_CONTRACTS.iRBTC) {
  YIELD_MAP.RBTC = { iToken: YIELD_CONTRACTS.iRBTC, underlying: 'native', isNative: true };
} else if (YIELD_CONTRACTS.kRBTC) {
  // Tropykus testnet — kRBTC uses mint() payable (same as Sovryn mintWithBTC pattern)
  YIELD_MAP.RBTC = { iToken: YIELD_CONTRACTS.kRBTC, underlying: 'native', isNative: true };
}

if (YIELD_CONTRACTS.iDOC && TOKEN_ADDRESSES.DOC) {
  YIELD_MAP.DOC = { iToken: YIELD_CONTRACTS.iDOC, underlying: TOKEN_ADDRESSES.DOC, isNative: false };
} else if (YIELD_CONTRACTS.kDOC && TOKEN_ADDRESSES.DOC) {
  YIELD_MAP.DOC = { iToken: YIELD_CONTRACTS.kDOC, underlying: TOKEN_ADDRESSES.DOC, isNative: false };
}

if (YIELD_CONTRACTS.iDLLR && TOKEN_ADDRESSES.DLLR) {
  YIELD_MAP.DLLR = { iToken: YIELD_CONTRACTS.iDLLR, underlying: TOKEN_ADDRESSES.DLLR, isNative: false };
}

export async function depositToYield(
  wallet: Wallet,
  tokenSymbol: string,
  amount: string
): Promise<{ txHash: string; iTokensReceived: string }> {
  const config = YIELD_MAP[tokenSymbol.toUpperCase()];
  if (!config) {
    throw new Error(`Token ${tokenSymbol} is not supported for yield. Supported: ${getSupportedYieldTokens().join(', ')}`);
  }

  const decimals = TOKEN_DECIMALS[tokenSymbol.toUpperCase()] ?? 18;
  const parsedAmount = parseUnits(amount, decimals);

  try {
    let tx;
    if (config.isNative) {
      // Try Tropykus kRBTC first (mint() payable), fall back to Sovryn mintWithBTC
      const iRBTC = new Contract(config.iToken, [...IRBTC_ABI, 'function mint() external payable returns (uint256)'], wallet);
      const preBalance: bigint = await iRBTC.balanceOf(wallet.address);
      try {
        // Tropykus kRBTC: mint() payable — no args
        tx = await iRBTC.mint({ value: parsedAmount, gasLimit: 500000 });
      } catch {
        // Sovryn iRBTC: mintWithBTC(receiver, useLM=false)
        tx = await iRBTC.mintWithBTC(wallet.address, false, { value: parsedAmount, gasLimit: 500000 });
      }
      const receipt = await tx.wait();
      if (!receipt) throw new Error('Yield deposit transaction dropped');
      const postBalance: bigint = await iRBTC.balanceOf(wallet.address);
      const received = postBalance - preBalance;
      return { txHash: tx.hash, iTokensReceived: formatUnits(received > 0n ? received : parsedAmount, decimals) };
    } else {
      // ERC20 iTokens: approve underlying + mint(receiver, amount)
      const iToken = new Contract(config.iToken, ITOKEN_ABI, wallet);
      const underlying = new Contract(config.underlying, ERC20_ABI, wallet);
      const allowance: bigint = await underlying.allowance(wallet.address, config.iToken);
      if (allowance < parsedAmount) {
        const approveTx = await underlying.approve(config.iToken, parsedAmount);
        const approveReceipt = await approveTx.wait();
        if (!approveReceipt) throw new Error('Yield approval transaction dropped');
      }
      const preBalance: bigint = await iToken.balanceOf(wallet.address);
      tx = await iToken.mint(wallet.address, parsedAmount);
      const receipt = await tx.wait();
      if (!receipt) throw new Error('Yield deposit transaction dropped');
      const postBalance: bigint = await iToken.balanceOf(wallet.address);
      const received = postBalance - preBalance;
      return { txHash: tx.hash, iTokensReceived: formatUnits(received > 0n ? received : parsedAmount, decimals) };
    }
  } catch (err) {
    console.error(`[yield] depositToYield failed for ${tokenSymbol} amount=${amount}:`, err);
    throw err;
  }
}

export function getSupportedYieldTokens(): string[] {
  return Object.keys(YIELD_MAP);
}
