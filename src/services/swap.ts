import { Contract, Wallet, parseUnits, formatUnits } from 'ethers';
import {
  TOKEN_ADDRESSES,
  CONTRACTS,
  TOKEN_DECIMALS,
  DEFAULT_FEE_TIER,
  DEFAULT_SLIPPAGE,
  ERC20_ABI,
  tokenBySymbol,
} from '../config/tokens';
import { getProvider } from './wallet';

const ROUTER_ABI = [
  // SwapRouter02 on RSK: deadline is NOT in the struct, use multicall wrapper
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
  'function multicall(uint256 deadline, bytes[] data) external payable returns (bytes[] results)',
];

const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
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

    // SwapRouter02 struct does NOT include deadline — use multicall wrapper
    const swapParams = {
      tokenIn,
      tokenOut,
      fee: DEFAULT_FEE_TIER,
      recipient: wallet.address,
      amountIn: amountInParsed,
      amountOutMinimum,
      sqrtPriceLimitX96: 0n,
    };

    // Check pre-swap WRBTC/ERC20 balance (Uniswap outputs WRBTC, not native RBTC)
    const provider = getProvider();
    const balanceToken = new Contract(tokenOut, ERC20_ABI, provider);
    const preBalance: bigint = await balanceToken.balanceOf(wallet.address);

    // Encode the swap call and wrap in multicall with deadline
    const routerInterface = router.interface;
    const swapCalldata = routerInterface.encodeFunctionData('exactInputSingle', [swapParams]);

    let tx;
    if (isNativeRBTC) {
      tx = await router.multicall(deadline, [swapCalldata], { value: amountInParsed });
    } else {
      await ensureApproval(wallet, tokenIn, CONTRACTS.SwapRouter02, amountInParsed);
      tx = await router.multicall(deadline, [swapCalldata]);
    }

    console.log(`Swap tx submitted: ${tx.hash}`);
    const receipt = await tx.wait();
    if (!receipt) throw new Error(`Swap transaction ${tx.hash} was dropped or replaced`);
    console.log(`Swap confirmed in block ${receipt.blockNumber}`);

    // Measure actual output from ERC20 balance diff
    const postBalance: bigint = await balanceToken.balanceOf(wallet.address);
    const actualOut = postBalance - preBalance;

    // If output is RBTC, unwrap WRBTC → native RBTC (needed for Sovryn iRBTC yield)
    const isRbtcOut = tokenOutSymbol.toUpperCase() === 'RBTC';
    if (isRbtcOut && actualOut > 0n) {
      const wrbtc = new Contract(TOKEN_ADDRESSES.WRBTC, [
        'function withdraw(uint256 wad) external',
      ], wallet);
      const unwrapTx = await wrbtc.withdraw(actualOut);
      const unwrapReceipt = await unwrapTx.wait();
      if (!unwrapReceipt) throw new Error('WRBTC unwrap transaction dropped');
      console.log(`Unwrapped ${formatUnits(actualOut, decimalsOut)} WRBTC → native RBTC`);
    }

    const amountOutFormatted = formatUnits(actualOut > 0n ? actualOut : amountOutMinimum, decimalsOut);

    return { txHash: tx.hash, amountOut: amountOutFormatted };
  } catch (err) {
    console.error(`executeSwap failed for ${tokenInSymbol} → ${tokenOutSymbol}:`, err);
    throw new Error(`Swap failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
