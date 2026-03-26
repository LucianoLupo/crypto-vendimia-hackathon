const COINGECKO_IDS: Record<string, string> = {
  RBTC: 'rootstock',
  DOC: 'dollar-on-chain',
  RIF: 'rif-token',
  SOV: 'sovryn',
};

export async function fetchPrice(tokenSymbol: string): Promise<number> {
  const id = COINGECKO_IDS[tokenSymbol.toUpperCase()];
  if (!id) return 0;

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`
    );
    if (!res.ok) return 0;
    const data = await res.json() as Record<string, { usd: number }>;
    return data[id]?.usd ?? 0;
  } catch {
    return 0;
  }
}

export async function fetch7DaySMA(tokenSymbol: string): Promise<number> {
  const id = COINGECKO_IDS[tokenSymbol.toUpperCase()];
  if (!id) return 0;

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=7`
    );
    if (!res.ok) return 0;
    const data = await res.json() as { prices: [number, number][] };
    const prices = data.prices;
    if (!prices || prices.length === 0) return 0;
    const sum = prices.reduce((acc, [, price]) => acc + price, 0);
    return sum / prices.length;
  } catch {
    return 0;
  }
}

export async function calculateSmartAmount(
  baseAmount: string,
  tokenSymbol: string
): Promise<{
  adjustedAmount: string;
  reason: string;
  priceData: { currentPrice: number; sma7d: number; deviation: number };
}> {
  const [currentPrice, sma7d] = await Promise.all([
    fetchPrice(tokenSymbol),
    fetch7DaySMA(tokenSymbol),
  ]);

  if (currentPrice === 0 || sma7d === 0) {
    return {
      adjustedAmount: baseAmount,
      reason: 'Price data unavailable, using base amount',
      priceData: { currentPrice, sma7d, deviation: 0 },
    };
  }

  const deviation = (currentPrice - sma7d) / sma7d;
  const base = parseFloat(baseAmount);

  let adjustedAmount: string;
  let reason: string;

  if (deviation < -0.05) {
    adjustedAmount = (base * 1.5).toFixed(6);
    reason = `Price is ${Math.abs(deviation * 100).toFixed(1)}% below 7-day average — buying 50% more (dip buying)`;
  } else if (deviation > 0.05) {
    adjustedAmount = (base * 0.5).toFixed(6);
    reason = `Price is ${(deviation * 100).toFixed(1)}% above 7-day average — buying 50% less`;
  } else {
    adjustedAmount = baseAmount;
    reason = 'Price is within normal range';
  }

  return {
    adjustedAmount,
    reason,
    priceData: { currentPrice, sma7d, deviation },
  };
}

export async function formatPriceReport(tokenSymbol: string): Promise<string> {
  const [currentPrice, sma7d] = await Promise.all([
    fetchPrice(tokenSymbol),
    fetch7DaySMA(tokenSymbol),
  ]);

  const deviation = sma7d !== 0 ? (currentPrice - sma7d) / sma7d : 0;
  const deviationPct = deviation * 100;

  let adjustment: string;
  if (currentPrice === 0 || sma7d === 0) {
    adjustment = 'unavailable';
  } else if (deviation < -0.05) {
    adjustment = '+50%';
  } else if (deviation > 0.05) {
    adjustment = '-50%';
  } else {
    adjustment = 'none';
  }

  const sign = deviationPct >= 0 ? '+' : '';

  return [
    `${tokenSymbol.toUpperCase()} Price Report:`,
    `Current: $${currentPrice.toFixed(2)}`,
    `7-Day Average: $${sma7d.toFixed(2)}`,
    `Deviation: ${sign}${deviationPct.toFixed(1)}%`,
    `DCA Adjustment: ${adjustment}`,
  ].join('\n');
}
