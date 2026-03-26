import { eq, and, ne } from 'drizzle-orm';
import {
  db,
  getOrCreateUser,
  createDCAOrder,
  getActiveDCAOrders,
  updateOrderStatus,
  updateOrderNextExecution,
  getUserExecutions,
} from '../db';
import * as schema from '../db/schema';
import type { User, DCAOrder } from '../db/schema';
import { getUserWallet, getWalletBalance, getTokenBalance } from './wallet';
import { sendMessage } from './whatsapp';
import { parseMessage } from './parser';
import type { ParsedIntent } from './parser';
import { TOKEN_ADDRESSES } from '../config/tokens';
import { getQuote } from './swap';

const SUPPORTED_TOKENS = ['RBTC', ...Object.keys(TOKEN_ADDRESSES)];
const MAX_DCA_AMOUNT = 10000; // max per-execution amount in source token

function calcNextExecution(frequency: string): string {
  const now = new Date();
  if (frequency === 'hourly') now.setHours(now.getHours() + 1);
  else if (frequency === 'daily') now.setDate(now.getDate() + 1);
  else if (frequency === 'weekly') now.setDate(now.getDate() + 7);
  return now.toISOString();
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function handleStart(whatsappId: string, user: User): Promise<void> {
  const isNewUser = user.walletAddress === '';

  if (isNewUser) {
    const wallet = getUserWallet(user.walletIndex);
    const address = wallet.address;

    db.update(schema.users)
      .set({ walletAddress: address })
      .where(eq(schema.users.id, user.id))
      .run();

    await sendMessage(
      whatsappId,
      `Welcome to AutoStack!\n\nYour Rootstock wallet has been created:\n*${address}*\n\nDeposit rUSDT or RBTC to this address to start DCA investing.\n\nType *help* to see all available commands.`
    );
  } else {
    const balance = await getWalletBalance(user.walletAddress);
    await sendMessage(
      whatsappId,
      `Welcome back!\n\nYour wallet: *${user.walletAddress}*\nRBTC balance: ${parseFloat(balance).toFixed(8)} RBTC\n\nType *status* to see your DCA orders or *help* for all commands.`
    );
  }
}

async function handleDca(
  whatsappId: string,
  user: User,
  params: ParsedIntent['params']
): Promise<void> {
  if (!params.token || !params.amount || !params.frequency) {
    await sendMessage(
      whatsappId,
      'To set up a DCA order I need:\n• *Token* to buy (e.g. RBTC, DOC, RIF)\n• *Amount* per execution (in rUSDT)\n• *Frequency* (hourly, daily, weekly)\n\nExample: "Buy 10 RBTC daily"'
    );
    return;
  }

  // Validate amount
  const amountNum = parseFloat(params.amount);
  if (isNaN(amountNum) || amountNum <= 0) {
    await sendMessage(whatsappId, 'Invalid amount. Please enter a positive number.');
    return;
  }
  if (amountNum > MAX_DCA_AMOUNT) {
    await sendMessage(whatsappId, `Amount too large. Maximum per execution: ${MAX_DCA_AMOUNT}.`);
    return;
  }

  const normalizedToken = params.token.toUpperCase();
  if (!SUPPORTED_TOKENS.includes(normalizedToken)) {
    await sendMessage(
      whatsappId,
      `Unsupported token "${params.token}".\nSupported: RBTC, DOC, RIF, RUSDT, SOV, DLLR, USDC`
    );
    return;
  }

  const validFrequencies = ['hourly', 'daily', 'weekly'];
  if (!validFrequencies.includes(params.frequency)) {
    await sendMessage(
      whatsappId,
      `Invalid frequency "${params.frequency}". Use: hourly, daily, or weekly.`
    );
    return;
  }

  const fromToken = params.fromToken ?? 'RUSDT';
  const nextExecution = calcNextExecution(params.frequency);

  const order = createDCAOrder({
    userId: user.id,
    fromToken,
    toToken: normalizedToken,
    amount: params.amount,
    frequency: params.frequency,
    status: 'active',
    nextExecution,
  });

  // Show a live quote so user sees the bot is connected to the DEX
  let quoteInfo = '';
  try {
    const quote = await getQuote(fromToken, normalizedToken, params.amount);
    quoteInfo = `\nCurrent rate: ${params.amount} ${fromToken} ≈ ${quote} ${normalizedToken}`;
  } catch {
    quoteInfo = '\n(Quote unavailable — will execute at market rate)';
  }

  await sendMessage(
    whatsappId,
    `DCA order created!\n\n*Buy ${params.amount} ${fromToken} → ${normalizedToken}*\nFrequency: ${params.frequency}\nNext execution: ${formatDate(nextExecution)}\nOrder ID: #${order.id}${quoteInfo}\n\nType *status* to view your orders.`
  );
}

async function handleBalance(whatsappId: string, user: User): Promise<void> {
  if (!user.walletAddress) {
    await sendMessage(whatsappId, 'No wallet found. Type *start* to create one.');
    return;
  }

  const [rbtcBalance, rusdtBalance, docBalance, rifBalance] = await Promise.all([
    getWalletBalance(user.walletAddress),
    getTokenBalance(user.walletAddress, TOKEN_ADDRESSES.RUSDT),
    getTokenBalance(user.walletAddress, TOKEN_ADDRESSES.DOC),
    getTokenBalance(user.walletAddress, TOKEN_ADDRESSES.RIF),
  ]);

  await sendMessage(
    whatsappId,
    `*Wallet Balance*\n\n` +
      `Address: ${user.walletAddress}\n\n` +
      `RBTC: ${parseFloat(rbtcBalance).toFixed(8)}\n` +
      `rUSDT: ${parseFloat(rusdtBalance).toFixed(2)}\n` +
      `DOC: ${parseFloat(docBalance).toFixed(2)}\n` +
      `RIF: ${parseFloat(rifBalance).toFixed(4)}`
  );
}

async function handleStatus(whatsappId: string, user: User): Promise<void> {
  const orders = getActiveDCAOrders(user.id);
  const executions = getUserExecutions(user.id, 5);

  let msg = '*AutoStack Status*\n\n';

  if (orders.length === 0) {
    msg += 'No active DCA orders.\n';
  } else {
    msg += `*Active Orders (${orders.length}):*\n`;
    for (const order of orders) {
      msg += `\n#${order.id}: ${order.amount} ${order.fromToken} → ${order.toToken}\n`;
      msg += `   ${order.frequency} | Next: ${formatDate(order.nextExecution)}\n`;
    }
  }

  if (executions.length > 0) {
    msg += '\n*Recent Executions:*\n';
    for (const exec of executions) {
      const icon =
        exec.status === 'completed' ? 'ok' : exec.status === 'failed' ? 'fail' : 'pending';
      msg += `[${icon}] ${formatDate(exec.executedAt)} — ${exec.amountIn} in`;
      if (exec.amountOut) msg += ` → ${exec.amountOut} out`;
      msg += '\n';
    }
  }

  await sendMessage(whatsappId, msg.trim());
}

async function handlePause(
  whatsappId: string,
  user: User,
  params: ParsedIntent['params']
): Promise<void> {
  const orders = getActiveDCAOrders(user.id);

  if (orders.length === 0) {
    await sendMessage(whatsappId, 'No active DCA orders to pause.');
    return;
  }

  let order: DCAOrder | undefined;
  if (params.orderId != null) {
    order = orders.find((o) => o.id === params.orderId);
    if (!order) {
      await sendMessage(whatsappId, `No active order found with ID #${params.orderId}.`);
      return;
    }
  } else {
    order = orders[orders.length - 1];
  }

  updateOrderStatus(order.id, 'paused');
  await sendMessage(
    whatsappId,
    `Order #${order.id} paused.\n${order.amount} ${order.fromToken} → ${order.toToken} (${order.frequency})\n\nType *resume* to restart it.`
  );
}

async function handleResume(
  whatsappId: string,
  user: User,
  params: ParsedIntent['params']
): Promise<void> {
  const pausedOrders = db
    .select()
    .from(schema.dcaOrders)
    .where(and(eq(schema.dcaOrders.userId, user.id), eq(schema.dcaOrders.status, 'paused')))
    .all();

  if (pausedOrders.length === 0) {
    await sendMessage(whatsappId, 'No paused DCA orders found.');
    return;
  }

  let order: DCAOrder | undefined;
  if (params.orderId != null) {
    order = pausedOrders.find((o) => o.id === params.orderId);
    if (!order) {
      await sendMessage(whatsappId, `No paused order found with ID #${params.orderId}.`);
      return;
    }
  } else {
    order = pausedOrders[pausedOrders.length - 1];
  }

  updateOrderStatus(order.id, 'active');
  updateOrderNextExecution(order.id, new Date().toISOString());

  await sendMessage(
    whatsappId,
    `Order #${order.id} resumed!\n${order.amount} ${order.fromToken} → ${order.toToken} (${order.frequency})\n\nNext execution will run shortly.`
  );
}

async function handleCancel(
  whatsappId: string,
  user: User,
  params: ParsedIntent['params']
): Promise<void> {
  const cancellableOrders = db
    .select()
    .from(schema.dcaOrders)
    .where(and(eq(schema.dcaOrders.userId, user.id), ne(schema.dcaOrders.status, 'cancelled')))
    .all();

  if (cancellableOrders.length === 0) {
    await sendMessage(whatsappId, 'No orders to cancel.');
    return;
  }

  let order: DCAOrder | undefined;
  if (params.orderId != null) {
    order = cancellableOrders.find((o) => o.id === params.orderId);
    if (!order) {
      await sendMessage(whatsappId, `No cancellable order found with ID #${params.orderId}.`);
      return;
    }
  } else {
    order = cancellableOrders[cancellableOrders.length - 1];
  }

  updateOrderStatus(order.id, 'cancelled');
  await sendMessage(
    whatsappId,
    `Order #${order.id} cancelled.\n${order.amount} ${order.fromToken} → ${order.toToken} (${order.frequency})`
  );
}

async function handleDeposit(whatsappId: string, user: User): Promise<void> {
  if (!user.walletAddress) {
    await sendMessage(whatsappId, 'No wallet found. Type *start* to create one.');
    return;
  }

  await sendMessage(
    whatsappId,
    `*Deposit Address*\n\n*${user.walletAddress}*\n\nSend RBTC or rUSDT to this address on the Rootstock network to fund your DCA orders.`
  );
}

async function handleHelp(whatsappId: string): Promise<void> {
  await sendMessage(
    whatsappId,
    `*AutoStack Commands*\n\n` +
      `*start* — Register or view your wallet\n` +
      `*balance* — View wallet balances\n` +
      `*deposit* — Get your deposit address\n` +
      `*status* — View active DCA orders & history\n` +
      `*help* — Show this message\n\n` +
      `*Setting up DCA:*\n` +
      `"Buy 10 RBTC daily"\n` +
      `"Stack 5 DOC every week"\n` +
      `"DCA 1 rUSDT into RIF hourly"\n\n` +
      `*Managing orders:*\n` +
      `"Pause order #3"\n` +
      `"Resume my DCA"\n` +
      `"Cancel order #2"\n\n` +
      `Supported tokens: RBTC, DOC, RIF, rUSDT, SOV, DLLR, USDC\n` +
      `Supported frequencies: hourly, daily, weekly`
  );
}

async function handleUnknown(whatsappId: string): Promise<void> {
  await sendMessage(
    whatsappId,
    `I didn't understand that.\n\nTry saying something like:\n• "Buy 10 RBTC daily"\n• "Check my balance"\n• "Show my orders"\n\nType *help* to see all available commands.`
  );
}

export async function processMessage(
  whatsappId: string,
  messageText: string
): Promise<void> {
  let intent: ParsedIntent;
  try {
    intent = await parseMessage(messageText);
  } catch (err) {
    console.error('[commands] parseMessage failed:', err);
    await sendMessage(whatsappId, 'Something went wrong processing your message. Please try again.');
    return;
  }

  console.log(
    `[commands] whatsapp=${whatsappId} action=${intent.action} confidence=${intent.confidence}`
  );

  const user = getOrCreateUser(whatsappId);

  // New user with no wallet — always onboard first
  if (user.walletAddress === '' && intent.action !== 'help') {
    await handleStart(whatsappId, user);
    return;
  }

  try {
    switch (intent.action) {
      case 'start':
        await handleStart(whatsappId, user);
        break;
      case 'dca':
        await handleDca(whatsappId, user, intent.params);
        break;
      case 'balance':
        await handleBalance(whatsappId, user);
        break;
      case 'status':
        await handleStatus(whatsappId, user);
        break;
      case 'pause':
        await handlePause(whatsappId, user, intent.params);
        break;
      case 'resume':
        await handleResume(whatsappId, user, intent.params);
        break;
      case 'cancel':
        await handleCancel(whatsappId, user, intent.params);
        break;
      case 'deposit':
        await handleDeposit(whatsappId, user);
        break;
      case 'help':
        await handleHelp(whatsappId);
        break;
      case 'unknown':
      default:
        await handleUnknown(whatsappId);
        break;
    }
  } catch (err) {
    console.error(`[commands] handler error for action=${intent.action}:`, err);
    await sendMessage(
      whatsappId,
      'Something went wrong. Please try again or type *help* for available commands.'
    );
  }
}
