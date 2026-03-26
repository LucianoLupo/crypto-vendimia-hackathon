import { db } from '../db';
import * as schema from '../db/schema';
import { getWalletBalance, getTokenBalance } from './wallet';
import { sendMessage } from './whatsapp';
import { TOKEN_ADDRESSES } from '../config/tokens';

const lastKnownRbtc = new Map<string, string>();
const lastKnownRusdt = new Map<string, string>();
let watcherInterval: ReturnType<typeof setInterval> | null = null;
let isFirstRun = true;

async function checkDeposits(): Promise<void> {
  const users = db.select().from(schema.users).all();

  for (const user of users) {
    if (!user.walletAddress) continue;

    try {
      const [rbtcBalance, rusdtBalance] = await Promise.all([
        getWalletBalance(user.walletAddress),
        getTokenBalance(user.walletAddress, TOKEN_ADDRESSES.RUSDT),
      ]);

      if (!isFirstRun) {
        const lastRbtc = lastKnownRbtc.get(user.walletAddress);
        const lastRusdt = lastKnownRusdt.get(user.walletAddress);

        if (lastRbtc !== undefined && parseFloat(rbtcBalance) > parseFloat(lastRbtc)) {
          const diff = (parseFloat(rbtcBalance) - parseFloat(lastRbtc)).toFixed(8);
          await sendMessage(
            user.whatsappId,
            `Deposito detectado! +${diff} RBTC recibidos.\nNuevo saldo: ${parseFloat(rbtcBalance).toFixed(8)} RBTC\n\nEscribi *ayuda* para configurar tu DCA.`
          );
        }

        if (lastRusdt !== undefined && parseFloat(rusdtBalance) > parseFloat(lastRusdt)) {
          const diff = (parseFloat(rusdtBalance) - parseFloat(lastRusdt)).toFixed(2);
          await sendMessage(
            user.whatsappId,
            `Deposito detectado! +${diff} rUSDT recibidos.\nNuevo saldo: ${parseFloat(rusdtBalance).toFixed(2)} rUSDT\n\nEscribi *ayuda* para configurar tu DCA.`
          );
        }
      }

      lastKnownRbtc.set(user.walletAddress, rbtcBalance);
      lastKnownRusdt.set(user.walletAddress, rusdtBalance);
    } catch (err) {
      console.error(`[deposit-watcher] Failed to check balance for user ${user.walletAddress}:`, err);
    }
  }

  if (isFirstRun) {
    isFirstRun = false;
    console.log(`[deposit-watcher] Initial balances populated for ${users.length} users`);
  }
}

export function startDepositWatcher(): void {
  // Populate initial balances immediately without sending notifications
  checkDeposits().catch((err) =>
    console.error('[deposit-watcher] Initial populate failed:', err)
  );

  watcherInterval = setInterval(async () => {
    console.log('[deposit-watcher] Checking wallet balances...');
    await checkDeposits();
  }, 60_000);

  console.log('[deposit-watcher] Started — polling every 60s');
}

export function stopDepositWatcher(): void {
  if (watcherInterval) {
    clearInterval(watcherInterval);
    watcherInterval = null;
    console.log('[deposit-watcher] Stopped');
  }
}
