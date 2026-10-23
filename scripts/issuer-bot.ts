/**
 * The issuer's side of its notes, automated for demos and tests: whenever a payment falls due (an observation
 * fixed what a period owes) and the escrow does not hold it yet, fund the shortfall through that period's
 * "Fund Payment" window; fund deliveries for physical settlement; optionally top up collateral in a margin
 * call. Leave chosen payments unfunded (MISS) to show a default: the note then pays the holders from escrow.
 *
 *   RPC=... CHAIN_ID=421614 ENGINE=0x... LENS=0x... ISSUER_KEY_FILE=path [FROM_BLOCK=n] \
 *   [PIDS=3,4] [MISS=4:1,7:2] [MINT=1] [TOP_UP=1] [INTERVAL=10] npx tsx scripts/issuer-bot.ts [--once]
 *
 * PIDS: the notes to look after (default: every note whose Issuer role is this key). MISS: pid:period payments
 * to leave unfunded. MINT=1: mint test tokens the wallet lacks (the key must be the test token's owner, e.g.
 * the deployer on a testnet, or any account on a local MockERC20). The key is read from a file (a
 * `cast wallet new --json` array, or a bare hex key) or ISSUER_KEY, and never printed.
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, erc20Abi, http, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { dec, toBase } from '@sn/core';
import { CHAINS, engineAbi, EvmAdapter, issuerActions, noteId, noteView, type ChainInfo } from '@sn/sdk';

const env = (k: string, d?: string) => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`set ${k}`); return v; };
const keyHex = (): Hex => {
  if (process.env.ISSUER_KEY) return process.env.ISSUER_KEY as Hex;
  const raw = readFileSync(env('ISSUER_KEY_FILE'), 'utf8').trim();
  const k = raw.startsWith('[') ? (JSON.parse(raw) as Array<{ private_key: string }>)[0].private_key : raw;
  return (k.startsWith('0x') ? k : `0x${k}`) as Hex;
};
const rpc = env('RPC');
const chainId = Number(env('CHAIN_ID'));
const chain = defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const client = createPublicClient({ chain, transport: http(rpc) });
const account = privateKeyToAccount(keyHex());
const wallet = createWalletClient({ chain, account, transport: http(rpc) });
const info: ChainInfo = Object.values(CHAINS).find(c => c.chainId === chainId) ?? { ...CHAINS.local, chainId };
const engine = env('ENGINE') as Address;
const adapter = new EvmAdapter(info, client as never, { engine, lens: env('LENS') as Address, fromBlock: BigInt(env('FROM_BLOCK', '0')) });
const miss = new Set((process.env.MISS ?? '').split(',').map(s => s.trim()).filter(Boolean));
const only = process.env.PIDS ? new Set(process.env.PIDS.split(',').map(s => s.trim())) : null;
const mintAbi = parseAbi(['function mint(address to, uint256 amount)']);
const log = (s: string) => console.log(`[issuer-bot] ${s}`);

/** Make sure the wallet holds `base` of `token` (minting test tokens if allowed). */
async function ensure(token: Address, base: bigint) {
  const have = await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
  if (have >= base) return true;
  if (process.env.MINT !== '1') { log(`short of ${token}: ${have} < ${base}`); return false; }
  const hash = await wallet.writeContract({ address: token, abi: mintAbi, functionName: 'mint', args: [account.address, base - have], chain, account });
  await client.waitForTransactionReceipt({ hash });
  return true;
}

const ceil6 = (x: number) => Math.ceil(x * 1e6 - 1e-6) / 1e6;

async function tick() {
  const count = await client.readContract({ address: engine, abi: engineAbi, functionName: 'processCount' });
  for (let pid = 1n; pid <= count; pid++) {
    if (only && !only.has(pid.toString())) continue;
    const id = noteId(info.key, engine, pid);
    const s = await adapter.getNote(id);
    if (!s || s.status !== 0) continue;
    const def = await adapter.getDefinition(s.definition);
    if (!def) continue;
    const issuerRole = def.roles.indexOf('Issuer');
    if (issuerRole < 0 || s.roles[issuerRole] !== account.address.toLowerCase()) continue;
    const now = Number((await client.getBlock()).timestamp);
    const v = noteView(def, s, now);
    const e = v.economics;
    if (!e) continue;
    const actions = issuerActions(def, s, now); // windows still open: the engine refuses a late one
    const field = (name: string) => def.fields.findIndex(f => f.name === name);
    const run = async (step: number, fieldName: string, amount: number, assetName: string, label: string) => {
      const asset = def.assets.findIndex(a => a.name === assetName);
      const token = s.assetTokens[asset] as Address;
      if (!(await ensure(token, toBase(dec(amount.toFixed(9)), def.assets[asset].decimals)))) return;
      await adapter.executeStep(wallet as never, id, step, { [field(fieldName)]: { kind: 'number', value: dec(amount.toFixed(9)) } });
      log(`${id}: ${label} ${amount}`);
    };
    const call = e.nextCall;
    if (call && !call.funded && !miss.has(`${pid}:${call.period}`)) {
      const step = actions.fund.find(f => f.period === call.period);
      if (step) await run(step.step, 'fundAmount', ceil6(call.total - e.escrowCash), 'USDC', `funded payment ${call.period}:`);
      else log(`${id}: payment ${call.period}'s funding window has closed`);
    } else if (call && miss.has(`${pid}:${call.period}`)) {
      log(`${id}: leaving payment ${call.period} unfunded (MISS)`);
    }
    const period = e.periods.find(p => p.deliver && (p.status === 'due' || p.status === 'grace'));
    if (period?.deliver && !miss.has(`${pid}:${period.k}`)) {
      const d = actions.delivery.find(x => x.symbol === period.deliver!.symbol);
      const assetName = `t${period.deliver.symbol}`;
      const asset = def.assets.findIndex(a => a.name === assetName);
      const escrowRole = def.roleFlags.findIndex(f => (f & 1) === 1);
      const held = Number(BigInt(s.holdings.find(h => h.asset === asset && h.owner === s.roles[escrowRole])?.balance ?? '0')) / 1e10;
      const need = period.deliver.perUnit * v.sold - held;
      if (d && need > 1e-9) await run(d.step, `fundDelivery_${period.deliver.symbol}`, Math.ceil(need * 1e9) / 1e9 + 1e-9, assetName, `funded ${assetName} delivery:`);
    }
    if (e.marginCall && process.env.TOP_UP === '1' && e.required !== null && e.coverage !== null) {
      const c = e.collateral.find(x => x.price && x.haircut) ?? e.collateral[0];
      const t = actions.topUp.find(x => x.symbol === c.symbol);
      const need = (e.required - e.coverage) / ((c.price ?? 1) * (c.haircut || 1));
      if (t && need > 0) await run(t.step, `topUp_${c.symbol}`, Math.ceil(need * 1.01 * 1e6) / 1e6, c.symbol === 'USD' ? 'Collateral tUSD' : `Collateral t${c.symbol}`, `topped up ${c.symbol} collateral:`);
    }
  }
}

const once = process.argv.includes('--once');
for (;;) {
  try { await tick(); } catch (err) { log(`error: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`); if (once) process.exit(1); }
  if (once) break;
  await new Promise(r => setTimeout(r, Number(process.env.INTERVAL ?? 10) * 1000));
}
