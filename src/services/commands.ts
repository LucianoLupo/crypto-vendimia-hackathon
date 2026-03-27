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
import { ORDER_STATUS, EXEC_STATUS } from '../config/constants';
import { getQuote } from './swap';
import { getSupportedYieldTokens } from './yield';
import { parkIdleFunds, getIdleYieldBalance } from './idle-yield';
import { calcNextExecution } from '../utils/time';

const SUPPORTED_TOKENS = ['RBTC', ...Object.keys(TOKEN_ADDRESSES)];
const MAX_DCA_AMOUNT = 10000;

const FREQ_LABELS: Record<string, string> = {
  hourly: 'cada hora',
  daily: 'diariamente',
  weekly: 'semanalmente',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('es-AR', {
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
      `🚀 Bienvenido a *SatsPilot*! Tu copiloto cripto en WhatsApp.\n\nTu wallet en Rootstock fue creada:\n*${address}*\n\nEnviá rUSDT o RBTC a esta dirección para empezar a invertir con DCA.\n\nEscribí *ayuda* para ver todos los comandos.`
    );
  } else {
    const balance = await getWalletBalance(user.walletAddress);
    await sendMessage(
      whatsappId,
      `Hola de nuevo!\n\nTu wallet: *${user.walletAddress}*\nBalance RBTC: ${parseFloat(balance).toFixed(8)}\n\nEscribí *estado* para ver tus órdenes o *ayuda* para los comandos.`
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
      'Para crear una orden DCA necesito:\n• *Token* a comprar (ej: RBTC, DOC, RIF)\n• *Monto* por ejecución (en rUSDT)\n• *Frecuencia* (cada hora, diario, semanal)\n\nEjemplo: "Comprar 10 RBTC diario"'
    );
    return;
  }

  const amountNum = parseFloat(params.amount);
  if (isNaN(amountNum) || amountNum <= 0) {
    await sendMessage(whatsappId, 'Monto inválido. Ingresá un número positivo.');
    return;
  }
  if (amountNum > MAX_DCA_AMOUNT) {
    await sendMessage(whatsappId, `Monto muy grande. Máximo por ejecución: ${MAX_DCA_AMOUNT}.`);
    return;
  }

  const normalizedToken = params.token.toUpperCase();
  if (!SUPPORTED_TOKENS.includes(normalizedToken)) {
    await sendMessage(
      whatsappId,
      `Token "${params.token}" no soportado.\nDisponibles: RBTC, DOC, RIF, rUSDT, SOV, DLLR, USDC`
    );
    return;
  }

  const validFrequencies = ['hourly', 'daily', 'weekly'];
  if (!validFrequencies.includes(params.frequency)) {
    await sendMessage(
      whatsappId,
      `Frecuencia "${params.frequency}" inválida. Usá: cada hora, diario o semanal.`
    );
    return;
  }

  const fromToken = (params.fromToken ?? 'DOC').toUpperCase();
  if (!SUPPORTED_TOKENS.includes(fromToken)) {
    await sendMessage(whatsappId, `Token fuente "${fromToken}" no soportado.`);
    return;
  }

  if (fromToken === normalizedToken) {
    await sendMessage(whatsappId, 'El token de origen y destino no pueden ser el mismo.');
    return;
  }

  const nextExecution = calcNextExecution(params.frequency);

  const order = createDCAOrder({
    userId: user.id,
    fromToken,
    toToken: normalizedToken,
    amount: params.amount,
    frequency: params.frequency,
    status: ORDER_STATUS.ACTIVE,
    nextExecution,
  });

  let quoteInfo = '';
  try {
    const quote = await getQuote(fromToken, normalizedToken, params.amount);
    quoteInfo = `\nCotización actual: ${params.amount} ${fromToken} ≈ ${quote} ${normalizedToken}`;
  } catch {
    quoteInfo = '\n(Cotización no disponible — se ejecutará a precio de mercado)';
  }

  const yieldTokens = getSupportedYieldTokens();
  const yieldNote = yieldTokens.includes(normalizedToken)
    ? ''
    : `\n\n⚠️ Nota: auto-yield no está disponible para ${normalizedToken}. Los tokens se acumularán en tu wallet.`;

  await sendMessage(
    whatsappId,
    `📊 Orden DCA creada!\n\n*Comprar ${params.amount} ${fromToken} → ${normalizedToken}*\nFrecuencia: ${FREQ_LABELS[params.frequency] ?? params.frequency}\nPróxima ejecución: ${formatDate(nextExecution)}\nOrden #${order.id}${quoteInfo}${yieldNote}\n\nEscribí *estado* para ver tus órdenes.`
  );
}

async function handleBalance(whatsappId: string, user: User): Promise<void> {
  if (!user.walletAddress) {
    await sendMessage(whatsappId, 'No tenés wallet. Escribí *start* para crear una.');
    return;
  }

  const [rbtcBalance, rusdtBalance, docBalance, rifBalance, idleYield] = await Promise.all([
    getWalletBalance(user.walletAddress),
    getTokenBalance(user.walletAddress, TOKEN_ADDRESSES.RUSDT),
    getTokenBalance(user.walletAddress, TOKEN_ADDRESSES.DOC),
    getTokenBalance(user.walletAddress, TOKEN_ADDRESSES.RIF),
    getIdleYieldBalance(user.walletAddress),
  ]);

  const idleDocValue = parseFloat(idleYield.docValue);
  const freeDoc = parseFloat(docBalance);
  const totalDoc = freeDoc + idleDocValue;
  const docLine = idleDocValue > 0
    ? `DOC: ${totalDoc.toFixed(2)} (generando ~5% anual en Tropykus)`
    : `DOC: ${freeDoc.toFixed(2)}`;

  await sendMessage(
    whatsappId,
    `💰 *Balance de tu Wallet*\n\n` +
      `Dirección: ${user.walletAddress}\n\n` +
      `RBTC: ${parseFloat(rbtcBalance).toFixed(8)}\n` +
      `rUSDT: ${parseFloat(rusdtBalance).toFixed(2)}\n` +
      `${docLine}\n` +
      `RIF: ${parseFloat(rifBalance).toFixed(4)}`
  );
}

async function handleStatus(whatsappId: string, user: User): Promise<void> {
  const orders = getActiveDCAOrders(user.id);
  const executions = getUserExecutions(user.id, 5);

  let msg = '*SatsPilot - Estado*\n\n';

  if (orders.length === 0) {
    msg += 'No tenés órdenes DCA activas.\n';
  } else {
    msg += `*Órdenes activas (${orders.length}):*\n`;
    for (const order of orders) {
      msg += `\n#${order.id}: ${order.amount} ${order.fromToken} → ${order.toToken}\n`;
      msg += `   ${FREQ_LABELS[order.frequency] ?? order.frequency} | Próxima: ${formatDate(order.nextExecution)}\n`;
    }
  }

  if (executions.length > 0) {
    msg += '\n*Ejecuciones recientes:*\n';
    for (const exec of executions) {
      const icon =
        exec.status === EXEC_STATUS.COMPLETED ? '✅' : exec.status === EXEC_STATUS.FAILED ? '❌' : '⏳';
      msg += `${icon} ${formatDate(exec.executedAt)} — ${exec.amountIn} entrada`;
      if (exec.amountOut) msg += ` → ${exec.amountOut} salida`;
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
    await sendMessage(whatsappId, 'No tenés órdenes DCA activas para pausar.');
    return;
  }

  let order: DCAOrder | undefined;
  if (params.orderId != null) {
    order = orders.find((o) => o.id === params.orderId);
    if (!order) {
      await sendMessage(whatsappId, `No se encontró orden activa con ID #${params.orderId}.`);
      return;
    }
  } else {
    order = orders[orders.length - 1];
  }

  updateOrderStatus(order.id, ORDER_STATUS.PAUSED);
  await sendMessage(
    whatsappId,
    `Orden #${order.id} pausada.\n${order.amount} ${order.fromToken} → ${order.toToken} (${FREQ_LABELS[order.frequency] ?? order.frequency})\n\nEscribí *reanudar* para reactivarla.`
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
    .where(and(eq(schema.dcaOrders.userId, user.id), eq(schema.dcaOrders.status, ORDER_STATUS.PAUSED)))
    .all();

  if (pausedOrders.length === 0) {
    await sendMessage(whatsappId, 'No tenés órdenes DCA pausadas.');
    return;
  }

  let order: DCAOrder | undefined;
  if (params.orderId != null) {
    order = pausedOrders.find((o) => o.id === params.orderId);
    if (!order) {
      await sendMessage(whatsappId, `No se encontró orden pausada con ID #${params.orderId}.`);
      return;
    }
  } else {
    order = pausedOrders[pausedOrders.length - 1];
  }

  updateOrderStatus(order.id, ORDER_STATUS.ACTIVE);
  updateOrderNextExecution(order.id, new Date().toISOString());

  await sendMessage(
    whatsappId,
    `Orden #${order.id} reanudada!\n${order.amount} ${order.fromToken} → ${order.toToken} (${FREQ_LABELS[order.frequency] ?? order.frequency})\n\nSe ejecutará en breve.`
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
    .where(and(eq(schema.dcaOrders.userId, user.id), ne(schema.dcaOrders.status, ORDER_STATUS.CANCELLED)))
    .all();

  if (cancellableOrders.length === 0) {
    await sendMessage(whatsappId, 'No tenés órdenes para cancelar.');
    return;
  }

  let order: DCAOrder | undefined;
  if (params.orderId != null) {
    order = cancellableOrders.find((o) => o.id === params.orderId);
    if (!order) {
      await sendMessage(whatsappId, `No se encontró orden cancelable con ID #${params.orderId}.`);
      return;
    }
  } else {
    order = cancellableOrders[cancellableOrders.length - 1];
  }

  updateOrderStatus(order.id, ORDER_STATUS.CANCELLED);
  await sendMessage(
    whatsappId,
    `Orden #${order.id} cancelada.\n${order.amount} ${order.fromToken} → ${order.toToken} (${FREQ_LABELS[order.frequency] ?? order.frequency})`
  );
}

async function handleDeposit(whatsappId: string, user: User): Promise<void> {
  if (!user.walletAddress) {
    await sendMessage(whatsappId, 'No tenés wallet. Escribí *start* para crear una.');
    return;
  }

  await sendMessage(
    whatsappId,
    `📥 *Dirección de depósito*\n\n*${user.walletAddress}*\n\nEnviá RBTC o rUSDT a esta dirección en la red Rootstock para fondear tus órdenes DCA.`
  );
}

async function handlePark(whatsappId: string, user: User): Promise<void> {
  if (!user.walletAddress) {
    await sendMessage(whatsappId, 'No tenés wallet. Escribí *start* para crear una.');
    return;
  }

  const wallet = getUserWallet(user.walletIndex);
  const docBalance = await getTokenBalance(user.walletAddress, TOKEN_ADDRESSES.DOC);
  const freeDoc = parseFloat(docBalance);

  if (freeDoc < 100) {
    await sendMessage(
      whatsappId,
      `Necesitás al menos 100 DOC libres para invertir en Tropykus.\nTu saldo DOC libre: ${freeDoc.toFixed(2)}`
    );
    return;
  }

  try {
    const result = await parkIdleFunds(wallet, docBalance);
    await sendMessage(
      whatsappId,
      `Tus ${freeDoc.toFixed(2)} DOC fueron depositados en Tropykus kDOC para generar ~5% anual.\nTx: https://explorer.rootstock.io/tx/${result.txHash}\n\nEscribí *balance* para ver tu saldo actualizado.`
    );
  } catch (err) {
    console.error('[commands] handlePark failed:', err);
    await sendMessage(
      whatsappId,
      `No se pudo depositar en Tropykus. Intentá de nuevo más tarde.`
    );
  }
}

async function handleHelp(whatsappId: string): Promise<void> {
  await sendMessage(
    whatsappId,
    `📋 *SatsPilot - Comandos*\n\n` +
      `*start* — Registrarte o ver tu wallet\n` +
      `*balance* — Ver saldos de tu wallet\n` +
      `*depositar* — Obtener tu dirección de depósito\n` +
      `*invertir* — Depositar tus DOC en Tropykus (~5% anual)\n` +
      `*estado* — Ver órdenes DCA activas e historial\n` +
      `*ayuda* — Mostrar este mensaje\n\n` +
      `*Crear DCA:*\n` +
      `"Comprar 10 RBTC diario"\n` +
      `"Invertir 5 DOC semanal en RBTC"\n` +
      `"DCA 1 rUSDT en RIF cada hora"\n\n` +
      `*Gestionar órdenes:*\n` +
      `"Pausar orden #3"\n` +
      `"Reanudar mi DCA"\n` +
      `"Cancelar orden #2"\n\n` +
      `DOC es la stablecoin por defecto (dólar on-chain respaldado por BTC).\n` +
      `Tus DOC libres pueden generar ~5% anual en Tropykus — escribí *invertir*.\n\n` +
      `Tokens soportados: RBTC, DOC, RIF, rUSDT, SOV, DLLR, USDC\n` +
      `Frecuencias: cada hora, diario, semanal`
  );
}

async function handleUnknown(whatsappId: string): Promise<void> {
  await sendMessage(
    whatsappId,
    `No entendí eso.\n\nPodés decirme algo como:\n• "Comprar 10 RBTC diario"\n• "Ver mi balance"\n• "Mostrar mis órdenes"\n\nEscribí *ayuda* para ver todos los comandos.`
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
    await sendMessage(whatsappId, 'Algo salió mal procesando tu mensaje. Intentá de nuevo.');
    return;
  }

  console.log(
    `[commands] whatsapp=${whatsappId} action=${intent.action} confidence=${intent.confidence}`
  );

  const user = getOrCreateUser(whatsappId);

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
      case 'park':
        await handlePark(whatsappId, user);
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
      'Algo salió mal. Intentá de nuevo o escribí *ayuda* para ver los comandos.'
    );
  }
}
