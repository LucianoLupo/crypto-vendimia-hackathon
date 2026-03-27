#!/usr/bin/env node
/**
 * Tries multiple approaches to get testnet stablecoins on RSK testnet.
 * Run: node scripts/get-testnet-tokens.mjs
 */

import { JsonRpcProvider, Contract, Wallet, HDNodeWallet, Mnemonic, formatUnits, parseUnits, formatEther, parseEther } from 'ethers';

const RPC = 'https://public-node.testnet.rsk.co';
const p = new JsonRpcProvider(RPC, 31, { staticNetwork: true });
const mnemonic = Mnemonic.fromPhrase('lunch capital risk point slight museum lady any pass unit tent level');
const hdNode = HDNodeWallet.fromMnemonic(mnemonic, "m/44'/137'/0'/0");
const wallet = new Wallet(hdNode.deriveChild(0).privateKey, p);

const TOKENS = {
  DOC:  '0xcb46c0ddc60d18efeb0e586c17af6ea36452dae0',
  USDT: '0x4d5a316d23ebe168d8f887b4447bf8dbfa4901cc',
  RDOC: '0xc3de9f38581f83e281f260d0ddbac0e102ff9f8',
  XUSD: '0xa9262cc3fb54ea55b1b0af00efca9416b8d59570',
};

const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)'];
const MINT_ABIS = [
  'function mint(address to, uint256 amount) external',
  'function mint(uint256 amount) external',
  'function issue(uint256 amount) external',
  'function faucet(uint256 amount) external',
];

async function main() {
  console.log('Wallet:', wallet.address);
  console.log('tRBTC:', formatEther(await p.getBalance(wallet.address)));
  console.log('');

  // 1. Check all balances first
  console.log('=== Current Balances ===');
  for (const [name, addr] of Object.entries(TOKENS)) {
    try {
      const t = new Contract(addr, ERC20, p);
      const [bal, dec] = await Promise.all([t.balanceOf(wallet.address), t.decimals()]);
      console.log(`${name}: ${formatUnits(bal, dec)}`);
      if (parseFloat(formatUnits(bal, dec)) > 0) {
        console.log(`  ✅ Already have ${name}!`);
      }
    } catch (e) {
      console.log(`${name}: error - ${e.message.slice(0, 60)}`);
    }
  }

  // 2. Try minting USDT (Sovryn test token)
  console.log('\n=== Trying to mint testnet USDT ===');
  try {
    const usdt = new Contract(TOKENS.USDT, [...ERC20, ...MINT_ABIS], wallet);
    const dec = await usdt.decimals();

    try {
      const tx = await usdt['mint(address,uint256)'](wallet.address, parseUnits('1000', dec), { gasLimit: 200000 });
      const r = await tx.wait();
      console.log(r.status === 1 ? '✅ USDT mint(addr,amt) SUCCESS!' : '❌ Reverted');
      console.log('USDT balance:', formatUnits(await usdt.balanceOf(wallet.address), dec));
      return; // success!
    } catch {
      console.log('mint(addr,amt) failed, trying mint(amt)...');
    }

    try {
      const tx = await usdt['mint(uint256)'](parseUnits('1000', dec), { gasLimit: 200000 });
      const r = await tx.wait();
      console.log(r.status === 1 ? '✅ USDT mint(amt) SUCCESS!' : '❌ Reverted');
      return;
    } catch {
      console.log('mint(amt) also failed');
    }
  } catch (e) {
    console.log('USDT contract error:', e.message.slice(0, 80));
  }

  // 3. Check if DOC borrow from earlier worked
  console.log('\n=== Checking DOC from earlier borrow ===');
  try {
    const doc = new Contract(TOKENS.DOC, ERC20, p);
    const bal = await doc.balanceOf(wallet.address);
    const dec = await doc.decimals();
    const balance = formatUnits(bal, dec);
    console.log('DOC balance:', balance);
    if (parseFloat(balance) > 0) {
      console.log('✅ The DOC borrow worked! We have DOC!');
      return;
    }
  } catch (e) {
    console.log('DOC check error:', e.message.slice(0, 80));
  }

  // 4. Try borrowing DOC again from Tropykus
  console.log('\n=== Trying Tropykus DOC borrow ===');
  try {
    const kDOC = new Contract('0x71e6b108d823c2786f8ef63a3e0589576b4f3914', [
      'function borrow(uint256 borrowAmount) returns (uint256)',
      'function borrowBalanceStored(address) view returns (uint256)',
    ], wallet);

    const borrowed = await kDOC.borrowBalanceStored(wallet.address);
    console.log('Already borrowed:', formatUnits(borrowed, 18), 'DOC');

    if (parseFloat(formatUnits(borrowed, 18)) === 0) {
      console.log('Borrowing 50 DOC...');
      const tx = await kDOC.borrow(parseUnits('50', 18), { gasLimit: 500000 });
      const r = await tx.wait();
      console.log(r.status === 1 ? '✅ Borrow SUCCESS!' : '❌ Reverted');
    }

    const doc = new Contract(TOKENS.DOC, ERC20, p);
    console.log('DOC balance now:', formatUnits(await doc.balanceOf(wallet.address), 18));
  } catch (e) {
    console.log('Tropykus borrow error:', e.message.slice(0, 100));
  }

  console.log('\n=== Summary ===');
  for (const [name, addr] of Object.entries(TOKENS)) {
    try {
      const t = new Contract(addr, ERC20, p);
      const [bal, dec] = await Promise.all([t.balanceOf(wallet.address), t.decimals()]);
      const balance = formatUnits(bal, dec);
      if (parseFloat(balance) > 0) console.log(`✅ ${name}: ${balance}`);
    } catch {}
  }
}

main().catch(e => console.error('Fatal:', e.message.slice(0, 100)));
