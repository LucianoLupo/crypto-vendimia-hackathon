// Addresses lowercased to avoid EIP-1191 checksum issues on RSK (chainId 30)
export const TOKEN_ADDRESSES: Record<string, string> = {
  WRBTC: "0x542fda317318ebf1d3deaf76e0b632741a7e677d",
  RUSDT: "0xef213441a85df4d7acbdae0cf78004e1e486bb96",
  DOC: "0xe700691da7b9851f2f35f8b8182c69c53ccad9db",
  RIF: "0x2acc95758f8b5f583470ba265eb685a8f45fc9d5",
  SOV: "0xefc78fc7d48b64958315949279ba181c2114abbd",
  DLLR: "0xc1411567d2670e24d9c4daaa7cda95686e1250aa",
  // USDC removed — no contract deployed at the listed address on RSK mainnet
};

export const CONTRACTS: Record<string, string> = {
  SwapRouter02: "0x0b14ff67f0014046b4b99057aec4509640b3947a",
  QuoterV2: "0xb51727c996c68e60f598a923a5006853cd2feb31",
  V3Factory: "0xaf37ec98a00fd63689cf3060bf3b6784e00cad82",
};

export const YIELD_CONTRACTS: Record<string, string> = {
  iRBTC: "0xa9dcdc63eabb8a2b6f39d7ff9429d88340044a7a",
  iDOC: "0xd8d25f03ebba94e15df2ed4d6d38276b595593c1",
  iDLLR: "0x077fcb01cab070a30bc14b44559c96f529ee017f",
};

export const IDLE_YIELD_CONTRACTS: Record<string, string> = {
  kDOC: "0x544eb90e766b405134b3b3f62b6b4c23fcd5fda2",
};

export const TOKEN_DECIMALS: Record<string, number> = {
  WRBTC: 18,
  RUSDT: 18,
  DOC: 18,
  RIF: 18,
  SOV: 18,
  DLLR: 18,
};

export const DEFAULT_FEE_TIER = 3000;

export const DEFAULT_SLIPPAGE = 100; // 1% = 100 basis points

export const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

export function tokenBySymbol(symbol: string): string | undefined {
  const normalized = symbol.toUpperCase();
  const entry = Object.entries(TOKEN_ADDRESSES).find(
    ([key]) => key.toUpperCase() === normalized
  );
  return entry?.[1];
}
