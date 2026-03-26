import { Contract, Wallet, parseUnits, formatUnits } from 'ethers';
import {
  TOKEN_ADDRESSES,
  CONTRACTS,
  TOKEN_DECIMALS,
  DEFAULT_FEE_TIER,
  DEFAULT_SLIPPAGE,
  tokenBySymbol,
} from '../config/tokens';
import { getProvider } from './wallet';

const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
];

const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

function resolveTokenAddress(symbol: string): string {
  const normalized = symbol.toUpperCase();
  if (normalized === 'RBTC') return TOKEN_ADDRESSES.WRBTC;
  const address = tokenBySymbol(symbol);
  if (!address) throw new Error(`Unknown token symbol: ${symbol}`);
  return address;
}

function getTokenDecimals(symbol: string): number {
  const normalized = symbol.toUpperCase();
  if (normalized === 'RBTC') return TOKEN_DECIMALS.WRBTC;
  const decimals = TOKEN_DECIMALS[normalized];
  if (decimals === undefined) throw new Error(`Unknown token decimals for: ${symbol}`);
  return decimals;
}

export async function getQuote(
  tokenInSymbol: string,
  tokenOutSymbol: string,
  amountIn: string
): Promise<string> {
  try {
    const provider = getProvider();
    const tokenIn = resolveTokenAddress(tokenInSymbol);
    const tokenOut = resolveTokenAddress(tokenOutSymbol);
    const decimalsIn = getTokenDecimals(tokenInSymbol);
    const decimalsOut = getTokenDecimals(tokenOutSymbol);

    const amountInParsed = parseUnits(amountIn, decimalsIn);

    const quoter = new Contract(CONTRACTS.QuoterV2, QUOTER_ABI, provider);

    const [amountOut] = await quoter.quoteExactInputSingle.staticCall({
      tokenIn,
      tokenOut,
      amountIn: amountInParsed,
      fee: DEFAULT_FEE_TIER,
      sqrtPriceLimitX96: 0n,
    });

    const formatted = formatUnits(amountOut, decimalsOut);
    console.log(`Quote: ${amountIn} ${tokenInSymbol} → ${formatted} ${tokenOutSymbol}`);
    return formatted;
  } catch (err) {
    console.error(`getQuote failed for ${tokenInSymbol} → ${tokenOutSymbol}:`, err);
    throw new Error(`Failed to get quote: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function ensureApproval(
  wallet: Wallet,
  tokenAddress: string,
  spenderAddress: string,
  amount: bigint
): Promise<void> {
  try {
    const token = new Contract(tokenAddress, ERC20_ABI, wallet);
    const allowance: bigint = await token.allowance(wallet.address, spenderAddress);

    if (allowance >= amount) {
      console.log(`Allowance sufficient: ${allowance} >= ${amount}`);
      return;
    }

    console.log(`Approving ${spenderAddress} to spend token ${tokenAddress}...`);
    const tx = await token.approve(spenderAddress, amount);
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Approval transaction was dropped or replaced');
    console.log(`Approval confirmed: ${tx.hash}`);
  } catch (err) {
    console.error(`ensureApproval failed for token ${tokenAddress}:`, err);
    throw new Error(`Approval failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function executeSwap(
  wallet: Wallet,
  tokenInSymbol: string,
  tokenOutSymbol: string,
  amountIn: string
): Promise<{ txHash: string; amountOut: string }> {
  try {
    const isNativeRBTC = tokenInSymbol.toUpperCase() === 'RBTC';
    const tokenIn = resolveTokenAddress(tokenInSymbol);
    const tokenOut = resolveTokenAddress(tokenOutSymbol);
    const decimalsIn = getTokenDecimals(tokenInSymbol);
    const decimalsOut = getTokenDecimals(tokenOutSymbol);

    const amountInParsed = parseUnits(amountIn, decimalsIn);

    const quoteOut = await getQuote(tokenInSymbol, tokenOutSymbol, amountIn);
    const quoteOutParsed = parseUnits(quoteOut, decimalsOut);

    // Apply slippage: DEFAULT_SLIPPAGE = 100 basis points = 1%
    const slippageDenominator = 10000n;
    const slippageNumerator = slippageDenominator - BigInt(DEFAULT_SLIPPAGE);
    const amountOutMinimum = (quoteOutParsed * slippageNumerator) / slippageDenominator;

    console.log(
      `Swapping ${amountIn} ${tokenInSymbol} → min ${formatUnits(amountOutMinimum, decimalsOut)} ${tokenOutSymbol}`
    );

    const router = new Contract(CONTRACTS.SwapRouter02, ROUTER_ABI, wallet);

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300); // 5 min

    const params = {
      tokenIn,
      tokenOut,
      fee: DEFAULT_FEE_TIER,
      recipient: wallet.address,
      deadline,
      amountIn: amountInParsed,
      amountOutMinimum,
      sqrtPriceLimitX96: 0n,
    };

    // Check pre-swap balance to calculate actual output
    const provider = getProvider();
    const isNativeOut = tokenOutSymbol.toUpperCase() === 'RBTC';
    let preBalance: bigint;
    if (isNativeOut) {
      preBalance = await provider.getBalance(wallet.address);
    } else {
      const outToken = new Contract(tokenOut, ['function balanceOf(address) view returns (uint256)'], provider);
      preBalance = await outToken.balanceOf(wallet.address);
    }

    let tx;
    if (isNativeRBTC) {
      tx = await router.exactInputSingle(params, { value: amountInParsed });
    } else {
      await ensureApproval(wallet, tokenIn, CONTRACTS.SwapRouter02, amountInParsed);
      tx = await router.exactInputSingle(params);
    }

    console.log(`Swap tx submitted: ${tx.hash}`);
    const receipt = await tx.wait();
    if (!receipt) throw new Error(`Swap transaction ${tx.hash} was dropped or replaced`);
    console.log(`Swap confirmed in block ${receipt.blockNumber}`);

    // Calculate actual output from balance difference
    let postBalance: bigint;
    if (isNativeOut) {
      postBalance = await provider.getBalance(wallet.address);
    } else {
      const outToken = new Contract(tokenOut, ['function balanceOf(address) view returns (uint256)'], provider);
      postBalance = await outToken.balanceOf(wallet.address);
    }
    const actualOut = postBalance - preBalance;
    const amountOutFormatted = formatUnits(actualOut > 0n ? actualOut : amountOutMinimum, decimalsOut);

    return { txHash: tx.hash, amountOut: amountOutFormatted };
  } catch (err) {
    console.error(`executeSwap failed for ${tokenInSymbol} → ${tokenOutSymbol}:`, err);
    throw new Error(`Swap failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
