import { env } from './env';

const isTestnet = env.RSK_RPC_URL.includes('testnet');

// Addresses lowercased to avoid EIP-1191 checksum issues on RSK
export const TOKEN_ADDRESSES: Record<string, string> = isTestnet ? {
  // RSK Testnet (chainId 31)
  WRBTC: "0x09b6ca5e4496238a1f176aea6bb607db96c2286e", // testnet WRBTC
  DOC: "0xcb46c0ddc60d18efeb0e586c17af6ea36452dae0",
  RIF: "0x19f64674d8a5b4e652319f5e239efd3bc969a1fe", // testnet RIF
} : {
  // RSK Mainnet (chainId 30)
  WRBTC: "0x542fda317318ebf1d3deaf76e0b632741a7e677d",
  RUSDT: "0xef213441a85df4d7acbdae0cf78004e1e486bb96",
  DOC: "0xe700691da7b9851f2f35f8b8182c69c53ccad9db",
  RIF: "0x2acc95758f8b5f583470ba265eb685a8f45fc9d5",
  SOV: "0xefc78fc7d48b64958315949279ba181c2114abbd",
  DLLR: "0xc1411567d2670e24d9c4daaa7cda95686e1250aa",
};

export const MOC_ADDRESS = isTestnet
  ? "0x2820f6d4d199b8d8838a4b26f9917754b86a0c1f"
  : "0xf773b590af754d597770937fa8ea7abdf2668370";

export const CONTRACTS: Record<string, string> = isTestnet ? {
  // No Uniswap V3 on testnet
} : {
  SwapRouter02: "0x0b14ff67f0014046b4b99057aec4509640b3947a",
  QuoterV2: "0xb51727c996c68e60f598a923a5006853cd2feb31",
  V3Factory: "0xaf37ec98a00fd63689cf3060bf3b6784e00cad82",
};

export const YIELD_CONTRACTS: Record<string, string> = isTestnet ? {
  // Tropykus testnet
  kDOC: "0x71e6b108d823c2786f8ef63a3e0589576b4f3914",
  kRBTC: "0x5b35072cd6110606c8421e013304110fa04a32a3",
} : {
  iRBTC: "0xa9dcdc63eabb8a2b6f39d7ff9429d88340044a7a",
  iDOC: "0xd8d25f03ebba94e15df2ed4d6d38276b595593c1",
  iDLLR: "0x077fcb01cab070a30bc14b44559c96f529ee017f",
};

export const IDLE_YIELD_CONTRACTS: Record<string, string> = isTestnet ? {
  kDOC: "0x71e6b108d823c2786f8ef63a3e0589576b4f3914",
} : {
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
