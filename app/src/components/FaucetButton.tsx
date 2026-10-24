/**
 * Test tokens. On a testnet with a TokenFaucet the connected wallet claims them itself (tUSD to subscribe, and
 * tETH, tBTC, tTSLA… for a physically settled note's delivery reserve): one claim per token per hour, gas paid
 * by the wallet. On a local dev chain the API mints its mock stablecoin instead. A chain's own tokens (Robinhood
 * Chain's TSLA, AMZN, NFLX) are not ours to hand out: the button links to that chain's faucet for them.
 */
import { useState } from 'react';
import { Droplet, ExternalLink } from 'lucide-react';
import { EXTERNAL_TOKENS, STOCK_TOKEN_FAUCETS } from '@sn/core';
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
  const [token, setToken] = useState('tUSD');
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
  const symbols = [...Object.keys(ch.tokens).filter(s => !external.has(s)), ...external];
  const outside = external.has(token) ? STOCK_TOKEN_FAUCETS[ch.key] : undefined;
  const claim = async () => {
    const addr = ch.tokens[token];
    if (!addr || !ch.tokenFaucet) return;
    setState({ busy: true, text: `Claiming ${token} on ${ch.name}…` });
    try {
      const w = await signer(ch.key);
      const client = byKey[ch.key].client;
      const hash = await w.writeContract({ address: ch.tokenFaucet, abi: faucetAbi, functionName: 'claim', args: [addr], account: w.account!, chain: w.chain });
      await client.waitForTransactionReceipt({ hash });
      setState({ busy: false, text: `${token} received on ${ch.name}.` });
    } catch (e) {
      const t = errText(e);
      setState({ busy: false, bad: true, text: /insufficient funds|gas/i.test(t) && GAS_FAUCETS[ch.key] ? `You need testnet ETH for gas first: ${GAS_FAUCETS[ch.key]}` : /TooSoon/.test(t) ? `You already claimed ${token} this hour.` : t });
    }
  };
  return (
    <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
      {status}
      <select aria-label="Test token" value={token} onChange={e => setToken(e.target.value)} disabled={state.busy}>
        {symbols.map(s => <option key={s} value={s}>{external.has(s) ? `${s} (${ch.name})` : s}</option>)}
      </select>
      {outside
        ? <a className="btn" href={outside} target="_blank" rel="noreferrer" title={`${ch.name}'s own ${token}: claimed from its faucet, not ours`}><ExternalLink className="i" />Get test {token} from Robinhood's faucet</a>
        : <button className="btn" onClick={claim} disabled={state.busy} title={`Claim test ${token} on ${ch.name} (once an hour); gas is paid in testnet ETH`}><Droplet className="i" />Get {token}</button>}
    </span>
  );
}
