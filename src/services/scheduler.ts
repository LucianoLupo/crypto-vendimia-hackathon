import cron from 'node-cron';
import { eq } from 'drizzle-orm';
import { getDueOrders, updateOrderNextExecution, logExecution, db } from '../db';
import * as schema from '../db/schema';
import { getUserWallet } from './wallet';
import { executeSwap } from './swap';
import { depositToYield } from './yield';
import { sendMessage } from './whatsapp';
import { calculateSmartAmount } from './smart-dca';

let schedulerTask: cron.ScheduledTask | null = null;
let isProcessing = false;

function calcNextExecution(frequency: string): string {
  const next = new Date();
  switch (frequency) {
    case 'hourly':
      next.setHours(next.getHours() + 1);
      break;
    case 'weekly':
      next.setDate(next.getDate() + 7);
      break;
    case 'daily':
    default:
      next.setDate(next.getDate() + 1);
  }
  return next.toISOString();
}

async function processDueOrders(): Promise<void> {
  if (isProcessing) {
    console.log('[scheduler] Previous run still processing, skipping');
    return;
  }
  isProcessing = true;
  try {
  const dueOrders = getDueOrders();
  console.log(`[scheduler] Found ${dueOrders.length} due orders`);

  for (const order of dueOrders) {
    try {
      const user = db.select().from(schema.users).where(eq(schema.users.id, order.userId)).get();
      if (!user) {
        console.error(`[scheduler] User not found for order ${order.id}, userId=${order.userId}`);
        continue;
      }

      const wallet = getUserWallet(user.walletIndex);

      let swapTxHash: string | null = null;
      let amountOut: string | null = null;
      let yieldTxHash: string | null = null;
      let yieldTokensReceived: string | null = null;
      let executionStatus = 'success';
      let errorMsg: string | null = null;
      let smartDcaReason = '';
      let effectiveAmount = order.amount;

      try {
        // Smart DCA: adjust amount based on price vs 7-day SMA
        const smartResult = await calculateSmartAmount(order.amount, order.toToken);
        effectiveAmount = smartResult.adjustedAmount;
        smartDcaReason = smartResult.reason;
        console.log(`[scheduler] Smart DCA order=${order.id}: base=${order.amount} adjusted=${effectiveAmount} reason="${smartDcaReason}"`);

        const swapResult = await executeSwap(wallet, order.fromToken, order.toToken, effectiveAmount);
        swapTxHash = swapResult.txHash;
        amountOut = swapResult.amountOut;
        console.log(`[scheduler] Swap OK order=${order.id} txHash=${swapTxHash} amountOut=${amountOut}`);

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
      } catch (swapErr) {
        console.error(`[scheduler] Swap failed for order ${order.id}:`, swapErr);
        executionStatus = 'failed';
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

      const nextExecution = calcNextExecution(order.frequency);
      updateOrderNextExecution(order.id, nextExecution);

      let message: string;
      if (executionStatus === 'success' && swapTxHash) {
        message =
          `DCA ejecutado: ${effectiveAmount} ${order.fromToken} → ${amountOut} ${order.toToken}\n` +
          `Tx: https://explorer.rootstock.io/tx/${swapTxHash}`;
        if (smartDcaReason && smartDcaReason !== 'Price is within normal range' && smartDcaReason !== 'Price data unavailable, using base amount') {
          message += `\n\nSmart DCA: ${smartDcaReason}`;
        }
        if (yieldTxHash) {
          message +=
            `\n\nDeposito en yield: ${yieldTokensReceived} i${order.toToken} recibidos\n` +
            `Tx: https://explorer.rootstock.io/tx/${yieldTxHash}`;
        } else if (errorMsg) {
          message += `\n\nNota: ${errorMsg}`;
        }
        message += `\n\nProxima ejecucion: ${new Date(nextExecution).toUTCString()}`;
      } else {
        message =
          `Fallo la ejecucion DCA de ${order.amount} ${order.fromToken} → ${order.toToken}\n` +
          `Error: ${errorMsg}\n\n` +
          `Se reintentara: ${new Date(nextExecution).toUTCString()}`;
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
    console.log('[scheduler] Tick — checking due orders...');
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
