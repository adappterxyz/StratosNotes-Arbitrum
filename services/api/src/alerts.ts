/**
 * Verified emails and email alerts (docs/NOTIFICATIONS.md).
 *
 *   POST /api/alerts/start          {address, email, categories, issuedAt, signature}  -> a 6-digit code (and a link) by email
 *   POST /api/alerts/verify         {address, code}                                    -> verified; salt and hash fixed
 *   GET  /api/alerts/confirm?token=                                                    -> the link alternative to the code
 *   POST /api/alerts/attestation    {address, chain}                                   -> the verifier's EIP-712 attestation to submit on-chain
 *   GET  /api/alerts/status?address=                                                   -> verified? masked email, preferences
 *   POST /api/alerts/preferences    {address, categories, issuedAt, signature}
 *   POST /api/alerts/salt           {address, issuedAt, signature}                     -> the person's email, salt and hash (proof)
 *   POST /api/alerts/unsubscribe    {token}                                            -> one click, from any alert
 *   GET  /api/dev/emails?to=        (only with the in-memory dev sender)               -> what was "sent", for local e2e
 *
 * Plus the notifier's tick (plan every recently active note, queue, send), run in this process on an interval.
 * A verified email is required to issue and to subscribe: the app gates its buttons on /status, and the engine
 * enforces it on-chain when requireEmail is on (the attestation binds keccak256(abi.encode(salt, email))).
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { createPublicClient, encodeAbiParameters, http, isAddress, keccak256, verifyMessage, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { NOTIFY_CATEGORIES } from '@sn/core';
import { CHAINS, flowEngineAbi, noteView, type NoteState } from '@sn/sdk';
import { loadDef, type Db } from '@sn/indexer';
import {
  alertsMessage, AlertsStore, drain, isEmail, maskEmail, normEmail, planNote, render, TEMPLATES, type EmailSender, type MockSender, type NoteEvent,
} from '@sn/notifier';
import type { ApiConfig } from './config';
import type { RateLimiter } from './ratelimit';

export interface AlertsDeps {
  store: AlertsStore;
  sender: EmailSender;
  /** The engine's `verifier` key (hex): signs attestations. Null: verification works, attestations are refused. */
  verifierKey: Hex | null;
  /** Public site origin, for links in emails (https://notes.markets). */
  siteUrl: string;
  /** The in-memory dev sender, exposed at /api/dev/emails for local e2e. */
  devMailbox?: MockSender;
  /** The engine's current attestation nonce for a holder (tests inject it; default: read the chain). */
  nonceOf?: (chainKey: string, holder: Address) => Promise<{ chainId: number; nonce: bigint }>;
}

const CODE_TTL = 600, MAX_CODE_ATTEMPTS = 5, SIG_SKEW = 600, ATTEST_TTL = 365 * 86_400;
const Address_ = z.string().refine(isAddress, 'must be an address').transform(a => a.toLowerCase());
const Categories = z.array(z.enum(NOTIFY_CATEGORIES as [string, ...string[]])).max(4);
const Signed = { address: Address_, issuedAt: z.number().int(), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) };
const StartBody = z.object({ ...Signed, email: z.string().max(254), categories: Categories });
const PrefsBody = z.object({ ...Signed, categories: Categories });
const SaltBody = z.object(Signed);
const VerifyBody = z.object({ address: Address_, code: z.string().regex(/^\d{6}$/) });
const AttestBody = z.object({ address: Address_, chain: z.string().regex(/^[a-z0-9-]{1,40}$/) });

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const sameHex = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** keccak256(abi.encode(bytes32 salt, string email)): what the engine stores for a verified email. */
export const emailHashOf = (salt: Hex, email: string) => keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'string' }], [salt, normEmail(email)]));

export function alertsRoutes(app: Hono, deps: AlertsDeps, ctx: { config: ApiConfig; limiter: RateLimiter; ipOf: (c: Context) => string; now: () => number }) {
  const { store, sender } = deps;
  const sec = () => Math.floor(ctx.now() / 1000);
  const err = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 429 | 502 | 503, error: string) => c.json({ error }, status);
  const appUrl = `${deps.siteUrl.replace(/\/$/, '')}/app`;
  const clients = new Map<string, ReturnType<typeof createPublicClient>>();
  const nonceOf = deps.nonceOf ?? (async (chainKey: string, holder: Address) => {
    const ch = ctx.config.chains.find(x => x.key === chainKey)!;
    let cl = clients.get(chainKey);
    if (!cl) { cl = createPublicClient({ transport: http(ch.rpc) }); clients.set(chainKey, cl); }
    const [chainId, [, , nonce]] = await Promise.all([cl.getChainId(), cl.readContract({ address: ch.engine as Address, abi: flowEngineAbi, functionName: 'emailOf', args: [holder] }) as Promise<readonly [Hex, bigint, bigint]>]);
    return { chainId, nonce: BigInt(nonce) };
  });

  async function checkSig(c: Context, a: { address: string; issuedAt: number; signature: string }, message: string): Promise<Response | null> {
    if (Math.abs(sec() - a.issuedAt) > SIG_SKEW) return err(c, 401, 'The signature is too old; sign again.');
    const ok = await verifyMessage({ address: a.address as Address, message, signature: a.signature as Hex }).catch(() => false);
    return ok ? null : err(c, 401, 'The signature does not match this wallet.');
  }

  async function sendCode(address: string, email: string, code: string, linkToken: string) {
    const r = render(TEMPLATES.code, { code, link: `${appUrl}/alerts/confirm?token=${linkToken}` });
    await sender.send({ to: email, ...r });
    void address;
  }

  app.post('/api/alerts/start', async c => {
    const ip = ctx.ipOf(c);
    if (!ctx.limiter.take('alerts-start-ip', ip, 10, 3_600_000)) return err(c, 429, 'Too many verification emails from here; try again in an hour.');
    const b = StartBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return err(c, 400, b.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
    const email = normEmail(b.data.email);
    if (!isEmail(email)) return err(c, 400, 'That does not look like an email address.');
    const bad = await checkSig(c, b.data, alertsMessage({ action: 'verify', address: b.data.address, email, categories: b.data.categories, issuedAt: b.data.issuedAt }));
    if (bad) return bad;
    if (!ctx.limiter.take('alerts-start-addr', b.data.address, 5, 3_600_000)) return err(c, 429, 'Too many codes for this wallet; try again in an hour.');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const link = randomBytes(32).toString('hex');
    const existing = await store.binding(b.data.address);
    await store.startVerification({
      address: b.data.address, email, categories: b.data.categories, codeHash: sha(`${b.data.address}:${code}`), codeExpires: sec() + CODE_TTL,
      linkTokenHash: sha(link), unsubscribeToken: existing?.unsubscribeToken ?? randomBytes(24).toString('hex'), now: sec(),
    });
    try { await sendCode(b.data.address, email, code, link); } catch (e) {
      return err(c, 503, `We could not send the email right now (${e instanceof Error ? e.message : 'unknown error'}). Try again shortly.`);
    }
    return c.json({ sent: true, to: maskEmail(email), expiresIn: CODE_TTL });
  });

  async function complete(address: string) {
    const b = await store.binding(address);
    if (!b?.pendingEmail) return null;
    const salt = `0x${randomBytes(32).toString('hex')}` as Hex;
    await store.completeVerification(address, salt, emailHashOf(salt, b.pendingEmail), sec());
    return store.binding(address);
  }

  app.post('/api/alerts/verify', async c => {
    if (!ctx.limiter.take('alerts-verify-ip', ctx.ipOf(c), 30, 3_600_000)) return err(c, 429, 'Too many attempts; try again later.');
    const b = VerifyBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return err(c, 400, 'Enter the 6-digit code from the email.');
    const cur = await store.binding(b.data.address);
    if (!cur?.pendingEmail || !cur.codeHash) return err(c, 404, 'No verification is waiting for this wallet; ask for a new code.');
    if (cur.codeAttempts >= MAX_CODE_ATTEMPTS) return err(c, 429, 'Too many wrong codes; ask for a new one.');
    if ((cur.codeExpires ?? 0) < sec()) return err(c, 401, 'That code has expired; ask for a new one.');
    await store.countAttempt(b.data.address, sec());
    if (!sameHex(sha(`${b.data.address}:${b.data.code}`), cur.codeHash)) return err(c, 401, 'That code is not right; check the email and try again.');
    const done = await complete(b.data.address);
    return c.json({ verified: true, email: maskEmail(done!.email!), emailHash: done!.emailHash });
  });

  app.get('/api/alerts/confirm', async c => {
    const token = c.req.query('token') ?? '';
    if (!/^[0-9a-f]{64}$/.test(token)) return err(c, 400, 'This link is not valid.');
    const b = await store.byLinkToken(sha(token));
    if (!b?.pendingEmail || (b.codeExpires ?? 0) < sec()) return err(c, 404, 'This link has expired or was already used; ask for a new code.');
    const done = await complete(b.address);
    return c.json({ verified: true, address: done!.address, email: maskEmail(done!.email!) });
  });

  app.post('/api/alerts/attestation', async c => {
    const b = AttestBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return err(c, 400, 'Send {address, chain}.');
    if (!deps.verifierKey) return err(c, 503, 'On-chain email attestations are not enabled on this server.');
    const ch = ctx.config.chains.find(x => x.key === b.data.chain);
    if (!ch) return err(c, 404, 'Unknown chain.');
    const bind = await store.binding(b.data.address);
    if (!bind?.verifiedAt || !bind.emailHash) return err(c, 403, 'Verify an email for this wallet first.');
    let chainId: number, nonce: bigint;
    try { ({ chainId, nonce } = await nonceOf(ch.key, b.data.address as Address)); } catch {
      return err(c, 502, 'Could not read the chain right now; try again.');
    }
    const expiry = BigInt(sec() + ATTEST_TTL);
    const signature = await privateKeyToAccount(deps.verifierKey).signTypedData({
      domain: { name: 'notes.markets', version: '1', chainId, verifyingContract: ch.engine as Address },
      types: { EmailAttestation: [{ name: 'holder', type: 'address' }, { name: 'emailHash', type: 'bytes32' }, { name: 'expiry', type: 'uint64' }, { name: 'nonce', type: 'uint256' }] },
      primaryType: 'EmailAttestation',
      message: { holder: b.data.address as Address, emailHash: bind.emailHash as Hex, expiry, nonce },
    });
    return c.json({ chain: ch.key, chainId, engine: ch.engine, holder: b.data.address, emailHash: bind.emailHash, expiry: Number(expiry), nonce: nonce.toString(), signature });
  });

  app.get('/api/alerts/status', async c => {
    const a = Address_.safeParse(c.req.query('address') ?? '');
    if (!a.success) return err(c, 400, 'address: must be an address');
    const b = await store.binding(a.data);
    return c.json({
      address: a.data,
      verified: !!b?.verifiedAt,
      email: b?.email ? maskEmail(b.email) : null,
      emailHash: b?.emailHash ?? null,
      pending: b?.pendingEmail ? maskEmail(b.pendingEmail) : null,
      categories: b?.unsubscribed ? [] : b?.categories ?? [],
      unsubscribed: !!b?.unsubscribed,
    });
  });

  app.post('/api/alerts/preferences', async c => {
    const b = PrefsBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return err(c, 400, b.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
    const bad = await checkSig(c, b.data, alertsMessage({ action: 'preferences', address: b.data.address, categories: b.data.categories, issuedAt: b.data.issuedAt }));
    if (bad) return bad;
    if (!(await store.binding(b.data.address))?.verifiedAt) return err(c, 404, 'Verify an email for this wallet first.');
    await store.setCategories(b.data.address, b.data.categories, sec());
    return c.json({ ok: true, categories: b.data.categories });
  });

  app.post('/api/alerts/salt', async c => {
    const b = SaltBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return err(c, 400, 'Send {address, issuedAt, signature}.');
    const bad = await checkSig(c, b.data, alertsMessage({ action: 'salt', address: b.data.address, issuedAt: b.data.issuedAt }));
    if (bad) return bad;
    const bind = await store.binding(b.data.address);
    if (!bind?.verifiedAt) return err(c, 404, 'This wallet has no verified email.');
    return c.json({ address: bind.address, email: bind.email, salt: bind.salt, emailHash: bind.emailHash, formula: 'keccak256(abi.encode(bytes32 salt, string lowercase(trim(email))))' });
  });

  app.post('/api/alerts/unsubscribe', async c => {
    const b = z.object({ token: z.string().regex(/^[0-9a-f]{48}$/) }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return err(c, 400, 'This link is not valid.');
    return (await store.unsubscribe(b.data.token, sec())) ? c.json({ ok: true }) : err(c, 404, 'This link is not valid.');
  });

  if (deps.devMailbox) {
    const box = deps.devMailbox;
    app.get('/api/dev/emails', c => {
      const to = (c.req.query('to') ?? '').toLowerCase();
      return c.json({ emails: box.sent.filter(e => !to || e.to.toLowerCase() === to).slice(-20).map(e => ({ to: e.to, subject: e.subject, text: e.text })) });
    });
  }
}

/**
 * One notifier pass: plan every note touched in the last two days (or still running), queue the emails meant for
 * verified addresses, send what is due. Returns counts for logs.
 */
export async function notifierTick(db: Db, deps: AlertsDeps, now: number, chainLabel: (key: string) => string) {
  const appUrl = `${deps.siteUrl.replace(/\/$/, '')}/app`;
  const rows = await db.query<{ id: string; chain: string; definition: string; state: NoteState | string }>(
    'SELECT id, chain, definition, state FROM notes WHERE status = 0 OR updated_at >= $1', [now - 2 * 86_400]);
  let queued = 0;
  for (const r of rows) {
    const s = typeof r.state === 'string' ? JSON.parse(r.state) as NoteState : r.state;
    const def = await loadDef(db, r.chain, r.definition);
    if (!def) continue;
    const evs = await db.query<{ seq: string; tx: string; ts: string; name: string; data: Record<string, unknown> }>(
      'SELECT seq, tx, ts, name, data FROM events WHERE note_id = $1 ORDER BY seq', [r.id]);
    const events: NoteEvent[] = evs.map(e => ({ seq: Number(e.seq), tx: e.tx, ts: Number(e.ts), name: e.name, data: typeof e.data === 'string' ? JSON.parse(e.data) : e.data }));
    const planned = planNote({ noteId: r.id, chainLabel: chainLabel(r.chain), link: `${appUrl}/note/${encodeURIComponent(r.id)}`, def, state: s, view: noteView(def, s, now), events, now });
    if (!planned.length) continue;
    const verified = new Set((await deps.store.verified([...new Set(planned.map(p => p.address))])).map(b => b.address));
    queued += await deps.store.enqueue(planned.filter(p => verified.has(p.address)).map(p => ({
      dedupe: p.dedupe, address: p.address, noteId: r.id, category: p.category,
      payload: { template: p.template, subject: p.subject, body: p.body, vars: p.vars }, sendAfter: p.sendAfter, expiresAt: p.expiresAt,
    })), now);
  }
  const sent = await drain(deps.store, deps.sender, { now, unsubscribeUrl: t => `${appUrl}/alerts/unsubscribe?token=${t}` });
  return { notes: rows.length, queued, ...sent };
}

export const chainLabelOf = (key: string) => CHAINS[key]?.name ?? key;
