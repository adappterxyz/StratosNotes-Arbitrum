# Verified emails and email alerts

notes.markets emails issuers and holders about the events that need them: a payment to fund, a missed payment,
a margin call, a payout, a default, collateral released, a strike fixed. Issuing and subscribing need a verified
email, so those emails always have somewhere to go.

## How it works

```
BPMN step  ──declares──▶  notify (when · to whom · category · template)  ──compiled into──▶  definition META
                                                                                              │
engine events ─▶ indexer (read model) ─▶ notifier tick (plan · dedupe · queue) ─▶ outbox ─▶ Worker /internal/email
                                                                                              │
                                                                       Cloudflare Email Service (alerts@notes.markets)
```

1. **Declared on the BPMN.** Any step can carry `notify` (packages/core/src/notify.ts), a list of declarations:
   - `on`: `waiting` (the step holds a token: a user task window, a receive task, a timer), `done` (the step
     completed), `enter` (a gateway or end event was reached);
   - `audience`: `issuer`, `holders`, `subscribers` (everyone who ever held units), or `role:<pool>`;
   - `category`: `due`, `payouts`, `risk`, `book` (the recipient's preferences);
   - `template` (a built-in name), or its own `subject` and `body` with `{{note}}`, `{{period}}`, `{{amount}}`,
     `{{deadline}}`, `{{graceEnds}}`, `{{coverage}}`, `{{link}}`, `{{units}}`, `{{chain}}`;
   - `remind`: seconds before the step's deadline (a funding window: its payment date) to send reminders.

   The validator checks them (`BAD_NOTIFY`), drafts and AI patches carry them, and they are drawn back from
   on-chain definitions. Product workflows declare the payment cycle: **Fund Payment k** (issuer, with reminders a
   day and two hours before the payment date), **Grace k** (issuer: missed, grace ends at …), **Await Top-up**
   (issuer: margin call), **Pay … k** (holders: you were paid), **Default** (holders and issuer), **Release
   Collateral** (issuer), **Fix Strike** (subscribers: the book is closed).

2. **META, never CORE.** Declarations are compiled into the definition's META (names, oracle feeds, term sheet),
   not the CORE the engine executes, so the engine runs exactly the same steps with or without them (a test
   checks the CORE bytes are identical). Because META is part of a definition's bytes, **adding declarations
   changed the ids of the product workflows** (e.g. the FCN's). Notes already issued keep their definitions;
   for definitions without declarations the notifier uses the same product rules keyed by step id, so they are
   covered too.

3. **Two receipts are built in:** the issuer's "Your note is live" (with the funding schedule and the collateral
   terms) once the book opens, and each subscriber's "You subscribed to N units" (with the schedule and the
   default protection). They go to the person's verified email regardless of category preferences.

4. **The notifier** (services/notifier) is pure: `planNote` turns a note's definition, state, view and events into
   emails with dedupe keys (note, step, trigger, occurrence, recipient); amounts per holder come from the
   transaction's balance changes. `drain` sends what is due with retries and backoff, skips people who turned a
   category off or unsubscribed, drops reminders whose moment has passed, and **holds** the outbox (no attempt
   counted) while Email Sending is not set up. Storage is a small `Sql` interface with SQLite-compatible SQL
   (Postgres today, D1 next). It runs inside the API process every 30 s (`NOTIFIER_INTERVAL`), not as its own
   service.

5. **Sending** goes through the site Worker: `POST /internal/email` with the `X-Email-Relay-Secret` header
   (`EMAIL_RELAY_SECRET`, the same value on the Worker and the API), which calls the `EMAIL` send_email binding
   from `alerts@notes.markets` as "notes.markets". Until notes.markets is onboarded it answers 503 and nothing is
   lost.

## Verified emails (required to issue and to subscribe)

In the app, Issue ("Publish and open the book") and Subscribe go through `useVerifiedEmail()`:

1. The person enters an email, chooses alerts and signs a message with their wallet (EIP-191; no gas).
2. The API emails a 6-digit code (valid 10 minutes, 5 attempts) and a link (the alternative). The person types the
   code in the same dialog.
3. The API marks the email verified, picks a random 32-byte **salt** and computes
   `emailHash = keccak256(abi.encode(bytes32 salt, string lowercase(trim(email))))`.
4. Where the chain's engine has a verifier, the app asks the API for the verifier's EIP-712 attestation
   `EmailAttestation(holder, emailHash, expiry, nonce)` and the person submits `attestEmail` (one transaction).
5. The original action continues.

The email and the salt are stored only in the API's database (never on-chain, never in logs). The person can
download their salt from **Alerts** (signed request) to prove later which email they bound. Changing the email
verifies the new one (new salt, new hash, new attestation; the old one stays in force until then). One address
has one email; one email may serve several addresses.

**Enforcement.** The contracts are permissionless, so the app and the API gate issuing and subscribing, and the
notifier has no address for unverified wallets. On-chain, `FlowEngine.setEmailPolicy(verifier, requireEmail)`:
with `requireEmail` on, the engine itself refuses an unverified issuer (`IssuerEmailNotVerified`), subscriber
(`SubscriberEmailNotVerified`) and recipient of units (`RecipientEmailNotVerified`). Reports, CRE and
withdrawals are never gated. The verifier or the owner can `revokeEmail`; every attestation and revocation bumps
the holder's nonce, so an older attestation cannot be replayed.

## API

| Route | |
|---|---|
| `POST /api/alerts/start` | `{address, email, categories, issuedAt, signature}`: emails a code and a link |
| `POST /api/alerts/verify` | `{address, code}` |
| `GET /api/alerts/confirm?token=` | the link alternative |
| `POST /api/alerts/attestation` | `{address, chain}`: the verifier's signature to submit on-chain |
| `GET /api/alerts/status?address=` | verified?, masked email, preferences |
| `POST /api/alerts/preferences` | `{address, categories, issuedAt, signature}` |
| `POST /api/alerts/salt` | `{address, issuedAt, signature}`: the person's email, salt and hash |
| `POST /api/alerts/unsubscribe` | `{token}`: one click, from any alert |
| `GET /api/dev/emails?to=` | local dev only (`EMAIL_SENDER=mock`): what was sent, for the e2e |

The signed messages are built by `alertsMessage` (services/notifier/src/templates.ts); `issuedAt` must be within
ten minutes. Rate limits: 10 code emails per IP and 5 per wallet an hour; 30 code checks per IP an hour.

## Turning on Email Sending (dashboard, once)

Cloudflare Email Service sending is in beta and needs the **Workers Paid** plan on account
325f8b322c30ee0f5460cfdaef82ecf5.

1. Cloudflare dashboard → **Compute** → **Email Service** → **Email Sending** → **Onboard Domain**.
2. Choose **notes.markets** and review the DNS records it adds (MX, SPF, DKIM, DMARC), then **Done**. DNS takes
   5–15 minutes (up to 24 hours).
3. Nothing to redeploy: the Worker already binds `EMAIL` (web/wrangler.jsonc), and the API's held emails go out
   on its next tick.

## Configuration

| Where | Setting |
|---|---|
| Worker (`web/wrangler.jsonc`) | `send_email: [{ name: "EMAIL", remote: true }]`, var `EMAIL_FROM`, secret `EMAIL_RELAY_SECRET` |
| API (`ops/ecosystem.config.cjs`, `.env.server`) | `EMAIL_RELAY_URL`, `EMAIL_RELAY_SECRET`, `VERIFIER_KEY_FILE=.keys/verifier.json`, `SITE_URL`, `NOTIFIER_INTERVAL` |
| Engine (deploy) | `VERIFIER` (the verifier key's address), `REQUIRE_EMAIL=1` (scripts/deploy-testnets.sh) |
| Local dev | `EMAIL_SENDER=mock` (scripts/dev-local.sh; anvil account 7 is the local verifier) |

## Still tied to PostgreSQL (for the D1 move)

- The notifier tick's reads of the indexer's read model (`notes`, `events`, `definitions` in
  services/api/src/alerts.ts `notifierTick`), which use `$n` placeholders and jsonb columns.
- `AlertsStore` itself is SQLite-compatible; today it runs on Postgres through `pgSql`.
