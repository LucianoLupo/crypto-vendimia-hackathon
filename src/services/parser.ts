export type ParsedIntent = {
  action: 'start' | 'dca' | 'balance' | 'status' | 'pause' | 'resume' | 'cancel' | 'help' | 'deposit' | 'unknown';
  params: {
    token?: string;
    fromToken?: string;
    amount?: string;
    frequency?: string;
    orderId?: number;
  };
  confidence: number;
  rawResponse?: string;
};

const SYSTEM_PROMPT = `You are an intent parser for AutoStack, a WhatsApp DCA (Dollar-Cost Averaging) bot on the Rootstock (RSK) blockchain.

Parse the user message and respond ONLY with a valid JSON object — no markdown, no explanation, no extra text.

Supported tokens: RBTC, DOC, RIF, rUSDT, SOV, DLLR, USDC
Default source token for DCA: rUSDT
Supported frequencies: hourly, daily, weekly

Actions:
- "start": user wants to register, see their wallet, or says hi/hello
- "dca": user wants to set up a recurring buy. Extract: token (target), amount (per execution), frequency, fromToken (source, default rUSDT)
- "balance": user wants to check their wallet balances
- "status": user wants to see active DCA orders and execution history
- "pause": user wants to pause a DCA order. Extract orderId if mentioned.
- "resume": user wants to resume a paused order. Extract orderId if mentioned.
- "cancel": user wants to cancel/stop/delete an order. Extract orderId if mentioned.
- "deposit": user wants their wallet address to deposit funds
- "help": user wants help, list of commands, or what can the bot do
- "unknown": message doesn't match any action above

JSON schema:
{
  "action": "start" | "dca" | "balance" | "status" | "pause" | "resume" | "cancel" | "help" | "deposit" | "unknown",
  "params": {
    "token": string | undefined,
    "fromToken": string | undefined,
    "amount": string | undefined,
    "frequency": string | undefined,
    "orderId": number | undefined
  },
  "confidence": number
}

Examples:
- "buy 10 RBTC daily" → {"action":"dca","params":{"token":"RBTC","amount":"10","frequency":"daily","fromToken":"rUSDT"},"confidence":0.98}
- "check balance" → {"action":"balance","params":{},"confidence":0.99}
- "pause order 3" → {"action":"pause","params":{"orderId":3},"confidence":0.97}
- "hello" → {"action":"start","params":{},"confidence":0.85}
- "what's the weather?" → {"action":"unknown","params":{},"confidence":0.95}`;

// Try regex-based parsing first for common commands (no API call needed)
function tryLocalParse(text: string): ParsedIntent | null {
  const t = text.trim().toLowerCase();

  if (/^(hi|hello|hey|start|hola|holis)$/i.test(t)) {
    return { action: 'start', params: {}, confidence: 1 };
  }
  if (/^(help|commands|menu|\?)$/i.test(t)) {
    return { action: 'help', params: {}, confidence: 1 };
  }
  if (/^(balance|balances|check.*(balance|wallet)|my balance|wallet)$/i.test(t)) {
    return { action: 'balance', params: {}, confidence: 1 };
  }
  if (/^(status|orders|my orders|show.*orders|mis ordenes)$/i.test(t)) {
    return { action: 'status', params: {}, confidence: 1 };
  }
  if (/^(deposit|address|my address|wallet address)$/i.test(t)) {
    return { action: 'deposit', params: {}, confidence: 1 };
  }

  // DCA pattern: "buy 10 RBTC daily" / "dca 5 DOC weekly" / "stack 20 RIF hourly"
  const dcaMatch = t.match(
    /(?:buy|dca|stack|invest|comprar)\s+([\d.]+)\s*(?:of\s+)?(\w+)\s*(hourly|daily|weekly|every\s*(?:hour|day|week))/i
  );
  if (dcaMatch) {
    const freq = dcaMatch[3].replace(/every\s*/, '').replace('hour', 'hourly').replace('day', 'daily').replace('week', 'weekly');
    return {
      action: 'dca',
      params: {
        amount: dcaMatch[1],
        token: dcaMatch[2].toUpperCase(),
        frequency: freq,
        fromToken: 'RUSDT',
      },
      confidence: 0.95,
    };
  }

  // Pause/resume/cancel with optional order ID
  const pauseMatch = t.match(/^pause(?:\s+(?:order\s*)?#?(\d+))?$/i);
  if (pauseMatch) {
    return { action: 'pause', params: { orderId: pauseMatch[1] ? parseInt(pauseMatch[1]) : undefined }, confidence: 1 };
  }
  const resumeMatch = t.match(/^resume(?:\s+(?:order\s*)?#?(\d+))?$/i);
  if (resumeMatch) {
    return { action: 'resume', params: { orderId: resumeMatch[1] ? parseInt(resumeMatch[1]) : undefined }, confidence: 1 };
  }
  const cancelMatch = t.match(/^(?:cancel|stop)(?:\s+(?:order\s*)?#?(\d+))?$/i);
  if (cancelMatch) {
    return { action: 'cancel', params: { orderId: cancelMatch[1] ? parseInt(cancelMatch[1]) : undefined }, confidence: 1 };
  }

  return null; // Couldn't parse locally — fall through to LLM
}

export async function parseMessage(messageText: string): Promise<ParsedIntent> {
  // Try local parsing first (fast, free)
  const local = tryLocalParse(messageText);
  if (local) {
    console.log(`[parser] Local match: "${messageText}" → ${local.action}`);
    return local;
  }

  // Fall back to LLM via OpenRouter
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (!openRouterKey) {
    console.log(`[parser] No OPENROUTER_API_KEY, returning unknown for: "${messageText}"`);
    return { action: 'unknown', params: {}, confidence: 0 };
  }

  let raw = '';
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openRouterKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4',
        max_tokens: 256,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: messageText },
        ],
      }),
    });

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
