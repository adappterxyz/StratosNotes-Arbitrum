/**
 * Write the server configs from deployments/<chain>.json:
 *   deployments/server/indexer.json   services/indexer (INDEXER_CONFIG)
 *   deployments/server/api.json       services/api (API_CONFIG)
 *
 *   npx tsx scripts/server-config.ts            # SITE=https://notes.markets by default
 *
 * No secrets: DATABASE_URL, SN_PROXY_SECRET and the rest come from the environment (docs/DEPLOY.md).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const SITE = process.env.SITE ?? 'https://notes.markets';
const CHAINS = [
  { key: 'arbitrum-sepolia', chainId: 421614, rpc: process.env.RPC_ARBITRUM_SEPOLIA ?? 'https://sepolia-rollup.arbitrum.io/rpc' },
  { key: 'robinhood-testnet', chainId: 46630, rpc: process.env.RPC_ROBINHOOD_TESTNET ?? 'https://rpc.testnet.chain.robinhood.com' },
];
const deployed = CHAINS.filter(c => existsSync(`deployments/${c.key}.json`)).map(c => ({
  ...c, d: JSON.parse(readFileSync(`deployments/${c.key}.json`, 'utf8')) as { engine: string; lens: string; block: number; faucet: string; tokens: Record<string, string> },
}));
if (!deployed.length) throw new Error('no deployments/<chain>.json yet: run scripts/deploy-testnets.sh');

const indexer = {
  chains: deployed.map(c => ({
    key: c.key, family: 'evm', chainId: c.chainId, rpc: c.rpc, engine: c.d.engine, startBlock: c.d.block,
    // Arbitrum chains: read 'finalized' would lag ~L1 finality; a few confirmations is the demo-friendly depth.
    confirmations: 3, maxRange: 2000, pollMs: 2000,
  })),
};
/** Paxos testnet USDG (6 decimals), verified on-chain 2026-10-24. */
const USDG: Record<string, string> = {
  'arbitrum-sepolia': '0xFFC95faa3d63Cde504a05B567C600B78C0b41892',
  'robinhood-testnet': '0x7E955252E15c84f5768B83c41a71F9eba181802F',
};
/** Robinhood Chain testnet's own stock tokens (18 decimals). */
const REAL_STOCKS: Record<string, Record<string, string>> = {
  'robinhood-testnet': {
    TSLA: '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E',
    AMZN: '0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02',
    NFLX: '0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93',
  },
};
/** Cross-chain collateral (deployments/crosschain-testnet.json): receipts are tokens on the home chain; both
 * sides get the addresses the app needs to lock, follow and redeem. */
type CrossChain = { home: { chain: string; selector: string; router: string; gateway: string }; remotes: Array<{ chain: string; selector: string; router: string; vault: string; receipts: Record<string, { receipt: string; token: string; decimals: number; valuedAs: string | null }> }> };
const XC: CrossChain | null = existsSync('deployments/crosschain-testnet.json') ? JSON.parse(readFileSync('deployments/crosschain-testnet.json', 'utf8')) : null;
const receiptsOn = (key: string) => (XC && XC.home.chain === key
  ? Object.fromEntries(XC.remotes.flatMap(r => Object.entries(r.receipts).map(([sym, v]) => [sym, v.receipt]))) : {});
const crossChainOn = (key: string) => {
  if (!XC) return null;
  if (XC.home.chain === key) return { role: 'home', gateway: XC.home.gateway, router: XC.home.router, selector: XC.home.selector,
    remotes: XC.remotes.map(r => ({ chain: r.chain, selector: r.selector, vault: r.vault, receipts: r.receipts })) };
  const r = XC.remotes.find(x => x.chain === key);
  return r ? { role: 'asset', vault: r.vault, router: r.router, selector: r.selector, home: { chain: XC.home.chain, gateway: XC.home.gateway, selector: XC.home.selector } } : null;
};
const api = {
  allowedOrigins: [SITE],
  trustProxy: true,
  ai: false, // the site's Worker answers /api/ai on Workers AI
  chains: deployed.map(c => ({
    key: c.key, rpc: c.rpc, engine: c.d.engine, lens: c.d.lens, fromBlock: c.d.block,
    // Cash is Paxos's testnet USDG (docs.paxos.com/guides/stablecoin/usdg/testnet); tUSD stays for older notes.
    stablecoin: { symbol: 'USDG', address: USDG[c.key], decimals: 6 },
    tokenFaucet: c.d.faucet, tokens: { ...c.d.tokens, USDG: USDG[c.key], ...(REAL_STOCKS[c.key] ?? {}), ...receiptsOn(c.key) },
    ...(crossChainOn(c.key) ? { crossChain: crossChainOn(c.key) } : {}),
  })),
};
mkdirSync('deployments/server', { recursive: true });
writeFileSync('deployments/server/indexer.json', JSON.stringify(indexer, null, 2) + '\n');
writeFileSync('deployments/server/api.json', JSON.stringify(api, null, 2) + '\n');
console.log(`deployments/server/{indexer,api}.json: ${deployed.map(c => c.key).join(', ')}`);
