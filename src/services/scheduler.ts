import cron from 'node-cron';
import { eq } from 'drizzle-orm';
import { parseEther } from 'ethers';
import { getDueOrders, updateOrderNextExecution, updateOrderStatus, logExecution, incrementFailureCount, resetFailureCount, db } from '../db';
import * as schema from '../db/schema';
import { getUserWallet, getProvider, getTokenBalance } from './wallet';
import { executeSwap } from './swap';
import { depositToYield } from './yield';
import { unparkIdleFunds, parkIdleFunds, getIdleYieldBalance, isIdleYieldSupported } from './idle-yield';
import { sendMessage } from './whatsapp';
import { calculateSmartAmount } from './smart-dca';
import { EXEC_STATUS, ORDER_STATUS } from '../config/constants';
import { TOKEN_ADDRESSES } from '../config/tokens';
import { calcNextExecution } from '../utils/time';
import { parseUnits } from 'ethers';

const MAX_CONSECUTIVE_FAILURES = 3;
const MIN_GAS_BALANCE = parseEther('0.00005');

/** Map of whatsappId → timestamp of last DCA execution. Used by deposit-watcher to suppress false-positive notifications. */
export const recentDcaExecutions = new Map<string, number>();

let schedulerTask: cron.ScheduledTask | null = null;
let isProcessing = false;

async function processDueOrders(): Promise<void> {
  if (isProcessing) {
    console.log('[scheduler] Previous run still processing, skipping');
    return;
  }
  isProcessing = true;
  try {
  const dueOrders = getDueOrders();
  if (dueOrders.length > 0) {
    console.log(`[scheduler] Found ${dueOrders.length} due orders`);
  }

  for (const order of dueOrders) {
    try {
      const user = db.select().from(schema.users).where(eq(schema.users.id, order.userId)).get();
      if (!user) {
        console.error(`[scheduler] User not found for order ${order.id}, userId=${order.userId}`);
        continue;
      }

      const wallet = getUserWallet(user.walletIndex);

      // 4C: Pre-check gas balance before swap
      const provider = getProvider();
      const gasBalance = await provider.getBalance(wallet.address);
      if (gasBalance < MIN_GAS_BALANCE) {
        console.log(`[scheduler] Insufficient gas for order ${order.id}, balance=${gasBalance.toString()}`);
        const nextExecution = calcNextExecution(order.frequency, order.nextExecution);
        updateOrderNextExecution(order.id, nextExecution);
        await sendMessage(
          user.whatsappId,
          `Saldo de gas insuficiente (RBTC). Depositá RBTC en tu wallet para cubrir gas.\n\nOrden #${order.id} se reintentará: ${new Date(nextExecution).toUTCString()}`
        );
        // Don't count as failure for circuit breaker
        continue;
      }

      let swapTxHash: string | null = null;
      let amountOut: string | null = null;
      let yieldTxHash: string | null = null;
      let yieldTokensReceived: string | null = null;
      let executionStatus: string = EXEC_STATUS.COMPLETED;
      let errorMsg: string | null = null;
      let smartDcaReason = '';
      let effectiveAmount = order.amount;

      try {
        // Smart DCA: adjust amount based on price vs 7-day SMA
        const smartResult = await calculateSmartAmount(order.amount, order.toToken);
        effectiveAmount = smartResult.adjustedAmount;
        smartDcaReason = smartResult.reason;
        console.log(`[scheduler] Smart DCA order=${order.id}: base=${order.amount} adjusted=${effectiveAmount} reason="${smartDcaReason}"`);

        // Idle yield: unpark DOC from Tropykus kDOC before swap
        if (isIdleYieldSupported(order.fromToken)) {
          try {
            const yieldBalance = await getIdleYieldBalance(wallet.address);
            const yieldVal = parseFloat(yieldBalance.docValue);
            if (yieldVal > 0) {
              const needed = parseFloat(effectiveAmount);
              const unparkAmount = Math.min(needed, yieldVal).toString();
              console.log(`[scheduler] Unparking ${unparkAmount} DOC from kDOC for order ${order.id}`);
              await unparkIdleFunds(wallet, unparkAmount);
            }
          } catch (unparkErr) {
            console.error(`[scheduler] Idle yield unpark failed for order ${order.id}, proceeding with free DOC:`, unparkErr);
          }
        }

        const swapResult = await executeSwap(wallet, order.fromToken, order.toToken, effectiveAmount);
        swapTxHash = swapResult.txHash;
        amountOut = swapResult.amountOut;
        console.log(`[scheduler] Swap OK order=${order.id} txHash=${swapTxHash} amountOut=${amountOut}`);

        // 4E: Record cooldown for deposit-watcher suppression
        recentDcaExecutions.set(user.whatsappId, Date.now());

        if (order.autoYield === 1) {
          try {
            const yieldResult = await depositToYield(wallet, order.toToken, swapResult.amountOut);
            yieldTxHash = yieldResult.txHash;
            yieldTokensReceived = yieldResult.iTokensReceived;
            console.log(`[scheduler] Yield OK order=${order.id} yieldTxHash=${yieldTxHash}`);
          } catch (yieldErr) {
            console.error(`[scheduler] Yield failed for order ${order.id}:`, yieldErr);
            errorMsg = `Yield failed: ${yieldErr instanceof Error ? yieldErr.message : String(yieldErr)}`;
          }
        }

        // Idle yield: re-park remaining DOC into Tropykus kDOC after swap
        if (isIdleYieldSupported(order.fromToken)) {
          try {
            const freeDoc = await getTokenBalance(wallet.address, TOKEN_ADDRESSES.DOC);
            const freeDocBigInt = parseUnits(freeDoc, 18);
            const minPark = parseUnits('100', 18);
            if (freeDocBigInt > minPark) {
              console.log(`[scheduler] Re-parking ${freeDoc} DOC into kDOC for order ${order.id}`);
              await parkIdleFunds(wallet, freeDoc);
            }
          } catch (parkErr) {
            console.error(`[scheduler] Idle yield re-park failed for order ${order.id}:`, parkErr);
          }
        }
      } catch (swapErr) {
        console.error(`[scheduler] Swap failed for order ${order.id}:`, swapErr);
        executionStatus = EXEC_STATUS.FAILED;
        errorMsg = swapErr instanceof Error ? swapErr.message : String(swapErr);
      }

      logExecution({
        dcaOrderId: order.id,
        userId: order.userId,
        swapTxHash,
        yieldTxHash,
        amountIn: effectiveAmount ?? order.amount,
        amountOut,
        yieldTokensReceived,
        status: executionStatus,
        error: errorMsg,
      });

      // 4D: Calculate next execution from scheduled time, not current time
      const nextExecution = calcNextExecution(order.frequency, order.nextExecution);
      updateOrderNextExecution(order.id, nextExecution);

      // 4B: Circuit breaker — track consecutive failures
      if (executionStatus === EXEC_STATUS.FAILED) {
        const failCount = incrementFailureCount(order.id);
        if (failCount >= MAX_CONSECUTIVE_FAILURES) {
          updateOrderStatus(order.id, ORDER_STATUS.PAUSED);
          await sendMessage(
            user.whatsappId,
            `Orden #${order.id} pausada automáticamente después de ${failCount} fallos consecutivos.\n` +
            `Último error: ${errorMsg}\n\n` +
            `Revisá tu balance y escribí *reanudar* para reactivarla.`
          );
          continue;
        }
      } else {
        resetFailureCount(order.id);
      }

      let message: string;
      if (executionStatus === EXEC_STATUS.COMPLETED && swapTxHash) {
        message =
          `DCA ejecutado: ${effectiveAmount} ${order.fromToken} → ${amountOut} ${order.toToken}\n` +
          `Tx: https://explorer.rootstock.io/tx/${swapTxHash}`;
        if (smartDcaReason && smartDcaReason !== 'Precio dentro del rango normal' && smartDcaReason !== 'Datos de precio no disponibles, usando monto base') {
          message += `\n\nSmart DCA: ${smartDcaReason}`;
        }
        if (yieldTxHash) {
          message +=
            `\n\nDepósito en yield: ${yieldTokensReceived} i${order.toToken} recibidos\n` +
            `Tx: https://explorer.rootstock.io/tx/${yieldTxHash}`;
        } else if (errorMsg) {
          message += `\n\nNota: ${errorMsg}`;
        }
        message += `\n\nPróxima ejecución: ${new Date(nextExecution).toUTCString()}`;
      } else {
        message =
          `Falló la ejecución DCA de ${order.amount} ${order.fromToken} → ${order.toToken}\n` +
          `Error: ${errorMsg}\n\n` +
          `Se reintentará: ${new Date(nextExecution).toUTCString()}`;
      }

      await sendMessage(user.whatsappId, message);
    } catch (err) {
      console.error(`[scheduler] Unexpected error processing order ${order.id}:`, err);
    }
  }
  } finally {
    isProcessing = false;
  }
}

export function startScheduler(): void {
  schedulerTask = cron.schedule('* * * * *', async () => {
    await processDueOrders();
  });
  console.log('[scheduler] Started — running every minute');
}

export function stopScheduler(): void {
  if (schedulerTask) {
    schedulerTask.stop();
    schedulerTask = null;
    console.log('[scheduler] Stopped');
  }
}
