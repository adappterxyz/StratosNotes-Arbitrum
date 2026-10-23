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
const api = {
  allowedOrigins: [SITE],
  trustProxy: true,
  ai: false, // the site's Worker answers /api/ai on Workers AI
  chains: deployed.map(c => ({
    key: c.key, rpc: c.rpc, engine: c.d.engine, lens: c.d.lens, fromBlock: c.d.block,
    stablecoin: { symbol: 'tUSD', address: c.d.tokens.tUSD, decimals: 6 },
    tokenFaucet: c.d.faucet, tokens: c.d.tokens,
  })),
};
mkdirSync('deployments/server', { recursive: true });
writeFileSync('deployments/server/indexer.json', JSON.stringify(indexer, null, 2) + '\n');
writeFileSync('deployments/server/api.json', JSON.stringify(api, null, 2) + '\n');
console.log(`deployments/server/{indexer,api}.json: ${deployed.map(c => c.key).join(', ')}`);
