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
const config = {
  schedule: target === 'production' ? '0 * * * * *' : '*/30 * * * * *',
  chains: chains.map(ch => {
    const d = existsSync(ch.file) ? JSON.parse(readFileSync(ch.file, 'utf8')) as { engine: string; lens: string } : { engine: ZERO, lens: ZERO };
    return {
      chainSelectorName: ch.chainSelectorName, engine: d.engine, lens: d.lens,
      // A coupon to a full book (62 holders) measured 2.22M gas of execution; the margin covers Arbitrum's L1 data gas.
      gasLimit: '8000000', fromPid: 1, scan: 200, maxProcesses: 50,
    };
  }),
  maxReportsPerRun: 5,
  // Feeds are read at a finalized block (Ethereum ~13 min behind the head; Arbitrum One finalizes with L1).
  finalityAllowanceSec: 1800,
};
const out = `cre/notes-keeper-evm/config.${target === 'staging' ? 'staging' : target === 'production' ? 'production' : 'local-fork'}.json`;
writeFileSync(out, JSON.stringify(config, null, 2) + '\n');
console.log(`${out}: ${config.chains.map(c => `${c.chainSelectorName} engine ${c.engine}`).join(', ')}`);
