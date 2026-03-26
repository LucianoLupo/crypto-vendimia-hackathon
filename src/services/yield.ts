import { Contract, Wallet, parseUnits, formatUnits } from 'ethers';
import { YIELD_CONTRACTS, TOKEN_ADDRESSES, TOKEN_DECIMALS } from '../config/tokens';

const ITOKEN_ABI = [
  'function mint(address receiver, uint256 depositAmount) external payable returns (uint256 mintAmount)',
  'function burn(address receiver, uint256 burnAmount) external returns (uint256 loanAmountPaid)',
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenPrice() view returns (uint256)',
  'function assetBalanceOf(address owner) view returns (uint256)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const YIELD_MAP: Record<string, { iToken: string; underlying: string; isNative: boolean }> = {
  RBTC: { iToken: YIELD_CONTRACTS.iRBTC, underlying: 'native', isNative: true },
  DOC: { iToken: YIELD_CONTRACTS.iDOC, underlying: TOKEN_ADDRESSES.DOC, isNative: false },
  DLLR: { iToken: YIELD_CONTRACTS.iDLLR, underlying: TOKEN_ADDRESSES.DLLR, isNative: false },
};

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
  const iToken = new Contract(config.iToken, ITOKEN_ABI, wallet);

  try {
    let tx;
    if (config.isNative) {
      tx = await iToken.mint(wallet.address, parsedAmount, { value: parsedAmount });
    } else {
      const underlying = new Contract(config.underlying, ERC20_ABI, wallet);
      const allowance: bigint = await underlying.allowance(wallet.address, config.iToken);
      if (allowance < parsedAmount) {
        const approveTx = await underlying.approve(config.iToken, parsedAmount);
        const approveReceipt = await approveTx.wait();
        if (!approveReceipt) throw new Error('Yield approval transaction dropped');
      }
      tx = await iToken.mint(wallet.address, parsedAmount);
    }

    const receipt = await tx.wait();
    if (!receipt) throw new Error('Yield deposit transaction dropped');
    return { txHash: tx.hash, iTokensReceived: formatUnits(parsedAmount, decimals) };
  } catch (err) {
    console.error(`[yield] depositToYield failed for ${tokenSymbol} amount=${amount}:`, err);
    throw err;
  }
}

export function getSupportedYieldTokens(): string[] {
  return Object.keys(YIELD_MAP);
}
