/**
 * The Worker's configuration: what the API serves (services/api's ApiConfig) and what the cron indexes. Both are
 * generated from deployments/*.json by scripts/server-config.ts (deployments/server/{api,indexer}.json) and
 * bundled into the Worker; `SN_CONFIG` (a JSON string var, e.g. for `wrangler dev` against a local fork)
 * replaces them.
 */
import { z } from 'zod';
import { ApiConfig } from '../../api/src/config';
import type { ChainConfig } from './ingest';

export { ApiConfig };

export const IndexerChain = z.object({
  key: z.string().regex(/^[a-z0-9-]{1,40}$/),
  family: z.literal('evm').default('evm'),
  chainId: z.number().int(),
  rpc: z.string().url(),
  engine: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  startBlock: z.number().int().nonnegative(),
  confirmations: z.number().int().nonnegative().optional(),
  finality: z.enum(['confirmations', 'finalized']).optional(),
  maxRange: z.number().int().positive().optional(),
}).passthrough();

export const EdgeConfig = z.object({
  api: ApiConfig,
  indexer: z.object({ chains: z.array(IndexerChain) }),
});
export type EdgeConfig = z.infer<typeof EdgeConfig>;

export function parseEdgeConfig(raw: unknown): EdgeConfig {
  return EdgeConfig.parse(raw);
}

export const indexerChains = (c: EdgeConfig): ChainConfig[] => c.indexer.chains.map(ch => ({ ...ch, engine: ch.engine as `0x${string}` }));
