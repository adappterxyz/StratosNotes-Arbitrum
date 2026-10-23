/**
 * notes.markets: one Cloudflare Worker for the whole site.
 *
 *   /             the landing page (static, from dist/)
 *   /app/*        the app (static; client-side routes fall back to /app/index.html)
 *   /api/ai       the AI assistant, on Workers AI here (term sheet -> note, workflow edits, questions)
 *   /api/*        everything else: served here from D1 (services/edge) when the DB binding is configured,
 *                 otherwise proxied to the API (services/api) on the server, through its tunnel
 *
 * With D1 (the `edge` environment in wrangler.jsonc), the Worker is the whole backend: the API reads D1, and
 * the cron (scheduled) indexes both chains into D1 every minute and sends due notifications through Cloudflare
 * Email Service. API_MODE = "proxy" keeps forwarding to the server during a cutover.
 *
 * The browser only ever talks to this origin, so the API needs no CORS for the site.
 */
import { runAi } from '../packages/core/src/ai/pipeline';
import { workersAiRunner } from '../packages/core/src/ai/runner';
import type { WorkflowDraft } from '../packages/core/src/draft';
import { createEdgeApp, type RateLimitBinding } from '../services/edge/src/api';
import { parseEdgeConfig, type EdgeConfig } from '../services/edge/src/config';
import { Store, type D1Database } from '../services/edge/src/d1';
import { bindingSender, type EmailBinding } from '../services/edge/src/notify';
import { runCron } from '../services/edge/src/scheduled';
import apiJson from '../deployments/server/api.json';
import indexerJson from '../deployments/server/indexer.json';

interface Env {
  ASSETS: { fetch(req: Request | string): Promise<Response> };
  AI: Parameters<typeof workersAiRunner>[0];
  AI_LIMIT: { limit(o: { key: string }): Promise<{ success: boolean }> };
  API_ORIGIN: string;
  SN_PROXY_SECRET?: string;
  /** D1: the read model, templates, subscriptions, outbox (the `edge` environment). */
  DB?: D1Database;
  /** "proxy" forwards /api/* to API_ORIGIN even with DB bound (cutover); anything else serves from D1. */
  API_MODE?: string;
  /** Per-minute read limit for the API (Workers rate-limiting binding). */
  READ_LIMIT?: RateLimitBinding;
  /** Cloudflare Email Service; sending is on only when EMAIL_SENDING = "on" (the domain must be onboarded). */
  EMAIL?: EmailBinding;
  EMAIL_SENDING?: string;
  EMAIL_FROM?: string;
  /** JSON { api, indexer } replacing the bundled deployments/server config (e.g. wrangler dev on a fork). */
  SN_CONFIG?: string;
  /** Dev chains only: the faucet signer for the mock stablecoin. */
  FAUCET_KEY?: string;
}

let configCache: { raw: string | undefined; cfg: EdgeConfig } | null = null;
function edgeConfig(env: Env): EdgeConfig {
  if (configCache && configCache.raw === env.SN_CONFIG) return configCache.cfg;
  const cfg = parseEdgeConfig(env.SN_CONFIG ? JSON.parse(env.SN_CONFIG) : { api: apiJson, indexer: indexerJson });
  configCache = { raw: env.SN_CONFIG, cfg };
  return cfg;
}

let appCache: { env: Env; app: ReturnType<typeof createEdgeApp> } | null = null;
function edgeApp(env: Env) {
  if (appCache?.env === env) return appCache.app;
  const app = createEdgeApp({
    store: () => new Store(env.DB!), config: edgeConfig(env).api, ai: !!env.AI,
    readLimit: env.READ_LIMIT, faucetKey: env.FAUCET_KEY as `0x${string}` | undefined,
  });
  appCache = { env, app };
  return app;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

async function ai(req: Request, env: Env): Promise<Response> {
  const origin = req.headers.get('Origin');
  if (origin && origin !== new URL(req.url).origin) return json({ error: 'Not allowed from this origin.' }, 403);
  const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (!(await env.AI_LIMIT.limit({ key: ip })).success) return json({ error: 'Too many AI requests; wait a minute and try again.' }, 429);
  const body = await req.json().catch(() => null) as { prompt?: string; draft?: WorkflowDraft } | null;
  const prompt = (body?.prompt ?? '').trim();
  if (!prompt) return json({ error: 'Say what you want: a note from terms, a change to the workflow, or a question.' }, 400);
  if (prompt.length > 4000) return json({ error: 'Keep the request under 4,000 characters.' }, 400);
  try {
    return json(await runAi(workersAiRunner(env.AI), { prompt, today: new Date().toISOString().slice(0, 10), draft: body?.draft }));
  } catch (e) {
    return json({ kind: 'error', error: e instanceof Error ? e.message : String(e) }, 502);
  }
}

/** Forward to the API with the caller's IP (trusted by the API only alongside the shared proxy secret). */
async function proxy(req: Request, env: Env, url: URL): Promise<Response> {
  const target = new URL(url.pathname + url.search, env.API_ORIGIN);
  const headers = new Headers(req.headers);
  headers.set('X-Forwarded-For', req.headers.get('CF-Connecting-IP') ?? '');
  if (env.SN_PROXY_SECRET) headers.set('X-SN-Proxy', env.SN_PROXY_SECRET);
  headers.delete('Host');
  try {
    return await fetch(target, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body, redirect: 'manual' });
  } catch {
    return json({ error: 'The StratosNotes API is unreachable right now; try again shortly.' }, 502);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // One canonical host: the earlier domain and www redirect to notes.markets.
    const host = new URL(req.url).hostname;
    if (host === 'notes.stratoslab.app' || host === 'www.notes.markets') {
      const to = new URL(req.url);
      to.hostname = 'notes.markets';
      return Response.redirect(to.toString(), 301);
    }
    const url = new URL(req.url);
    if (url.pathname === '/api/ai' && req.method === 'POST') return ai(req, env);
    if (url.pathname.startsWith('/api/')) {
      if (env.DB && env.API_MODE !== 'proxy') return edgeApp(env).fetch(req);
      return proxy(req, env, url);
    }
    if (url.pathname === '/app') return Response.redirect(`${url.origin}/app/`, 301);
    if (url.pathname.startsWith('/app/')) {
      // A file (assets, logos) is served as is; anything else is a client-side route (/app/note/…, /app/issue)
      // and gets the app shell.
      if (/\.[a-z0-9]+$/i.test(url.pathname)) return env.ASSETS.fetch(req);
      return env.ASSETS.fetch(new Request(`${url.origin}/app/`, req));
    }
    return env.ASSETS.fetch(req);
  },

  /** Every minute (the `edge` environment's cron): index both chains into D1, then send due notifications. */
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    if (!env.DB) return;
    const sender = env.EMAIL && env.EMAIL_SENDING === 'on' ? bindingSender(env.EMAIL, env.EMAIL_FROM ?? 'alerts@notes.markets') : null;
    const work = runCron({ store: new Store(env.DB), config: edgeConfig(env), sender }).then(r => {
      console.log(JSON.stringify({
        cron: 'indexer', ms: r.ms, queries: r.queries, sent: r.sent,
        chains: r.chains.map(ch => ({ chain: ch.chain, rpc: ch.rpcCalls, steps: ch.steps.length, events: ch.steps.reduce((a, x) => a + x.events, 0), to: ch.steps.at(-1)?.to, error: ch.error })),
      }));
    });
    ctx.waitUntil(work);
    await work;
  },
};
