/**
 * Collateral held on another chain (docs/CROSS-CHAIN.md). The issuer locks USDG, TSLA or AMZN in the vault on
 * Robinhood Chain; Chainlink CCIP tells the gateway on Arbitrum, which mints the same amount of receipts (USDG.rh,
 * TSLA.rh…) to the issuer. The receipts are what the note's escrow holds. With the v2 gateway, receipts never rest
 * in a wallet after the note: whatever the note pays out of them (a holder's share after a default, the issuer's
 * collateral at maturity) is burned on the way out and released automatically to the same address on Robinhood,
 * where the vault pays the real token (AutoReleases). Only receipts locked and never pledged are redeemed by hand.
 * Every message waits for the source chain to be final, so each direction takes roughly 15–25 minutes.
 */
import { useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft, CheckCircle2, Clock, ExternalLink, Lock } from 'lucide-react';
import { erc20Abi, formatUnits, parseAbiItem, parseUnits } from 'viem';
import { homeGatewayAbi, remoteVaultAbi } from '@sn/sdk';
import type { ChainConfig, CrossChainReceipt } from '../lib/api';
import { legacyConfig, useAddress, useChains, useSigner } from '../lib/chains';
import { errText } from '../lib/format';

const ccipLink = (id: string) => `https://ccip.chain.link/msg/${id}`;
const receiptLabel = (sym: string) => sym.replace(/\.rh$/, '');

/** `version`: set for an earlier engine's own gateway–vault pair (its notes' collateral is released through it). */
type Leg = { home: ChainConfig; asset: ChainConfig; vault: `0x${string}`; gateway: `0x${string}`; receipts: Record<string, CrossChainReceipt>; version?: number };

/** The home chain and its first asset chain, when this deployment has cross-chain collateral. */
export function useCrossChain(): Leg | null {
  const { config } = useChains();
  // Memoised: the leg is an effect dependency (receipt balances), so it must keep its identity across renders.
  return useMemo(() => currentLeg(config), [config]);
}

function currentLeg(config: ReturnType<typeof useChains>['config']): Leg | null {
  const home = config.chains.find(c => c.crossChain?.role === 'home');
  const r = home?.crossChain?.remotes?.[0];
  const asset = r && config.chains.find(c => c.key === r.chain);
  if (!home || !r || !asset || !home.crossChain?.gateway) return null;
  return { home, asset, vault: r.vault, gateway: home.crossChain.gateway, receipts: r.receipts };
}

/** The current pair, then each earlier engine's pair (receipts from v3 notes redeem through the v3 gateway). */
export function useCrossChainLegs(): Leg[] {
  const { config } = useChains();
  return useMemo(() => legsOf(config), [config]);
}

function legsOf(config: ReturnType<typeof useChains>['config']): Leg[] {
  const current = currentLeg(config);
  const out: Leg[] = current ? [current] : [];
  for (const c of config.chains) {
    for (const l of c.legacyEngines ?? []) {
      const xc = l.crossChain;
      const r = xc?.role === 'home' ? xc.remotes?.[0] : undefined;
      const asset = r && config.chains.find(x => x.key === r.chain);
      if (!xc?.gateway || !r || !asset) continue;
      out.push({ home: legacyConfig(c, l), asset, vault: r.vault, gateway: xc.gateway, receipts: r.receipts, version: l.version });
    }
    // The current engine's earlier pairs (a v1 gateway: receipts held in wallets redeem by hand).
    for (const xc of c.previousCrossChain ?? []) {
      const r = xc?.role === 'home' ? xc.remotes?.[0] : undefined;
      const asset = r && config.chains.find(x => x.key === r.chain);
      if (!xc?.gateway || !r || !asset) continue;
      out.push({ home: c, asset, vault: r.vault, gateway: xc.gateway, receipts: r.receipts });
    }
  }
  return out;
}

/** Receipt balances (on the home chain) for the given receipt symbols, refreshed every 20 s. */
function useReceiptBalances(leg: Leg | null, syms: string[], tick: number) {
  const address = useAddress();
  const { byKey } = useChains();
  const [bal, setBal] = useState<Record<string, bigint>>({});
  const key = syms.join(',');
  useEffect(() => {
    if (!leg || !address) return;
    let live = true;
    const read = async () => {
      const client = byKey[leg.home.key].client;
      const out: Record<string, bigint> = {};
      for (const s of syms) {
        const r = leg.receipts[s];
        if (r) out[s] = await client.readContract({ address: r.receipt, abi: erc20Abi, functionName: 'balanceOf', args: [address as `0x${string}`] });
      }
      if (live) setBal(out);
    };
    read().catch(() => {});
    const t = setInterval(() => read().catch(() => {}), 20_000);
    return () => { live = false; clearInterval(t); };
  }, [leg, address, key, tick, byKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return bal;
}

/** Issue flow: lock collateral on Robinhood Chain so its receipts can be pledged into the note. */
export function LockOnRobinhood({ needed }: { needed: Array<{ receipt: string; amount: number }> }) {
  const leg = useCrossChain();
  const address = useAddress();
  const signer = useSigner();
  const { byKey } = useChains();
  const [tick, setTick] = useState(0);
  const [sym, setSym] = useState(needed[0]?.receipt ?? 'TSLA.rh');
  const [amount, setAmount] = useState(String(needed[0]?.amount ?? ''));
  const [state, setState] = useState<{ busy: boolean; text: string; bad?: boolean; msg?: string }>({ busy: false, text: '' });
  const bal = useReceiptBalances(leg, needed.map(n => n.receipt), tick);
  if (!leg) return null;
  const r = leg.receipts[sym];

  const lock = async () => {
    if (!r || !address) return;
    setState({ busy: true, text: `Switching to ${leg.asset.name}…` });
    try {
      const w = await signer(leg.asset.key);
      const client = byKey[leg.asset.key].client;
      const units = parseUnits(amount || '0', r.decimals);
      if (units <= 0n) throw new Error('Enter an amount to lock.');
      const allowance = await client.readContract({ address: r.token, abi: erc20Abi, functionName: 'allowance', args: [address as `0x${string}`, leg.vault] });
      if (allowance < units) {
        setState({ busy: true, text: `Approve ${receiptLabel(sym)} for the vault…` });
        const h = await w.writeContract({ address: r.token, abi: erc20Abi, functionName: 'approve', args: [leg.vault, units], account: w.account!, chain: w.chain });
        await client.waitForTransactionReceipt({ hash: h });
      }
      const fee = await client.readContract({ address: leg.vault, abi: remoteVaultAbi, functionName: 'quoteLock', args: [r.token, units, address as `0x${string}`] }) as bigint;
      setState({ busy: true, text: `Lock ${amount} ${receiptLabel(sym)} (CCIP fee ${formatUnits(fee, 18).slice(0, 10)} ETH)…` });
      const hash = await w.writeContract({ address: leg.vault, abi: remoteVaultAbi, functionName: 'lock', args: [r.token, units, address as `0x${string}`], value: fee, account: w.account!, chain: w.chain });
      const rc = await client.waitForTransactionReceipt({ hash });
      const msg = messageIdOf(rc.logs);
      setState({ busy: false, text: `Locked on ${leg.asset.name}. Chainlink CCIP is delivering it to ${leg.home.name}: usually 15–25 minutes, then it shows here, ready to pledge.`, msg });
      setTick(t => t + 1);
    } catch (e) { setState({ busy: false, text: errText(e), bad: true }); }
  };

  return (
    <div className="xc-panel stack">
      <div className="row" style={{ gap: 8 }}><Lock className="i" /><strong>Lock collateral on {leg.asset.name}</strong></div>
      <p className="xs muted">This note's collateral stays on {leg.asset.name}: lock it in the vault there, and Chainlink CCIP credits receipts to you on {leg.home.name} to pledge at Approve Terms. The tokens never leave {leg.asset.name}. Delivery takes about 15–25 minutes, so lock well before the strike.</p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <label className="field" htmlFor="xc-token"><span className="lbl">Token</span>
          <select id="xc-token" value={sym} onChange={e => setSym(e.target.value)}>
            {needed.map(n => <option key={n.receipt} value={n.receipt}>{receiptLabel(n.receipt)}</option>)}
          </select>
        </label>
        <label className="field" htmlFor="xc-amount"><span className="lbl">Amount</span>
          <input id="xc-amount" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} />
        </label>
        <button className="btn primary" onClick={lock} disabled={state.busy || !address}>Lock on {leg.asset.name}</button>
      </div>
      <ul className="xs" style={{ margin: 0, paddingLeft: 18 }}>
        {needed.map(n => (
          <li key={n.receipt}>{receiptLabel(n.receipt)} locked on {leg.asset.name}, ready to pledge: <strong>{leg.receipts[n.receipt] ? formatUnits(bal[n.receipt] ?? 0n, leg.receipts[n.receipt].decimals) : '—'}</strong>{n.amount ? ` (this issuance needs ${n.amount})` : ''}</li>
        ))}
      </ul>
      {state.text && <div role="status" className={`xs ${state.bad ? 'bad' : 'muted'}`}>{state.text} {state.msg && <a href={ccipLink(state.msg)} target="_blank" rel="noreferrer">Follow on CCIP <ExternalLink className="i" style={{ width: 11, height: 11 }} /></a>}</div>}
      <LockTracker leg={leg} address={address} tick={tick} />
    </div>
  );
}

const lockedEvent = parseAbiItem('event Locked(bytes32 indexed lockId, address indexed from, address indexed beneficiary, address token, uint256 amount, bytes32 messageId, uint256 fee)');
const creditedEvent = parseAbiItem('event LockCredited(bytes32 indexed lockId, uint64 indexed chainSelector, address indexed account, address receipt, uint256 amount, bytes32 messageId)');
type TrackedLock = { lockId: `0x${string}`; token: string; amount: bigint; messageId: string; tx: string; at: number; credited: string | null };

/**
 * The wallet's recent locks, read from both chains (so it survives a reload): locked in the vault on the asset chain,
 * Chainlink CCIP on the way, credited on the home chain and ready to pledge. Re-read every 15 s.
 */
function useMyLocks(leg: Leg, address: string | null, tick: number) {
  const { byKey } = useChains();
  const [locks, setLocks] = useState<TrackedLock[] | null>(null);
  useEffect(() => {
    if (!address) return;
    let live = true;
    const asset = byKey[leg.asset.key]?.client, home = byKey[leg.home.key]?.client;
    if (!asset || !home) return;
    const read = async () => {
      try {
        const head = await asset.getBlockNumber();
        const found: TrackedLock[] = [];
        // Recent history in a few ranges (the asset chain makes several blocks a second).
        for (let i = 0n; i < 4n && found.length < 3; i++) {
          const to = head - i * 50_000n, from = to - 49_999n;
          const logs = await asset.getLogs({ address: leg.vault, event: lockedEvent, args: { beneficiary: address as `0x${string}` }, fromBlock: from > 0n ? from : 0n, toBlock: to });
          for (const l of logs.reverse()) {
            const b = await asset.getBlock({ blockNumber: l.blockNumber! });
            found.push({ lockId: l.args.lockId!, token: l.args.token!, amount: l.args.amount!, messageId: l.args.messageId!, tx: l.transactionHash!, at: Number(b.timestamp), credited: null });
          }
        }
        const recent = found.filter(x => Date.now() / 1000 - x.at < 86_400).slice(0, 3);
        if (recent.length) {
          const hHead = await home.getBlockNumber();
          for (let i = 0n; i < 6n; i++) {
            const to = hHead - i * 10_000n, from = to - 9_999n;
            const logs = await home.getLogs({ address: leg.gateway, event: creditedEvent, args: { lockId: recent.map(x => x.lockId) }, fromBlock: from, toBlock: to });
            for (const l of logs) { const x = recent.find(y => y.lockId === l.args.lockId); if (x) x.credited = l.transactionHash!; }
            if (recent.every(x => x.credited)) break;
          }
        }
        if (live) setLocks(recent);
      } catch { /* a slow RPC: keep the last reading */ }
    };
    void read();
    const t = setInterval(read, 15_000);
    return () => { live = false; clearInterval(t); };
  }, [leg.vault, leg.gateway, leg.asset.key, leg.home.key, address, tick, byKey]);
  return locks;
}

function LockTracker({ leg, address, tick }: { leg: Leg; address: string | null; tick: number }) {
  const locks = useMyLocks(leg, address, tick);
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => { const t = setInterval(() => setNow(Date.now() / 1000), 5_000); return () => clearInterval(t); }, []);
  if (!locks?.length) return null;
  const symOf = (token: string) => receiptLabel(Object.entries(leg.receipts).find(([, r]) => r.token.toLowerCase() === token.toLowerCase())?.[0] ?? 'tokens');
  const decOf = (token: string) => Object.values(leg.receipts).find(r => r.token.toLowerCase() === token.toLowerCase())?.decimals ?? 18;
  const ex = (c: ChainConfig, tx: string) => (c.explorer ? `${c.explorer}/tx/${tx}` : undefined);
  const mins = (s: number) => `${Math.max(0, Math.floor(s / 60))} min`;
  return (
    <div className="xc-track stack" aria-label="Your recent locks">
      {locks.map(l => {
        const done = !!l.credited;
        return (
          <ol key={l.lockId} className="xc-steps" data-lock-state={done ? 'credited' : 'in-flight'}>
            <li className="done"><CheckCircle2 className="i" /><span><b>Locked on {leg.asset.name}</b> · {formatUnits(l.amount, decOf(l.token))} {symOf(l.token)} · {new Date(l.at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{ex(leg.asset, l.tx) && <> · <a href={ex(leg.asset, l.tx)} target="_blank" rel="noreferrer">tx</a></>}</span></li>
            <li className={done ? 'done' : 'active'}>{done ? <CheckCircle2 className="i" /> : <Clock className="i" />}<span><b>{done ? 'Delivered by Chainlink CCIP' : 'Chainlink CCIP delivering'}</b>{done ? '' : ` · ${mins(now - l.at)} so far, usually 15–25`} · <a href={ccipLink(l.messageId)} target="_blank" rel="noreferrer">Follow on CCIP <ExternalLink className="i" style={{ width: 11, height: 11 }} /></a></span></li>
            <li className={done ? 'done' : ''}>{done ? <CheckCircle2 className="i" /> : <ArrowRightLeft className="i" />}<span><b>{done ? `Credited on ${leg.home.name}: ready to pledge` : `Credited on ${leg.home.name}`}</b>{done && ex(leg.home, l.credited!) && <> · <a href={ex(leg.home, l.credited!)} target="_blank" rel="noreferrer">tx</a></>}</span></li>
          </ol>
        );
      })}
    </div>
  );
}

/** Whether a gateway auto-releases (v2: `VERSION()` = 2; a v1 gateway has no VERSION and reverts). */
const versionCache = new Map<string, Promise<number>>();
export function useGatewayVersion(leg: Leg | null): number | null {
  const { byKey } = useChains();
  const [v, setV] = useState<number | null>(null);
  useEffect(() => {
    if (!leg) return;
    let live = true;
    const key = `${leg.home.key}:${leg.gateway.toLowerCase()}`;
    if (!versionCache.has(key)) {
      versionCache.set(key, byKey[leg.home.key].client.readContract({ address: leg.gateway, abi: homeGatewayAbi, functionName: 'VERSION' })
        .then(x => Number(x)).catch(() => 1));
    }
    versionCache.get(key)!.then(x => { if (live) setV(x); });
    return () => { live = false; };
  }, [leg, byKey]);
  return v;
}

/**
 * Whether `token` (a note asset) is a receipt that the current gateway releases automatically when it leaves the
 * note: withdrawing it pays the real token on the asset chain, nothing to redeem.
 */
export function useAutoReleased(): (token: string | undefined) => { chain: string } | null {
  const leg = useCrossChain();
  const v = useGatewayVersion(leg);
  return (token) => {
    if (!leg || v !== 2 || !token) return null;
    const t = token.toLowerCase();
    return Object.values(leg.receipts).some(r => r.receipt.toLowerCase() === t) ? { chain: leg.asset.name } : null;
  };
}

/**
 * Portfolio: collateral paid to you out of a note is released automatically to your wallet on Robinhood Chain
 * (AutoReleases); receipts in your wallet (locked, never pledged; or paid out by an earlier gateway) are redeemed.
 */
export function RedeemOnRobinhood() {
  const legs = useCrossChainLegs();
  return <>{legs.map(l => <AutoReleases key={`a${l.gateway}`} leg={l} />)}{legs.map(l => <RedeemLeg key={l.gateway} leg={l} />)}</>;
}

type ReleaseRow = { index: bigint; sym: string; decimals: number; amount: bigint; to: string; sent?: { messageId: string; tx: string } };

/** Releases queued for you at a v2 gateway (from its events), and their CCIP messages once sent. */
function AutoReleases({ leg }: { leg: Leg }) {
  const address = useAddress();
  const signer = useSigner();
  const { byKey } = useChains();
  const version = useGatewayVersion(leg);
  const [rows, setRows] = useState<ReleaseRow[]>([]);
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<{ busy: string; text: string; bad?: boolean; msg?: string }>({ busy: '', text: '' });
  useEffect(() => {
    if (version !== 2 || !address) return;
    let live = true;
    const client = byKey[leg.home.key].client;
    const bySym = new Map(Object.entries(leg.receipts).map(([sym, r]) => [r.receipt.toLowerCase(), { sym, decimals: r.decimals }]));
    const read = async () => {
      // The gateway is deployed after the engine: the engine's first block bounds the scan.
      const fromBlock = BigInt(leg.home.fromBlock ?? 0);
      const queued = await client.getContractEvents({ address: leg.gateway, abi: homeGatewayAbi, eventName: 'ReleaseQueued', args: { account: address as `0x${string}` }, fromBlock });
      const byIndex = new Map<bigint, ReleaseRow>();
      for (const l of queued) {
        const a = l.args as { index: bigint; receipt: string; to: string; amount: bigint };
        const r = bySym.get(a.receipt.toLowerCase());
        byIndex.set(a.index, { index: a.index, sym: r?.sym ?? 'receipt', decimals: r?.decimals ?? 18, amount: a.amount, to: a.to }); // later events: the joined total
      }
      if (byIndex.size) {
        const sent = await client.getContractEvents({ address: leg.gateway, abi: homeGatewayAbi, eventName: 'ReleaseSent', args: { index: [...byIndex.keys()] }, fromBlock });
        for (const l of sent) {
          const a = l.args as { index: bigint; messageId: string };
          const row = byIndex.get(a.index);
          if (row) row.sent = { messageId: a.messageId, tx: l.transactionHash ?? '' };
        }
      }
      if (live) setRows([...byIndex.values()].sort((x, y) => Number(y.index - x.index)));
    };
    read().catch(() => {});
    const t = setInterval(() => read().catch(() => {}), 30_000);
    return () => { live = false; clearInterval(t); };
  }, [leg, address, version, tick, byKey]);
  if (version !== 2 || !address || !rows.length) return null;

  // Anyone may send a queued release now, paying its CCIP fee (it does not have to wait for the next flush).
  const sendNow = async (row: ReleaseRow) => {
    setState({ busy: String(row.index), text: `Switching to ${leg.home.name}…` });
    try {
      const w = await signer(leg.home.key);
      const client = byKey[leg.home.key].client;
      const r = leg.receipts[row.sym];
      const fee = await client.readContract({ address: leg.gateway, abi: homeGatewayAbi, functionName: 'quoteRedeem', args: [r.receipt, row.amount, row.to as `0x${string}`] }) as bigint;
      setState({ busy: String(row.index), text: `Send now (CCIP fee ${formatUnits(fee, 18).slice(0, 10)} ETH)…` });
      const hash = await w.writeContract({ address: leg.gateway, abi: homeGatewayAbi, functionName: 'sendQueued', args: [row.index], value: fee, account: w.account!, chain: w.chain });
      const rc = await client.waitForTransactionReceipt({ hash });
      setState({ busy: '', text: `Sent. Chainlink CCIP pays your ${receiptLabel(row.sym)} on ${leg.asset.name} in about 15–25 minutes.`, msg: messageIdOf(rc.logs) });
      setTick(t => t + 1);
    } catch (e) { setState({ busy: '', text: errText(e), bad: true }); }
  };

  return (
    <section className="card stack" data-auto-releases>
      <div className="row" style={{ gap: 8 }}><ArrowRightLeft className="i" /><h3 style={{ margin: 0 }}>Collateral released to {leg.asset.name}</h3></div>
      <p className="xs muted">Collateral a note paid you (your share after a default, or an issuer's collateral back at maturity) stays on {leg.asset.name}: the receipts are burned on {leg.home.name} and the vault there pays the real token to your address, over Chainlink CCIP. Nothing to redeem.</p>
      {rows.map(row => (
        <div key={String(row.index)} className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <span>{formatUnits(row.amount, row.decimals)} {receiptLabel(row.sym)}{row.to.toLowerCase() !== address.toLowerCase() ? <span className="xs muted"> to {row.to.slice(0, 6)}…{row.to.slice(-4)}</span> : null}</span>
          {row.sent
            ? <span className="xs"><CheckCircle2 className="i" style={{ width: 12, height: 12 }} /> Released to your wallet on {leg.asset.name} <a href={ccipLink(row.sent.messageId)} target="_blank" rel="noreferrer">CCIP msg {row.sent.messageId.slice(0, 10)}… <ExternalLink className="i" style={{ width: 11, height: 11 }} /></a></span>
            : <span className="row xs" style={{ gap: 8 }}><Clock className="i" style={{ width: 12, height: 12 }} /> Queued: goes out with the next release run
              <button className="btn sm" onClick={() => sendNow(row)} disabled={!!state.busy}>{state.busy === String(row.index) ? 'Sending…' : 'Send now'}</button></span>}
        </div>
      ))}
      {state.text && <div role="status" className={`xs ${state.bad ? 'bad' : 'muted'}`}>{state.text} {state.msg && <a href={ccipLink(state.msg)} target="_blank" rel="noreferrer">Follow on CCIP <ExternalLink className="i" style={{ width: 11, height: 11 }} /></a>}</div>}
    </section>
  );
}

function RedeemLeg({ leg }: { leg: Leg }) {
  const address = useAddress();
  const signer = useSigner();
  const { byKey } = useChains();
  const [tick, setTick] = useState(0);
  const syms = leg ? Object.keys(leg.receipts) : [];
  const bal = useReceiptBalances(leg, syms, tick);
  const [state, setState] = useState<{ busy: string; text: string; bad?: boolean; msg?: string }>({ busy: '', text: '' });
  if (!leg || !address) return null;
  const held = syms.filter(s => (bal[s] ?? 0n) > 0n);
  if (!held.length) return null;

  const redeem = async (s: string) => {
    const r = leg.receipts[s];
    setState({ busy: s, text: `Switching to ${leg.home.name}…` });
    try {
      const w = await signer(leg.home.key);
      const client = byKey[leg.home.key].client;
      const amount = bal[s];
      const fee = await client.readContract({ address: leg.gateway, abi: homeGatewayAbi, functionName: 'quoteRedeem', args: [r.receipt, amount, address as `0x${string}`] }) as bigint;
      setState({ busy: s, text: `Release ${formatUnits(amount, r.decimals)} ${receiptLabel(s)} on ${leg.asset.name} (CCIP fee ${formatUnits(fee, 18).slice(0, 10)} ETH)…` });
      const hash = await w.writeContract({ address: leg.gateway, abi: homeGatewayAbi, functionName: 'redeem', args: [r.receipt, amount, address as `0x${string}`], value: fee, account: w.account!, chain: w.chain });
      const rc = await client.waitForTransactionReceipt({ hash });
      setState({ busy: '', text: `Sent. Chainlink CCIP releases your ${receiptLabel(s)} on ${leg.asset.name} in about 15–25 minutes.`, msg: messageIdOf(rc.logs) });
      setTick(t => t + 1);
    } catch (e) { setState({ busy: '', text: errText(e), bad: true }); }
  };

  return (
    <section className="card stack">
      <div className="row" style={{ gap: 8 }}><ArrowRightLeft className="i" /><h3 style={{ margin: 0 }}>Collateral receipts{leg.version ? ` (earlier engine, v${leg.version})` : ''}</h3></div>
      <p className="xs muted">Receipts in your wallet for tokens locked on {leg.asset.name}{leg.version ? ' for notes on the earlier engine; they redeem through its own gateway' : ''}: ones you locked and have not pledged{leg.version ? ', or a payout from an earlier note' : ''}. Redeem them to get the real tokens back there.</p>
      {held.map(s => (
        <div key={s} className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
          <span>{formatUnits(bal[s], leg.receipts[s].decimals)} {receiptLabel(s)} locked on {leg.asset.name}</span>
          <button className="btn" onClick={() => redeem(s)} disabled={!!state.busy}>{state.busy === s ? 'Redeeming…' : `Redeem on ${leg.asset.name}`}</button>
        </div>
      ))}
      {state.text && <div role="status" className={`xs ${state.bad ? 'bad' : 'muted'}`}>{state.text} {state.msg && <a href={ccipLink(state.msg)} target="_blank" rel="noreferrer">Follow on CCIP <ExternalLink className="i" style={{ width: 11, height: 11 }} /></a>}</div>}
    </section>
  );
}

/** The CCIP message id in a vault Locked or gateway Redeemed event (bytes32 after the token/amount words). */
function messageIdOf(logs: ReadonlyArray<{ topics: readonly string[]; data: string; address: string }>): string | undefined {
  // The router's onRamp emits CCIPMessageSent with the message id as its last topic; take it from there.
  const sent = logs.find(l => l.topics.length === 4 && l.topics[0].startsWith('0x371bc2ff'));
  return sent ? sent.topics[3] : undefined;
}
