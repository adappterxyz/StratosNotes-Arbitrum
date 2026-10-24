/**
 * Write the CRE keeper's config for a target from deployments/<chain>.json:
 *
 *   npx tsx scripts/cre-config.ts staging       # arbitrum-sepolia + robinhood-testnet
 *   npx tsx scripts/cre-config.ts production    # arbitrum-one (Robinhood mainnet has no CRE yet)
 *   npx tsx scripts/cre-config.ts local-fork deployments/local/arbitrum-fork.json
 *
 * A chain without a deployment file gets the zero address, which the workflow refuses (fails closed).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const ZERO = '0x0000000000000000000000000000000000000000';
const TARGETS: Record<string, Array<{ file: string; chainSelectorName: string }>> = {
  staging: [
    { file: 'deployments/arbitrum-sepolia.json', chainSelectorName: 'ethereum-testnet-sepolia-arbitrum-1' },
    { file: 'deployments/robinhood-testnet.json', chainSelectorName: 'robinhood-testnet' },
  ],
  production: [{ file: 'deployments/arbitrum-one.json', chainSelectorName: 'ethereum-mainnet-arbitrum-1' }],
  'local-fork': [{ file: process.argv[3] ?? 'deployments/local/arbitrum-fork.json', chainSelectorName: 'ethereum-testnet-sepolia-arbitrum-1' }],
};
const target = process.argv[2];
const chains = TARGETS[target];
if (!chains) throw new Error(`target: ${Object.keys(TARGETS).join(' | ')}`);
const CRE_NAMES: Record<string, string> = { 'arbitrum-sepolia': 'ethereum-testnet-sepolia-arbitrum-1', 'robinhood-testnet': 'robinhood-testnet' };
function crossChainVaults() {
  const x = JSON.parse(readFileSync('deployments/crosschain-testnet.json', 'utf8')) as {
    home: { chain: string }; remotes: Array<{ chain: string; vault: string; receipts: Record<string, { receipt: string; token: string }> }>;
  };
  return x.remotes.flatMap(r => Object.entries(r.receipts).map(([label, v]) => ({
    homeChain: CRE_NAMES[x.home.chain], receipt: v.receipt, assetChain: CRE_NAMES[r.chain], vault: r.vault, token: v.token,
    label, stateBlock: 'latest' as const,
  })));
}
/** Earlier engines whose notes are still running (deployments/archive/<v>/<chain>.json): the keeper keeps
 * driving them to maturity after a redeploy. Staging only; LEGACY=v3,... (default v3 when the folder exists). */
const legacyEngines = (ch: { file: string; chainSelectorName: string }) => (target !== 'staging' ? [] : (process.env.LEGACY ?? 'v3').split(',').filter(Boolean)
  .map(v => ch.file.replace('deployments/', `deployments/archive/${v}/`)).filter(f => existsSync(f))
  .map(f => ({ file: f, chainSelectorName: ch.chainSelectorName })));
const config = {
  schedule: target === 'production' ? '0 * * * * *' : '*/30 * * * * *',
  // A chain not deployed yet is left out, so staging can go live one chain at a time: the workflow refuses a zero
  // address, and listing one would stop every run. Production and local forks keep every entry.
  chains: chains.filter(ch => target !== 'staging' || existsSync(ch.file)).flatMap(ch => [ch, ...legacyEngines(ch)]).map(ch => {
    const d = existsSync(ch.file) ? JSON.parse(readFileSync(ch.file, 'utf8')) as { engine: string; lens: string } : { engine: ZERO, lens: ZERO };
    return {
      chainSelectorName: ch.chainSelectorName, engine: d.engine, lens: d.lens,
      // A coupon to a full book (62 holders) measured 2.22M gas of execution; the margin covers Arbitrum's L1 data gas.
      gasLimit: '8000000', fromPid: 1, scan: 200, maxProcesses: 50,
      // Public testnet RPCs don't serve recent historical state, so staging reads the engine at the latest block.
      ...(target === 'staging' ? { stateBlock: 'latest' } : {}),
    };
  }),
  maxReportsPerRun: 5,
  // Cross-chain collateral (docs/CROSS-CHAIN.md): every run, check that each Robinhood vault still backs the
  // receipts outstanding on Arbitrum. Staging only, from deployments/crosschain-testnet.json.
  ...(target === 'staging' && existsSync('deployments/crosschain-testnet.json') ? { vaults: crossChainVaults() } : {}),
  // Feeds are read at a finalized block (Ethereum ~13 min behind the head; Arbitrum One finalizes with L1).
  finalityAllowanceSec: 1800,
};
const out = `cre/notes-keeper-evm/config.${target === 'staging' ? 'staging' : target === 'production' ? 'production' : 'local-fork'}.json`;
writeFileSync(out, JSON.stringify(config, null, 2) + '\n');
console.log(`${out}: ${config.chains.map(c => `${c.chainSelectorName} engine ${c.engine}`).join(', ')}`);
