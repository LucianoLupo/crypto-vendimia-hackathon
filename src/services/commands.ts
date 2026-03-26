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
const MAX_DCA_AMOUNT = 10000;

const FREQ_LABELS: Record<string, string> = {
  hourly: 'cada hora',
  daily: 'diariamente',
  weekly: 'semanalmente',
};

function calcNextExecution(frequency: string): string {
  const now = new Date();
  if (frequency === 'hourly') now.setHours(now.getHours() + 1);
  else if (frequency === 'daily') now.setDate(now.getDate() + 1);
  else if (frequency === 'weekly') now.setDate(now.getDate() + 7);
  return now.toISOString();
}

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
      `Bienvenido a *SatsPilot*! Tu copiloto cripto en WhatsApp.\n\nTu wallet en Rootstock fue creada:\n*${address}*\n\nEnvia rUSDT o RBTC a esta direccion para empezar a invertir con DCA.\n\nEscribi *ayuda* para ver todos los comandos.`
    );
  } else {
    const balance = await getWalletBalance(user.walletAddress);
    await sendMessage(
      whatsappId,
      `Hola de nuevo!\n\nTu wallet: *${user.walletAddress}*\nBalance RBTC: ${parseFloat(balance).toFixed(8)}\n\nEscribi *estado* para ver tus ordenes o *ayuda* para los comandos.`
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
      'Para crear una orden DCA necesito:\n• *Token* a comprar (ej: RBTC, DOC, RIF)\n• *Monto* por ejecucion (en rUSDT)\n• *Frecuencia* (cada hora, diario, semanal)\n\nEjemplo: "Comprar 10 RBTC diario"'
    );
    return;
  }

  const amountNum = parseFloat(params.amount);
  if (isNaN(amountNum) || amountNum <= 0) {
    await sendMessage(whatsappId, 'Monto invalido. Ingresa un numero positivo.');
    return;
  }
  if (amountNum > MAX_DCA_AMOUNT) {
    await sendMessage(whatsappId, `Monto muy grande. Maximo por ejecucion: ${MAX_DCA_AMOUNT}.`);
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
      `Frecuencia "${params.frequency}" invalida. Usa: hourly, daily o weekly.`
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

  let quoteInfo = '';
  try {
    const quote = await getQuote(fromToken, normalizedToken, params.amount);
    quoteInfo = `\nCotizacion actual: ${params.amount} ${fromToken} ≈ ${quote} ${normalizedToken}`;
  } catch {
    quoteInfo = '\n(Cotizacion no disponible — se ejecutara a precio de mercado)';
  }

  await sendMessage(
    whatsappId,
    `Orden DCA creada!\n\n*Comprar ${params.amount} ${fromToken} → ${normalizedToken}*\nFrecuencia: ${FREQ_LABELS[params.frequency] ?? params.frequency}\nProxima ejecucion: ${formatDate(nextExecution)}\nOrden #${order.id}${quoteInfo}\n\nEscribi *estado* para ver tus ordenes.`
  );
}

async function handleBalance(whatsappId: string, user: User): Promise<void> {
  if (!user.walletAddress) {
    await sendMessage(whatsappId, 'No tenes wallet. Escribi *start* para crear una.');
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
    `*Balance de tu Wallet*\n\n` +
      `Direccion: ${user.walletAddress}\n\n` +
      `RBTC: ${parseFloat(rbtcBalance).toFixed(8)}\n` +
      `rUSDT: ${parseFloat(rusdtBalance).toFixed(2)}\n` +
      `DOC: ${parseFloat(docBalance).toFixed(2)}\n` +
      `RIF: ${parseFloat(rifBalance).toFixed(4)}`
  );
}

async function handleStatus(whatsappId: string, user: User): Promise<void> {
  const orders = getActiveDCAOrders(user.id);
  const executions = getUserExecutions(user.id, 5);

  let msg = '*SatsPilot - Estado*\n\n';

  if (orders.length === 0) {
    msg += 'No tenes ordenes DCA activas.\n';
  } else {
    msg += `*Ordenes activas (${orders.length}):*\n`;
    for (const order of orders) {
      msg += `\n#${order.id}: ${order.amount} ${order.fromToken} → ${order.toToken}\n`;
      msg += `   ${FREQ_LABELS[order.frequency] ?? order.frequency} | Proxima: ${formatDate(order.nextExecution)}\n`;
    }
  }

  if (executions.length > 0) {
    msg += '\n*Ejecuciones recientes:*\n';
    for (const exec of executions) {
      const icon =
        exec.status === 'completed' ? 'ok' : exec.status === 'failed' ? 'error' : 'pendiente';
      msg += `[${icon}] ${formatDate(exec.executedAt)} — ${exec.amountIn} entrada`;
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
    await sendMessage(whatsappId, 'No tenes ordenes DCA activas para pausar.');
    return;
  }

  let order: DCAOrder | undefined;
  if (params.orderId != null) {
    order = orders.find((o) => o.id === params.orderId);
    if (!order) {
      await sendMessage(whatsappId, `No se encontro orden activa con ID #${params.orderId}.`);
      return;
    }
  } else {
    order = orders[orders.length - 1];
  }

  updateOrderStatus(order.id, 'paused');
  await sendMessage(
    whatsappId,
    `Orden #${order.id} pausada.\n${order.amount} ${order.fromToken} → ${order.toToken} (${FREQ_LABELS[order.frequency] ?? order.frequency})\n\nEscribi *reanudar* para reactivarla.`
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
    await sendMessage(whatsappId, 'No tenes ordenes DCA pausadas.');
    return;
  }

  let order: DCAOrder | undefined;
  if (params.orderId != null) {
    order = pausedOrders.find((o) => o.id === params.orderId);
    if (!order) {
      await sendMessage(whatsappId, `No se encontro orden pausada con ID #${params.orderId}.`);
      return;
    }
  } else {
    order = pausedOrders[pausedOrders.length - 1];
  }

  updateOrderStatus(order.id, 'active');
  updateOrderNextExecution(order.id, new Date().toISOString());

  await sendMessage(
    whatsappId,
    `Orden #${order.id} reanudada!\n${order.amount} ${order.fromToken} → ${order.toToken} (${FREQ_LABELS[order.frequency] ?? order.frequency})\n\nSe ejecutara en breve.`
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
    await sendMessage(whatsappId, 'No tenes ordenes para cancelar.');
    return;
  }

  let order: DCAOrder | undefined;
  if (params.orderId != null) {
    order = cancellableOrders.find((o) => o.id === params.orderId);
    if (!order) {
      await sendMessage(whatsappId, `No se encontro orden cancelable con ID #${params.orderId}.`);
      return;
    }
  } else {
    order = cancellableOrders[cancellableOrders.length - 1];
  }

  updateOrderStatus(order.id, 'cancelled');
  await sendMessage(
    whatsappId,
    `Orden #${order.id} cancelada.\n${order.amount} ${order.fromToken} → ${order.toToken} (${FREQ_LABELS[order.frequency] ?? order.frequency})`
  );
}

async function handleDeposit(whatsappId: string, user: User): Promise<void> {
  if (!user.walletAddress) {
    await sendMessage(whatsappId, 'No tenes wallet. Escribi *start* para crear una.');
    return;
  }

  await sendMessage(
    whatsappId,
    `*Direccion de deposito*\n\n*${user.walletAddress}*\n\nEnvia RBTC o rUSDT a esta direccion en la red Rootstock para fondear tus ordenes DCA.`
  );
}

async function handleHelp(whatsappId: string): Promise<void> {
  await sendMessage(
    whatsappId,
    `*SatsPilot - Comandos*\n\n` +
      `*start* — Registrarte o ver tu wallet\n` +
      `*balance* — Ver saldos de tu wallet\n` +
      `*depositar* — Obtener tu direccion de deposito\n` +
      `*estado* — Ver ordenes DCA activas e historial\n` +
      `*ayuda* — Mostrar este mensaje\n\n` +
      `*Crear DCA:*\n` +
      `"Comprar 10 RBTC diario"\n` +
      `"Invertir 5 DOC semanal"\n` +
      `"DCA 1 rUSDT en RIF cada hora"\n\n` +
      `*Gestionar ordenes:*\n` +
      `"Pausar orden #3"\n` +
      `"Reanudar mi DCA"\n` +
      `"Cancelar orden #2"\n\n` +
      `Tokens soportados: RBTC, DOC, RIF, rUSDT, SOV, DLLR, USDC\n` +
      `Frecuencias: cada hora, diario, semanal`
  );
}

async function handleUnknown(whatsappId: string): Promise<void> {
  await sendMessage(
    whatsappId,
    `No entendi eso.\n\nPodes decirme algo como:\n• "Comprar 10 RBTC diario"\n• "Ver mi balance"\n• "Mostrar mis ordenes"\n\nEscribi *ayuda* para ver todos los comandos.`
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
    await sendMessage(whatsappId, 'Algo salio mal procesando tu mensaje. Intenta de nuevo.');
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
      'Algo salio mal. Intenta de nuevo o escribi *ayuda* para ver los comandos.'
    );
  }
}
