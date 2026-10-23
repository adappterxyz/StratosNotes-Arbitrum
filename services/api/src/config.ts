/**
 * API configuration (a JSON file, with secrets from the environment only).
 *
 * {
 *   "allowedOrigins": ["https://notes.markets"],
 *   "trustProxy": true,                       // take the client IP from X-Forwarded-For (behind a load balancer)
 *   "chains": [{ "key": "arbitrum-sepolia", "rpc": "https://…", "engine": "0x…", "lens": "0x…", "fromBlock": 123,
 *                "stablecoin": { "symbol": "USDC", "address": "0x…", "decimals": 6 },
 *                "faucet": { "token": "0x…", "amount": "2000" } }],     // dev chains only: mints a MockERC20
 *   "ai": true                                 // needs CF_ACCOUNT_ID and CF_AI_TOKEN in the environment
 * }
 */
import { z } from 'zod';

const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const ChainCfg = z.object({
  key: z.string().regex(/^[a-z0-9-]{1,40}$/),
  /** The RPC the app's wallet and reads use (public). */
  rpc: z.string().url(),
  engine: addr,
  lens: addr,
  fromBlock: z.number().int().nonnegative().default(0),
  stablecoin: z.object({ symbol: z.string(), address: addr, decimals: z.number().int().min(0).max(36) }),
  /** Dev chains only: the API mints this MockERC20 to callers (the key comes from FAUCET_KEY). */
  faucet: z.object({ token: addr, amount: z.string().regex(/^\d+$/) }).optional(),
  /** Testnets: the on-chain TokenFaucet (callers claim from it with their own wallet) and the test tokens by
   * symbol (tUSD, tETH, tTSLA…), which physically settled notes deliver. From deployments/<chain>.json. */
  tokenFaucet: addr.optional(),
  tokens: z.record(addr).default({}),
});
export type ChainCfg = z.infer<typeof ChainCfg>;

export const ApiConfig = z.object({
  allowedOrigins: z.array(z.string().url()).default([]),
  trustProxy: z.boolean().default(false),
  chains: z.array(ChainCfg),
  ai: z.boolean().default(false),
  limits: z.object({
    readsPerMinute: z.number().default(600),
    aiPerHour: z.number().default(60),
    templatesPerHour: z.number().default(20),
    faucetPerHour: z.number().default(6),
    streamsPerIp: z.number().default(10),
  }).default({}),
});
export type ApiConfig = z.infer<typeof ApiConfig>;
