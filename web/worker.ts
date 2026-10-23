/**
 * notes.markets: one Cloudflare Worker for the whole site.
 *
 *   /             the landing page (static, from dist/)
 *   /app/*        the app (static; client-side routes fall back to /app/index.html)
 *   /api/ai       the AI assistant, on Workers AI here (term sheet -> note, workflow edits, questions)
 *   /api/*        everything else, proxied to the API (services/api) on the server, through its tunnel
 *   /internal/email  the API's email relay: Cloudflare Email Service (the EMAIL send_email binding), guarded by
 *                    EMAIL_RELAY_SECRET. Answers 503 until Email Sending is onboarded for notes.markets.
 *
 * The browser only ever talks to this origin, so the API needs no CORS for the site, and live updates (SSE)
 * stream straight through.
 */
import { runAi } from '../packages/core/src/ai/pipeline';
import { workersAiRunner } from '../packages/core/src/ai/runner';
import type { WorkflowDraft } from '../packages/core/src/draft';

interface Env {
  ASSETS: { fetch(req: Request | string): Promise<Response> };
  AI: Parameters<typeof workersAiRunner>[0];
  AI_LIMIT: { limit(o: { key: string }): Promise<{ success: boolean }> };
  API_ORIGIN: string;
  SN_PROXY_SECRET?: string;
  /** Cloudflare Email Service (send_email binding); absent until Email Sending is onboarded and bound. */
  EMAIL?: { send(m: { to: string; from: string | { email: string; name?: string }; subject: string; html: string; text: string; headers?: Record<string, string> }): Promise<{ messageId: string }> };
  EMAIL_RELAY_SECRET?: string;
  EMAIL_FROM?: string;
}

/** Constant-time string comparison (Workers have no timingSafeEqual on strings). */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** The API's email relay. Exported for tests. */
export async function relayEmail(req: Request, env: Pick<Env, 'EMAIL' | 'EMAIL_RELAY_SECRET' | 'EMAIL_FROM'>): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  const given = req.headers.get('X-Email-Relay-Secret') ?? '';
  if (!env.EMAIL_RELAY_SECRET || !given || !sameSecret(given, env.EMAIL_RELAY_SECRET)) return json({ error: 'Not allowed.' }, 401);
  const b = await req.json().catch(() => null) as { to?: unknown; subject?: unknown; html?: unknown; text?: unknown } | null;
  const ok = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max;
  if (!b || !ok(b.to, 254) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.to)) || !ok(b.subject, 300) || !ok(b.html, 200_000) || !ok(b.text, 100_000)) {
    return json({ error: 'Send {to, subject, html, text}.' }, 400);
  }
  if (!env.EMAIL) return json({ error: 'Email Sending is not configured on this Worker (no EMAIL binding); onboard notes.markets in Email Service.' }, 503);
  try {
    const r = await env.EMAIL.send({
      to: String(b.to), from: { email: env.EMAIL_FROM ?? 'alerts@notes.markets', name: 'notes.markets' },
      subject: String(b.subject), html: String(b.html), text: String(b.text),
    });
    return json({ messageId: r.messageId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Not onboarded or paused: hold (503), the API retries later. Anything else: a failure for this email.
    const notReady = /E_SENDER_DOMAIN_NOT_AVAILABLE|E_ACCOUNT_SUSPENDED|not (onboarded|available)|paused/i.test(msg);
    return json({ error: msg }, notReady ? 503 : 502);
  }
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
    if (url.pathname === '/internal/email' && req.method === 'POST') return relayEmail(req, env);
    if (url.pathname.startsWith('/internal/')) return Response.json({ error: 'Not found' }, { status: 404 });
    if (url.pathname === '/api/ai' && req.method === 'POST') return ai(req, env);
    if (url.pathname.startsWith('/api/')) return proxy(req, env, url);
    if (url.pathname === '/app') return Response.redirect(`${url.origin}/app/`, 301);
    if (url.pathname.startsWith('/app/')) {
      // A file (assets, logos) is served as is; anything else is a client-side route (/app/note/…, /app/issue)
      // and gets the app shell.
      if (/\.[a-z0-9]+$/i.test(url.pathname)) return env.ASSETS.fetch(req);
      return env.ASSETS.fetch(new Request(`${url.origin}/app/`, req));
    }
    return env.ASSETS.fetch(req);
  },
};
