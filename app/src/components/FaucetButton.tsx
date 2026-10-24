/**
 * Test tokens. The cash leg is USDG, which Paxos hands out (we cannot mint it): the default choice links to the Paxos
 * faucet. On a testnet with our TokenFaucet the connected wallet claims our own test tokens itself (tETH, tBTC,
 * tTSLA… for delivery and collateral): one claim per token per hour, gas paid by the wallet. A chain's own tokens
 * (Robinhood Chain's TSLA, AMZN, NFLX) come from that chain's faucet, linked. tUSD, our old test dollar, is not
 * offered (it only settles notes issued before USDG). On a local dev chain the API mints its mock stablecoin.
 */
import { useState } from 'react';
import { Droplet, ExternalLink } from 'lucide-react';
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
  const ours = Object.keys(ch.tokens).filter(s => !external.has(s) && s !== TEST_CASH_TOKEN.token && s !== CASH_TOKEN.token);
  const symbols = [CASH_TOKEN.token, ...ours, ...external];
  // Where a token comes from when it is not ours to hand out.
  const outside = token === CASH_TOKEN.token ? { url: CASH_FAUCET, who: 'Paxos' }
    : external.has(token) ? { url: STOCK_TOKEN_FAUCETS[ch.key], who: 'Robinhood' } : undefined;
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
        ? <a className="btn" href={outside.url} target="_blank" rel="noreferrer" title={`Test ${token} is handed out by ${outside.who}, not by notes.markets`}><ExternalLink className="i" />Get test {token} from {outside.who}</a>
        : <button className="btn" onClick={claim} disabled={state.busy} title={`Claim test ${token} on ${ch.name} (once an hour); gas is paid in testnet ETH`}><Droplet className="i" />Get {token}</button>}
    </span>
  );
}
