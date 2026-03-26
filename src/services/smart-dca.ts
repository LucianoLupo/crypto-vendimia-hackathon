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
      reason: 'Datos de precio no disponibles, usando monto base',
      priceData: { currentPrice, sma7d, deviation: 0 },
    };
  }

  const deviation = (currentPrice - sma7d) / sma7d;
  const base = parseFloat(baseAmount);

  let adjustedAmount: string;
  let reason: string;

  if (deviation < -0.05) {
    adjustedAmount = (base * 1.5).toFixed(6);
    reason = `Precio ${Math.abs(deviation * 100).toFixed(1)}% debajo del promedio de 7 dias — comprando 50% mas (comprando la baja)`;
  } else if (deviation > 0.05) {
    adjustedAmount = (base * 0.5).toFixed(6);
    reason = `Precio ${(deviation * 100).toFixed(1)}% arriba del promedio de 7 dias — comprando 50% menos`;
  } else {
    adjustedAmount = baseAmount;
    reason = 'Precio dentro del rango normal';
  }

  return {
    adjustedAmount,
    reason,
    priceData: { currentPrice, sma7d, deviation },
  };
}
