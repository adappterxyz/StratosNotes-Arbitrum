/**
 * Sending the notification outbox from the cron, through Cloudflare Email Service (the Worker's EMAIL binding).
 *
 * What goes into the outbox (which events, which audience, which template) is decided by the BPMN notification
 * declarations and the notifier's pure functions from the email work; this module only delivers: each due row
 * is sent once to its address's verified email, retried with backoff on failure, and marked sent with the
 * provider's message id. The dedupe key's UNIQUE constraint means a replayed event can never queue a second
 * copy.
 *
 * With no sender configured (Email Sending not onboarded for the domain yet), rows stay pending and nothing is
 * written, so they go out once sending is enabled; reminders whose moment has passed are skipped then rather
 * than sent late (see `stale`).
 */
import type { Store } from './d1';

export interface OutgoingEmail { to: string; from: string; subject: string; html: string; text: string }
export interface EmailSender {
  from: string;
  send(m: OutgoingEmail): Promise<{ messageId: string }>;
}

/** The Workers EMAIL binding (Cloudflare Email Service): `send({ to, from, subject, html, text })`. */
export interface EmailBinding { send(m: OutgoingEmail): Promise<{ messageId?: string } | void> }

export function bindingSender(binding: EmailBinding, from: string): EmailSender {
  return {
    from,
    async send(m) {
      const r = await binding.send(m);
      return { messageId: (r && 'messageId' in r && r.messageId) || '' };
    },
  };
}

const MAX_ATTEMPTS = 6;
/** A reminder more than this late is dropped instead of sent. */
const STALE_SEC = 6 * 3600;

interface Row { id: number; address: string; kind: string; subject: string; html: string; text: string; attempts: number; not_before: number }

/** Send due rows; returns how many were sent. */
export async function drainOutbox(store: Store, sender: EmailSender | null, opts: { now: number; max: number }): Promise<number> {
  if (!sender || opts.max <= 0) return 0;
  const rows = await store.all<Row & { email: string | null; verified_at: number | null }>(
    `SELECT o.id, o.address, o.kind, o.subject, o.html, o.text, o.attempts, o.not_before, s.email, s.verified_at
       FROM outbox o LEFT JOIN subscriptions s ON s.address = o.address
      WHERE o.status = 'pending' AND o.next_attempt_at <= ?1 AND o.not_before <= ?1
      ORDER BY o.next_attempt_at LIMIT ?2`, [opts.now, Math.max(1, Math.floor(opts.max / 2))]);
  let sent = 0;
  for (const r of rows) {
    if (!r.email || !r.verified_at) {
      await store.run("UPDATE outbox SET status = 'skipped', error = 'no verified email' WHERE id = ?1", [r.id]);
      continue;
    }
    if (r.kind.endsWith('reminder') && opts.now - r.not_before > STALE_SEC) {
      await store.run("UPDATE outbox SET status = 'skipped', error = 'reminder no longer timely' WHERE id = ?1", [r.id]);
      continue;
    }
    try {
      const { messageId } = await sender.send({ to: r.email, from: sender.from, subject: r.subject, html: r.html, text: r.text });
      await store.run("UPDATE outbox SET status = 'sent', message_id = ?2, sent_at = ?3, attempts = attempts + 1, error = NULL WHERE id = ?1", [r.id, messageId, opts.now]);
      sent++;
    } catch (e) {
      const attempts = r.attempts + 1;
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      await store.run(
        'UPDATE outbox SET attempts = ?2, error = ?3, next_attempt_at = ?4, status = ?5 WHERE id = ?1',
        [r.id, attempts, msg, opts.now + 60 * 2 ** attempts, attempts >= MAX_ATTEMPTS ? 'failed' : 'pending']);
    }
  }
  return sent;
}

/** Queue a notification; a second call with the same dedupe key is a no-op. Returns whether it was queued. */
export async function enqueue(store: Store, n: { dedupeKey: string; address: string; kind: string; noteId?: string | null; subject: string; html: string; text: string; notBefore: number; now: number }): Promise<boolean> {
  const r = await store.run(
    `INSERT INTO outbox (dedupe_key, address, kind, note_id, subject, html, text, not_before, next_attempt_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9) ON CONFLICT (dedupe_key) DO NOTHING`,
    [n.dedupeKey, n.address.toLowerCase(), n.kind, n.noteId ?? null, n.subject, n.html, n.text, n.notBefore, n.now]);
  return (r.meta.changes ?? 0) > 0;
}
