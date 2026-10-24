/**
 * Collateral held on another chain (docs/CROSS-CHAIN.md). The issuer locks USDG, TSLA or AMZN in the vault on
 * Robinhood Chain; Chainlink CCIP tells the gateway on Arbitrum, which mints the same amount of receipts (USDG.rh,
 * TSLA.rh…) to the issuer. The receipts are what the note's escrow holds. Redeeming burns receipts on Arbitrum and
 * sends the release back over CCIP: the vault pays the real token on Robinhood. Every message waits for the source
 * chain to be final, so each direction takes roughly 15–25 minutes.
 */
import { useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft, ExternalLink, Lock } from 'lucide-react';
import { erc20Abi, formatUnits, parseUnits } from 'viem';
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
      setState({ busy: false, text: `Locked on ${leg.asset.name}. Chainlink CCIP is delivering it to ${leg.home.name}: usually 15–25 minutes, then the ${sym} receipts appear here.`, msg });
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
          <li key={n.receipt}>{n.receipt} credited to you: <strong>{leg.receipts[n.receipt] ? formatUnits(bal[n.receipt] ?? 0n, leg.receipts[n.receipt].decimals) : '—'}</strong>{n.amount ? ` (this issuance needs ${n.amount})` : ''}</li>
        ))}
      </ul>
      {state.text && <div role="status" className={`xs ${state.bad ? 'bad' : 'muted'}`}>{state.text} {state.msg && <a href={ccipLink(state.msg)} target="_blank" rel="noreferrer">Follow on CCIP <ExternalLink className="i" style={{ width: 11, height: 11 }} /></a>}</div>}
    </div>
  );
}

/** Portfolio: receipts you hold (released collateral, or a default payout) can be redeemed for the real token. */
export function RedeemOnRobinhood() {
  const legs = useCrossChainLegs();
  return <>{legs.map(l => <RedeemLeg key={l.gateway} leg={l} />)}</>;
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
      setState({ busy: s, text: `Redeem ${formatUnits(amount, r.decimals)} ${s} (CCIP fee ${formatUnits(fee, 18).slice(0, 10)} ETH)…` });
      const hash = await w.writeContract({ address: leg.gateway, abi: homeGatewayAbi, functionName: 'redeem', args: [r.receipt, amount, address as `0x${string}`], value: fee, account: w.account!, chain: w.chain });
      const rc = await client.waitForTransactionReceipt({ hash });
      setState({ busy: '', text: `Sent. Chainlink CCIP releases your ${receiptLabel(s)} on ${leg.asset.name} in about 15–25 minutes.`, msg: messageIdOf(rc.logs) });
      setTick(t => t + 1);
    } catch (e) { setState({ busy: '', text: errText(e), bad: true }); }
  };

  return (
    <section className="card stack">
      <div className="row" style={{ gap: 8 }}><ArrowRightLeft className="i" /><h3 style={{ margin: 0 }}>Collateral receipts{leg.version ? ` (earlier engine, v${leg.version})` : ''}</h3></div>
      <p className="xs muted">Receipts for tokens locked on {leg.asset.name}{leg.version ? ' for notes on the earlier engine; they redeem through its own gateway' : ''}. Redeem them to get the real tokens back there (collateral released to an issuer, or a holder's share after a default).</p>
      {held.map(s => (
        <div key={s} className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
          <span>{formatUnits(bal[s], leg.receipts[s].decimals)} {s}</span>
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
