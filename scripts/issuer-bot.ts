/**
 * The issuer's side of its notes, automated for demos and tests: whenever a payment falls due (an observation
 * fixed what a period owes) and the escrow does not hold it yet, fund the shortfall through that period's
 * "Fund Payment" window; fund deliveries for physical settlement; optionally top up collateral in a margin
 * call. Leave chosen payments unfunded (MISS) to show a default: the note then pays the holders from escrow.
 *
 * Payouts are CLAIMED by default: Chainlink CRE pays each coupon and the redemption into the note on its payment
 * date, and each holder claims from the portfolio when they like (pushTo for themselves, their own gas, a receipt
 * per claim). This bot pushes payouts to holders' wallets only where that was chosen (packages/sdk payout-policy.ts):
 *   PUSH unset   push only notes whose terms opt in (term sheet `payouts: 'push'`, chosen at issuance: "Paid to
 *                your wallet automatically, issuer covers gas"); every other note stays claim-only
 *   PUSH=1       push every note this bot looks after (or PIDS), opted in or not
 *   PUSH=0       push nothing, not even opted-in notes
 *   PUSH_MIN=x   when pushing, only holders owed at least x of the asset (e.g. 0.5 = 0.5 USDG), with pushTo in
 *                batches; smaller amounts stay claimable. Without it, the round's cursor is walked (pushPayouts)
 *                and anyone the cursor missed is swept with pushTo.
 *   PUSH_BATCH   holders per transaction (default 100); PUSH_ASSETS limits pushing to some assets (e.g. 1: the
 *                stablecoin). PUSH_ONLY=1 makes it a payout keeper for every note (or PIDS) under the same
 *                policy, funding nothing: any funded account will do, since pushing is permissionless.
 *
 *   RPC=... CHAIN_ID=421614 ENGINE=0x... LENS=0x... ISSUER_KEY_FILE=path [FROM_BLOCK=n] \
 *   [PIDS=3,4] [MISS=4:1,7:2] [MINT=1] [TOP_UP=1] [PUSH=1|0] [PUSH_MIN=0.5] [INTERVAL=10] npx tsx scripts/issuer-bot.ts [--once]
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
import { CHAINS, engineAbi, EvmAdapter, issuerActions, lensAbi, noteId, noteView, pushesNote, pushPolicyFromEnv, type ChainInfo } from '@sn/sdk';

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
const lens = env('LENS') as Address;
const adapter = new EvmAdapter(info, client as never, { engine, lens, fromBlock: BigInt(env('FROM_BLOCK', '0')) });
const miss = new Set((process.env.MISS ?? '').split(',').map(s => s.trim()).filter(Boolean));
const only = process.env.PIDS ? new Set(process.env.PIDS.split(',').map(s => s.trim())) : null;
const mintAbi = parseAbi(['function mint(address to, uint256 amount)']);
const log = (s: string) => console.log(`[issuer-bot] ${s}`);
const policy = pushPolicyFromEnv(process.env);
const pushOnly = process.env.PUSH_ONLY === '1';
const pushBatch = policy.batch;
const MAX = 2n ** 256n - 1n;
/** Push rounds not settled yet: `${pid}:${asset}` -> period, from DistributionRecorded / DistributionSettled. */
const openRounds = new Map<string, bigint>();
let pushFrom = BigInt(env('FROM_BLOCK', '0'));

/** Holders of a note's units, paged through the lens. */
async function holdersOf(pid: bigint): Promise<readonly Address[]> {
  const out: Address[] = [];
  for (let start = 0n; ; start += 1000n) {
    const [who, , total] = await client.readContract({ address: lens, abi: lensAbi, functionName: 'holders', args: [pid, 0n, start, 1000n] });
    out.push(...who);
    if (!who.length || start + 1000n >= total) return out;
  }
}

/** pushTo every holder owed at least `min` (engine fixed point), PUSH_BATCH per transaction. */
async function pushOwed(pid: bigint, asset: number, min: bigint, what: string) {
  const who = await holdersOf(pid);
  if (!who.length) return;
  const owed = await client.readContract({ address: lens, abi: lensAbi, functionName: 'claimable', args: [pid, BigInt(asset), who] });
  const due = who.filter((_, i) => owed[i] >= min);
  for (let i = 0; i < due.length; i += Number(pushBatch)) {
    const batch = due.slice(i, i + Number(pushBatch));
    const hash = await wallet.writeContract({ address: engine, abi: engineAbi, functionName: 'pushTo', args: [pid, asset, batch], chain, account });
    const r = await client.waitForTransactionReceipt({ hash });
    log(`${noteId(info.key, engine, pid)}: ${what} ${batch.length} holder(s) on asset ${asset} (${r.gasUsed} gas)`);
  }
  if (due.length < who.length && min > 10_000n) log(`${noteId(info.key, engine, pid)}: ${who.length - due.length} holder(s) owed less than PUSH_MIN stay claimable`);
}

/**
 * Push the open payout rounds of the notes this bot pushes for (`push`: its policy said yes for the note), to the
 * end of each holder set; with PUSH_MIN, only to holders owed at least that.
 */
async function pushPayouts(push: Set<string>) {
  const head = await client.getBlockNumber();
  if (head >= pushFrom) {
    const [rec, settled] = await Promise.all([
      client.getContractEvents({ address: engine, abi: engineAbi, eventName: 'DistributionRecorded', fromBlock: pushFrom, toBlock: head }),
      client.getContractEvents({ address: engine, abi: engineAbi, eventName: 'DistributionSettled', fromBlock: pushFrom, toBlock: head }),
    ]);
    const all = [...rec.map(l => ({ l, open: true })), ...settled.map(l => ({ l, open: false }))]
      .sort((a, b) => Number(a.l.blockNumber - b.l.blockNumber) || a.l.logIndex - b.l.logIndex);
    for (const { l, open } of all) {
      const a = l.args as { pid: bigint; asset: number; period: bigint };
      const key = `${a.pid}:${a.asset}`;
      if (open) openRounds.set(key, a.period);
      else if (openRounds.get(key) === a.period) openRounds.delete(key);
    }
    pushFrom = head + 1n;
  }
  for (const [key] of [...openRounds]) {
    const [pid, asset] = key.split(':');
    if (!push.has(pid) || (policy.assets && !policy.assets.has(asset))) continue;
    if (policy.min > 0n) {
      openRounds.delete(key);
      await pushOwed(BigInt(pid), Number(asset), policy.min, 'paid');
      continue;
    }
    let left = 1n;
    for (let n = 0; left > 0n && n < 50; n++) {
      const { result } = await client.simulateContract({ address: engine, abi: engineAbi, functionName: 'pushPayouts', args: [BigInt(pid), Number(asset), MAX, pushBatch], account });
      const hash = await wallet.writeContract({ address: engine, abi: engineAbi, functionName: 'pushPayouts', args: [BigInt(pid), Number(asset), MAX, pushBatch], chain, account });
      const r = await client.waitForTransactionReceipt({ hash });
      left = result;
      log(`${noteId(info.key, engine, BigInt(pid))}: pushed payouts of asset ${asset} (${r.gasUsed} gas, ${left} holders left)`);
    }
    if (left > 0n) continue;
    openRounds.delete(key);
    // The holder set can reorder mid-round (a holder selling out swaps the last one into its slot), and a
    // payment can be deferred: sweep once with pushTo for every holder still owed at least one base unit.
    await pushOwed(BigInt(pid), Number(asset), 10_000n, 'swept');
  }
}

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
  const mine = new Set<string>();
  if (pushOnly) {
    if (policy.mode === 'off') return;
    for (let pid = 1n; pid <= count; pid++) if (!only || only.has(pid.toString())) mine.add(pid.toString());
    return pushPayouts(await toPush(mine));
  }
  for (let pid = 1n; pid <= count; pid++) {
    if (only && !only.has(pid.toString())) continue;
    const id = noteId(info.key, engine, pid);
    const s = await adapter.getNote(id);
    if (!s) continue;
    const def = await adapter.getDefinition(s.definition);
    if (!def) continue;
    const issuerRole = def.roles.indexOf('Issuer');
    if (issuerRole < 0 || s.roles[issuerRole] !== account.address.toLowerCase()) continue;
    mine.add(pid.toString()); // a completed note may still have its redemption to push
    if (s.status !== 0) continue;
    const now = Number((await client.getBlock()).timestamp);
    const v = noteView(def, s, now);
    const e = v.economics;
    if (!e) continue;
    const actions = issuerActions(def, s, now); // windows still open: the engine refuses a late one
    const field = (name: string) => def.fields.findIndex(f => f.name === name);
    const run = async (step: number, fieldName: string, amount: number, assetName: string, label: string) => {
      // The cash asset is USDG on new notes and USDC (tUSD) on notes issued before USDG.
      const asset = def.assets.findIndex(a => a.name === assetName || (assetName === 'USDG' && a.name === 'USDC'));
      const token = s.assetTokens[asset] as Address;
      if (!(await ensure(token, toBase(dec(amount.toFixed(9)), def.assets[asset].decimals)))) return;
      await adapter.executeStep(wallet as never, id, step, { [field(fieldName)]: { kind: 'number', value: dec(amount.toFixed(9)) } });
      log(`${id}: ${label} ${amount}`);
    };
    const call = e.nextCall;
    if (call && !call.funded && !miss.has(`${pid}:${call.period}`)) {
      const step = actions.fund.find(f => f.period === call.period);
      if (step) await run(step.step, 'fundAmount', ceil6(call.total - e.escrowCash), 'USDG', `funded payment ${call.period}:`);
      else log(`${id}: payment ${call.period}'s funding window has closed`);
    } else if (call && miss.has(`${pid}:${call.period}`)) {
      log(`${id}: leaving payment ${call.period} unfunded (MISS)`);
    }
    const period = e.periods.find(p => p.deliver && (p.status === 'due' || p.status === 'grace'));
    if (period?.deliver && !miss.has(`${pid}:${period.k}`)) {
      const d = actions.delivery.find(x => x.symbol === period.deliver!.symbol);
      // Our test token (tTSLA…) or, for notes on Robinhood Chain's own stock tokens, the bare symbol (TSLA).
      const sym = period.deliver.symbol;
      const asset = def.assets.findIndex(a => a.name === `t${sym}` || a.name === sym);
      const assetName = asset >= 0 ? def.assets[asset].name : `t${period.deliver.symbol}`;
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
  if (policy.mode !== 'off') await pushPayouts(await toPush(mine));
}

/** Of these notes, the ones this bot pushes for: all of them with PUSH=1, else those whose terms opt in. */
const pushChoice = new Map<string, boolean>();
async function toPush(pids: Set<string>): Promise<Set<string>> {
  const out = new Set<string>();
  for (const pid of pids) {
    let yes = pushChoice.get(pid);
    if (yes === undefined) {
      if (policy.mode === 'all') yes = true;
      else {
        const s = await adapter.getNote(noteId(info.key, engine, BigInt(pid)));
        const def = s ? await adapter.getDefinition(s.definition) : null;
        yes = !!def && pushesNote(policy, def);
        if (yes) log(`${noteId(info.key, engine, BigInt(pid))}: its terms opt in to paying holders' wallets: pushing its payouts`);
      }
      pushChoice.set(pid, yes);
    }
    if (yes) out.add(pid);
  }
  return out;
}

const once = process.argv.includes('--once');
for (;;) {
  try { await tick(); } catch (err) { log(`error: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`); if (once) process.exit(1); }
  if (once) break;
  await new Promise(r => setTimeout(r, Number(process.env.INTERVAL ?? 10) * 1000));
}
