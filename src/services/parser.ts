import Anthropic from '@anthropic-ai/sdk';

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

const client = new Anthropic();

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

export async function parseMessage(messageText: string): Promise<ParsedIntent> {
  let raw = '';
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: messageText }],
    });

    raw = response.content[0].type === 'text' ? response.content[0].text.trim() : '';

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
