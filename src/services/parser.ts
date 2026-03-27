import { env } from '../config/env';

export type ParsedIntent = {
  action: 'start' | 'dca' | 'balance' | 'status' | 'pause' | 'resume' | 'cancel' | 'help' | 'deposit' | 'park' | 'withdraw' | 'unknown';
  params: {
    token?: string;
    fromToken?: string;
    amount?: string;
    frequency?: string;
    orderId?: number;
    toAddress?: string;
  };
  confidence: number;
  rawResponse?: string;
};

const SYSTEM_PROMPT = `Sos un parser de intenciones para SatsPilot, un bot de WhatsApp que hace DCA (Dollar-Cost Averaging) en la blockchain Rootstock (RSK).

El usuario habla en español (argentino). Parseá el mensaje y respondé ÚNICAMENTE con un JSON válido — sin markdown, sin explicación, sin texto extra.

Tokens soportados: RBTC, DOC, RIF, rUSDT, SOV, DLLR
Token fuente por defecto para DCA: DOC
Frecuencias soportadas: hourly (cada hora), daily (diario), weekly (semanal)

Acciones:
- "start": el usuario quiere registrarse, ver su wallet, o saluda (hola, buenas, etc)
- "dca": quiere configurar una compra recurrente. Extraer: token (destino), amount (monto por ejecución), frequency, fromToken (fuente, default DOC)
- "balance": quiere ver los saldos de su wallet
- "status": quiere ver sus órdenes DCA activas y el historial
- "pause": quiere pausar una orden DCA. Extraer orderId si lo menciona.
- "resume": quiere reanudar una orden pausada. Extraer orderId si lo menciona.
- "cancel": quiere cancelar/eliminar una orden. Extraer orderId si lo menciona.
- "deposit": quiere su dirección de wallet para depositar fondos
- "park": quiere depositar sus DOC libres en Tropykus para generar yield (~5% anual). Palabras clave: invertir mis DOC, parquear, park
- "withdraw": quiere retirar tokens de su wallet a una dirección externa. Extraer: amount, token, toAddress (dirección 0x). Palabras clave: retirar, withdraw, sacar
- "help": quiere ayuda, lista de comandos, o qué puede hacer el bot
- "unknown": el mensaje no coincide con ninguna acción

Esquema JSON:
{
  "action": "start" | "dca" | "balance" | "status" | "pause" | "resume" | "cancel" | "help" | "deposit" | "park" | "withdraw" | "unknown",
  "params": {
    "token": string | undefined,
    "fromToken": string | undefined,
    "amount": string | undefined,
    "frequency": string | undefined,
    "orderId": number | undefined,
    "toAddress": string | undefined
  },
  "confidence": number
}

Ejemplos:
- "comprar 10 RBTC diario" → {"action":"dca","params":{"token":"RBTC","amount":"10","frequency":"daily","fromToken":"DOC"},"confidence":0.98}
- "quiero invertir 5 dolares en bitcoin cada semana" → {"action":"dca","params":{"token":"RBTC","amount":"5","frequency":"weekly","fromToken":"DOC"},"confidence":0.95}
- "invertir mis DOC" → {"action":"park","params":{},"confidence":0.97}
- "parquear" → {"action":"park","params":{},"confidence":0.98}
- "ver mi balance" → {"action":"balance","params":{},"confidence":0.99}
- "pausar orden 3" → {"action":"pause","params":{"orderId":3},"confidence":0.97}
- "retirar 0.5 RBTC a 0x1234567890abcdef1234567890abcdef12345678" → {"action":"withdraw","params":{"amount":"0.5","token":"RBTC","toAddress":"0x1234567890abcdef1234567890abcdef12345678"},"confidence":0.98}
- "hola" → {"action":"start","params":{},"confidence":0.85}
- "como esta el clima?" → {"action":"unknown","params":{},"confidence":0.95}`;

// Regex local para comandos comunes (sin llamada a API)
function tryLocalParse(text: string): ParsedIntent | null {
  const t = text.trim().toLowerCase();

  // Start / saludo
  if (/^(hi|hello|hey|start|hola|holis|buenas|que onda|ey|empezar)$/i.test(t)) {
    return { action: 'start', params: {}, confidence: 1 };
  }
  // Help / ayuda
  if (/^(help|ayuda|commands|comandos|menu|que puedo hacer|\?)$/i.test(t)) {
    return { action: 'help', params: {}, confidence: 1 };
  }
  // Balance
  if (/^(balance|balances|saldo|saldos|ver.*(balance|saldo)|mi balance|mi saldo|wallet|check.*(balance|wallet))$/i.test(t)) {
    return { action: 'balance', params: {}, confidence: 1 };
  }
  // Status / estado
  if (/^(status|estado|ordenes|orders|mis ordenes|my orders|show.*orders|ver.*ordenes)$/i.test(t)) {
    return { action: 'status', params: {}, confidence: 1 };
  }
  // Deposit / depositar
  if (/^(deposit|depositar|address|direccion|mi direccion|wallet address|mi wallet)$/i.test(t)) {
    return { action: 'deposit', params: {}, confidence: 1 };
  }
  // Park / invertir DOC en yield (but NOT "invertir 5 DOC semanal" which is DCA)
  if (/^(parquear|park)(\s.*)?$/i.test(t) || /^invertir(\s+(mis\s+)?doc)?$/i.test(t)) {
    return { action: 'park', params: {}, confidence: 1 };
  }

  // Withdraw: "retirar 0.5 RBTC a 0x..." / "withdraw 10 DOC to 0x..."
  const withdrawMatch = t.match(
    /^(?:retirar|withdraw|sacar)\s+([\d.]+)\s*(\w+)\s+(?:a|to)\s+(0x[a-fA-F0-9]{40})$/i
  );
  if (withdrawMatch) {
    return {
      action: 'withdraw',
      params: {
        amount: withdrawMatch[1],
        token: withdrawMatch[2].toUpperCase(),
        toAddress: withdrawMatch[3],
      },
      confidence: 0.95,
    };
  }

  // DCA: "comprar 10 RBTC diario" / "buy 10 RBTC daily" / "invertir 5 DOC semanal"
  const dcaMatch = t.match(
    /(?:buy|dca|stack|invest|comprar|invertir|stackear)\s+([\d.]+)\s*(?:de\s+|of\s+|en\s+)?(\w+)\s*(hourly|daily|weekly|diario|semanal|cada\s*hora|cada\s*dia|cada\s*semana|every\s*(?:hour|day|week))/i
  );
  if (dcaMatch) {
    let freq = dcaMatch[3].toLowerCase();
    if (freq === 'diario' || freq === 'cada dia') freq = 'daily';
    else if (freq === 'semanal' || freq === 'cada semana') freq = 'weekly';
    else if (freq === 'cada hora') freq = 'hourly';
    else freq = freq.replace(/every\s*/, '').replace('hour', 'hourly').replace('day', 'daily').replace('week', 'weekly');
    return {
      action: 'dca',
      params: {
        amount: dcaMatch[1],
        token: dcaMatch[2].toUpperCase(),
        frequency: freq,
        fromToken: 'DOC',
      },
      confidence: 0.95,
    };
  }

  // Pause / pausar
  const pauseMatch = t.match(/^(?:pause|pausar)(?:\s+(?:orden\s*|order\s*)?#?(\d+))?$/i);
  if (pauseMatch) {
    return { action: 'pause', params: { orderId: pauseMatch[1] ? parseInt(pauseMatch[1]) : undefined }, confidence: 1 };
  }
  // Resume / reanudar
  const resumeMatch = t.match(/^(?:resume|reanudar|continuar)(?:\s+(?:orden\s*|order\s*)?#?(\d+))?$/i);
  if (resumeMatch) {
    return { action: 'resume', params: { orderId: resumeMatch[1] ? parseInt(resumeMatch[1]) : undefined }, confidence: 1 };
  }
  // Cancel / cancelar
  const cancelMatch = t.match(/^(?:cancel|cancelar|stop|parar|eliminar)(?:\s+(?:orden\s*|order\s*)?#?(\d+))?$/i);
  if (cancelMatch) {
    return { action: 'cancel', params: { orderId: cancelMatch[1] ? parseInt(cancelMatch[1]) : undefined }, confidence: 1 };
  }

  return null;
}

export async function parseMessage(messageText: string): Promise<ParsedIntent> {
  const local = tryLocalParse(messageText);
  if (local) {
    console.log(`[parser] Local match: "${messageText}" → ${local.action}`);
    return local;
  }

  const openRouterKey = env.OPENROUTER_API_KEY;
  if (!openRouterKey) {
    console.log(`[parser] No OPENROUTER_API_KEY, returning unknown for: "${messageText}"`);
    return { action: 'unknown', params: {}, confidence: 0 };
  }

  let raw = '';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${openRouterKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-3.5-haiku',
        max_tokens: 256,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: messageText },
        ],
      }),
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenRouter ${response.status}: ${errText}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };

    raw = data.choices?.[0]?.message?.content?.trim() ?? '';

    const parsed = JSON.parse(raw);
    return {
      action: parsed.action ?? 'unknown',
      params: {
        token: parsed.params?.token,
        fromToken: parsed.params?.fromToken,
        amount: parsed.params?.amount,
        frequency: parsed.params?.frequency,
        orderId: typeof parsed.params?.orderId === 'number' ? parsed.params.orderId : undefined,
        toAddress: typeof parsed.params?.toAddress === 'string' ? parsed.params.toAddress : undefined,
      },
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      rawResponse: raw,
    };
  } catch (err) {
    console.error('[parser] Failed to parse intent:', err, 'raw:', raw);
    return {
      action: 'unknown',
      params: {},
      confidence: 0,
      rawResponse: raw,
    };
  }
}
