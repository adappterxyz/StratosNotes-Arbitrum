/**
 * Test tokens. The cash leg is USDG, which Paxos hands out (we cannot mint it): the default choice links to the Paxos
 * faucet. On a testnet with our TokenFaucet the connected wallet claims our own test tokens itself (tETH, tBTC,
 * tTSLA… for delivery and collateral): one claim per token per hour, gas paid by the wallet. A chain's own tokens
 * (Robinhood Chain's TSLA, AMZN, NFLX) come from that chain's faucet, linked. tUSD, our old test dollar, is not
 * offered (it only settles notes issued before USDG). On a local dev chain the API mints its mock stablecoin.
 */
import { AssetIcon, AssetStack } from './AssetIcon';
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Droplet, ExternalLink } from 'lucide-react';
import { CASH_FAUCET, CASH_TOKEN, EXTERNAL_TOKENS, STOCK_TOKEN_FAUCETS, TEST_CASH_TOKEN } from '@sn/core';
import { parseAbi } from 'viem';
import { useAccount } from 'wagmi';
import { api } from '../lib/api';
import { useAddress, useChains, useSigner } from '../lib/chains';
import { errText } from '../lib/format';

const faucetAbi = parseAbi(['function claim(address token)', 'function drips(address token) view returns (uint256 amount, uint64 cooldown)']);

/** Where to get gas on each testnet (the faucet hands out tokens, not ETH). */
const GAS_FAUCETS: Record<string, string> = {
  'arbitrum-sepolia': 'https://faucets.chain.link/arbitrum-sepolia',
  'robinhood-testnet': 'https://faucet.testnet.chain.robinhood.com',
};

export default function FaucetButton() {
  const address = useAddress();
  const { chainId } = useAccount();
  const { config, byKey } = useChains();
  const signer = useSigner();
  const [token, setToken] = useState(CASH_TOKEN.token);
  const [state, setState] = useState<{ busy: boolean; text: string; bad?: boolean }>({ busy: false, text: '' });
  if (!address) return null;
  // The wallet's current network if it has a faucet, else the first that does.
  const withFaucet = config.chains.filter(c => c.tokenFaucet);
  const onChain = withFaucet.find(c => c.chainId === chainId) ?? withFaucet[0];
  const dev = config.chains.find(c => c.faucet);
  if (!onChain && !dev) return null;

  const status = state.text && (
    <span className="xs" role="status" style={{ color: state.bad ? 'hsl(var(--destructive))' : 'hsl(var(--muted-foreground))', maxWidth: 220, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={state.text}>{state.text}</span>
  );

  if (!onChain && dev) {
    const get = async () => {
      setState({ busy: true, text: `Sending test ${dev.stablecoin.symbol}…` });
      try {
        const r = await api.faucet(dev.key, address);
        setState({ busy: false, text: `${Number(r.amount).toLocaleString()} ${r.symbol} sent.` });
      } catch (e) { setState({ busy: false, text: errText(e), bad: true }); }
    };
    return <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>{status}<button className="btn" onClick={get} disabled={state.busy}><Droplet className="i" />Test {dev.stablecoin.symbol}</button></span>;
  }

  const ch = onChain!;
  const external = new Set(Object.keys(EXTERNAL_TOKENS[ch.key] ?? {}));
  // Receipts (TSLA.rh…) are minted by CCIP for collateral locked on another chain: never from the faucet.
  const ours = Object.keys(ch.tokens).filter(s => !external.has(s) && !s.endsWith('.rh') && s !== TEST_CASH_TOKEN.token && s !== CASH_TOKEN.token);
  const claim = async (token: string) => {
    const addr = ch.tokens[token];
    if (!addr || !ch.tokenFaucet) return;
    setToken(token);
    setState({ busy: true, text: `Claiming ${token} on ${ch.name}: confirm in your wallet…` });
    try {
      const w = await signer(ch.key);
      const client = byKey[ch.key].client;
      const hash = await w.writeContract({ address: ch.tokenFaucet, abi: faucetAbi, functionName: 'claim', args: [addr], account: w.account!, chain: w.chain });
      await client.waitForTransactionReceipt({ hash });
      setState({ busy: false, text: `${token} received on ${ch.name}.` });
    } catch (e) {
      const t = errText(e);
      setState({ busy: false, bad: true, text: /insufficient funds|gas/i.test(t) ? `You need testnet ETH for gas first (see above).` : /TooSoon/.test(t) ? `You already claimed ${token} this hour.` : t });
    }
  };
  return <TokenMenu chainName={ch.name} gas={config.chains.filter(c => GAS_FAUCETS[c.key]).map(c => ({ name: c.name, url: GAS_FAUCETS[c.key] }))}
    stockUrl={external.size ? STOCK_TOKEN_FAUCETS[ch.key] : (STOCK_TOKEN_FAUCETS['robinhood-testnet'] ?? '')} stocks={[...external]}
    ours={ours} onClaim={claim} state={state} active={token} />;
}

/** "Get test tokens": one menu that says where each token comes from, in the order a newcomer needs them. */
function TokenMenu({ chainName, gas, stockUrl, stocks, ours, onClaim, state, active }: {
  chainName: string; gas: Array<{ name: string; url: string }>; stockUrl: string; stocks: string[]; ours: string[];
  onClaim: (t: string) => void; state: { busy: boolean; text: string; bad?: boolean }; active: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', off); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <span className="menu" ref={ref}>
      <button className="btn" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen(o => !o)}><Droplet className="i" />Get test tokens<ChevronDown className="i" /></button>
      {open && (
        <div className="menu-pop" role="menu">
          <span className="label" style={{ padding: '4px 10px' }}>1 · Gas (testnet ETH)</span>
          {gas.map(g => <a key={g.url} className="mi" role="menuitem" href={g.url} target="_blank" rel="noreferrer"><span className="row" style={{ gap: 8 }}><AssetIcon sym="ETH" size={20} /><span>ETH on {g.name}<small>Pays for transactions</small></span></span><ExternalLink className="i" /></a>)}
          <div className="sep" />
          <span className="label" style={{ padding: '4px 10px' }}>2 · {CASH_TOKEN.token} to subscribe</span>
          <a className="mi" role="menuitem" href={CASH_FAUCET} target="_blank" rel="noreferrer"><span className="row" style={{ gap: 8 }}><AssetIcon sym={CASH_TOKEN.token} size={20} /><span>{CASH_TOKEN.token} from Paxos<small>The stablecoin notes are paid in</small></span></span><ExternalLink className="i" /></a>
          {stockUrl && <>
            <div className="sep" />
            <span className="label" style={{ padding: '4px 10px' }}>Stock tokens (collateral, delivery)</span>
            <a className="mi" role="menuitem" href={stockUrl} target="_blank" rel="noreferrer"><span className="row" style={{ gap: 8 }}><AssetStack syms={stocks.length ? stocks : ['TSLA', 'AMZN', 'NFLX']} size={20} label={false} /><span>{(stocks.length ? stocks : ['TSLA', 'AMZN', 'NFLX']).join(', ')} from Robinhood<small>On Robinhood Chain testnet</small></span></span><ExternalLink className="i" /></a>
          </>}
          {ours.length > 0 && <>
            <div className="sep" />
            <span className="label" style={{ padding: '4px 10px' }}>Test tokens on {chainName}</span>
            {ours.map(t => <button key={t} className="mi" role="menuitem" style={{ border: 0, background: 'none', font: 'inherit', textAlign: 'left', cursor: 'pointer' }} disabled={state.busy} onClick={() => onClaim(t)}><span className="row" style={{ gap: 8 }}><AssetIcon sym={t} size={20} /><span>{t}<small>Claim once an hour</small></span></span><span className="xs muted">{state.busy && active === t ? 'Claiming…' : 'Claim'}</span></button>)}
          </>}
          {state.text && <div className={`notice ${state.bad ? 'err' : 'ok'}`} role="status" style={{ marginTop: 6 }}>{state.text}</div>}
        </div>
      )}
    </span>
  );
}
