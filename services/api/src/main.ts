/**
 * Run the API on Node:
 *   API_CONFIG=config.json DATABASE_URL=postgres://… PORT=8787 npx tsx src/main.ts
 * Optional environment: CF_ACCOUNT_ID + CF_AI_TOKEN (Workers AI, when the config enables "ai"), FAUCET_KEY
 * (dev chains with a faucet only), SN_PROXY_SECRET (trust X-Forwarded-For only from the site's Worker).
 */
import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import type { Hex } from 'viem';
import { restAiRunner } from '@sn/core/src/ai/rest-runner';
import { migrate, pgDb } from '@sn/indexer';
import { createApp } from './app';
import { ApiConfig } from './config';

const config = ApiConfig.parse(JSON.parse(readFileSync(process.env.API_CONFIG ?? 'config.json', 'utf8')));
const url = process.env.DATABASE_URL;
if (!url) throw new Error('set DATABASE_URL');
const db = pgDb(url);
await migrate(db);
const ai = config.ai && process.env.CF_ACCOUNT_ID && process.env.CF_AI_TOKEN ? restAiRunner(process.env.CF_ACCOUNT_ID, process.env.CF_AI_TOKEN) : null;
if (config.ai && !ai) console.warn('AI is enabled in the config but CF_ACCOUNT_ID / CF_AI_TOKEN are not set: /api/ai answers 503');
const faucetKey = process.env.FAUCET_KEY as Hex | undefined;
const app = createApp({
  db, config, ai, faucetKey, proxySecret: process.env.SN_PROXY_SECRET,
  clientIp: c => (c.env as { incoming?: { socket?: { remoteAddress?: string } } })?.incoming?.socket?.remoteAddress ?? 'unknown',
});
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? '127.0.0.1' }, i => console.log(`api listening on http://${i.address}:${i.port}`));
