import { Contract, Wallet, parseUnits, formatUnits } from 'ethers';
import { IDLE_YIELD_CONTRACTS, TOKEN_ADDRESSES, ERC20_ABI } from '../config/tokens';
import { getProvider } from './wallet';

const KDOC_ABI = [
  'function mint(uint256 mintAmount) returns (uint256)',
  'function redeemUnderlying(uint256 redeemAmount) returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function exchangeRateStored() view returns (uint256)',
];

const MIN_PARK_AMOUNT = parseUnits('100', 18);

export async function parkIdleFunds(
  wallet: Wallet,
  amount: string,
): Promise<{ txHash: string }> {
  const parsedAmount = parseUnits(amount, 18);

  if (parsedAmount < MIN_PARK_AMOUNT) {
    throw new Error(`Monto mínimo para invertir: 100 DOC (recibido: ${amount})`);
  }

  try {
    const doc = new Contract(TOKEN_ADDRESSES.DOC, ERC20_ABI, wallet);
    const kDocAddress = IDLE_YIELD_CONTRACTS.kDOC;

    const approveTx = await doc.approve(kDocAddress, parsedAmount);
    const approveReceipt = await approveTx.wait();
    if (!approveReceipt) throw new Error('Approve transaction dropped');

    const kDoc = new Contract(kDocAddress, KDOC_ABI, wallet);
    const tx = await kDoc.mint(parsedAmount);
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Mint transaction dropped');

    return { txHash: tx.hash };
  } catch (err) {
    console.error(`[idle-yield] parkIdleFunds failed amount=${amount}:`, err);
    throw err;
  }
}

export async function unparkIdleFunds(
  wallet: Wallet,
  amount: string,
): Promise<{ txHash: string }> {
  const parsedAmount = parseUnits(amount, 18);

  try {
    const kDoc = new Contract(IDLE_YIELD_CONTRACTS.kDOC, KDOC_ABI, wallet);
    const tx = await kDoc.redeemUnderlying(parsedAmount);
    const receipt = await tx.wait();
    if (!receipt) throw new Error('RedeemUnderlying transaction dropped');

    return { txHash: tx.hash };
  } catch (err) {
    console.error(`[idle-yield] unparkIdleFunds failed amount=${amount}:`, err);
    throw err;
  }
}

export async function getIdleYieldBalance(
  walletAddress: string,
): Promise<{ docValue: string }> {
  try {
    const provider = getProvider();
    const kDoc = new Contract(IDLE_YIELD_CONTRACTS.kDOC, KDOC_ABI, provider);

    const kDocBalance: bigint = await kDoc.balanceOf(walletAddress);
    if (kDocBalance === 0n) {
      return { docValue: '0' };
    }

    const exchangeRate: bigint = await kDoc.exchangeRateStored();
    const docValue = (kDocBalance * exchangeRate) / (10n ** 18n);

    return { docValue: formatUnits(docValue, 18) };
  } catch (err) {
    console.error(`[idle-yield] getIdleYieldBalance failed for ${walletAddress}:`, err);
    return { docValue: '0' };
  }
}

export function isIdleYieldSupported(tokenSymbol: string): boolean {
  return tokenSymbol.toUpperCase() === 'DOC';
}
