import {
  HDNodeWallet,
  Mnemonic,
  Wallet,
  JsonRpcProvider,
  Contract,
  formatEther,
  formatUnits,
} from 'ethers';
import { env } from '../config/env';
import { ERC20_ABI } from '../config/tokens';

let _provider: JsonRpcProvider | null = null;

export function getProvider(): JsonRpcProvider {
  if (!_provider) {
    _provider = new JsonRpcProvider(env.RSK_RPC_URL);
  }
  return _provider;
}

export function getUserWallet(walletIndex: number): Wallet {
  const mnemonicObj = Mnemonic.fromPhrase(env.MASTER_MNEMONIC);
  const hdNode = HDNodeWallet.fromMnemonic(mnemonicObj, `m/44'/137'/0'/0`);
  const derived = hdNode.deriveChild(walletIndex);
  return new Wallet(derived.privateKey, getProvider());
}

export async function getWalletBalance(address: string): Promise<string> {
  const provider = getProvider();
  const balance = await provider.getBalance(address);
  return formatEther(balance);
}

export async function getTokenBalance(
  walletAddress: string,
  tokenAddress: string
): Promise<string> {
  const provider = getProvider();
  const contract = new Contract(tokenAddress, ERC20_ABI, provider);
  const raw: bigint = await contract.balanceOf(walletAddress);
  return formatUnits(raw, 18);
}
