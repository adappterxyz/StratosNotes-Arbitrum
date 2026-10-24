/**
 * The app end to end, in a headless browser, against the local stack (scripts/dev-local.sh with E2E=1):
 *
 *   1. connect the dev test wallet as the issuer, get test USDC, open the phoenix from Issue, set a short schedule
 *      (100% USDC collateral, pledged from the form) and publish TWO notes: the book opens on each;
 *   2. switch to two investors in turn and subscribe to both notes from their pages;
 *   3. as the issuer, withdraw the subscriptions raised (they are the issuer's at once), then fund note 1's
 *      payments from its page as each falls due ("Payment due" -> Fund) and leave note 2's unfunded;
 *   4. let the keeper (fallback or CRE simulator) run both: note 1 reaches Redeemed, note 2 Defaulted, live;
 *   5. check note 1 against the reference payoff along the prices the reports carried (page, chain, portfolio,
 *      collateral released to the issuer) and note 2's default (each holder holds its pro-rata share of the
 *      collateral and withdraws it), and that every report came from the expected reporter.
 */
import { chromium, type Page } from 'playwright';
import { createPublicClient, erc20Abi, http, type Address } from 'viem';
import { decodeEvmDef, dec, SCALE, simulateNote, simulateWorstOf, totalPerUnit, type ProductParams } from '@sn/core';
import { CHAINS, EvmAdapter, flowEngineAbi, hexToBytes, parseNoteId, type NoteState } from '@sn/sdk';
import { acct } from './lib';

const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`set ${k}`); return v; };
const APP = env('APP_URL'), API = env('API_URL'), RPC = env('RPC');
const ENGINE = env('ENGINE') as Address, LENS = env('LENS') as Address;
const EXPECT_REPORTER = env('EXPECT_REPORTER').toLowerCase();
const PAID = [{ role: 'Investor A', i: 3, units: 600 }, { role: 'Investor B', i: 4, units: 400 }];
const DEFAULTS = [{ role: 'Investor A', i: 3, units: 300 }, { role: 'Investor B', i: 4, units: 700 }];
const lines: string[] = [];
let ok = true;
const check = (good: boolean, what: string) => { lines.push(`${good ? 'ok  ' : 'FAIL'} ${what}`); if (!good) ok = false; console.log(lines[lines.length - 1]); };
const log = (s: string) => console.log(`[e2e] ${s}`);
const money = (x: number) => x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const client = createPublicClient({ transport: http(RPC) });
const adapter = new EvmAdapter(CHAINS.local, client as never, { engine: ENGINE, lens: LENS, fromBlock: BigInt(env('BLOCK')) });

async function role(page: Page, label: string) {
  await page.getByRole('group', { name: 'Test account' }).getByRole('button', { name: label, exact: true }).click();
  await page.waitForTimeout(800);
}
async function faucet(page: Page) {
  await page.getByRole('button', { name: /^Test USDC$/ }).click();
  await page.getByText(/USDC sent\./).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(3000); // the mint is mined in the next block
}
/** Verified emails: the dev API keeps sent emails in memory; read the code from there. */
async function mailbox(to: string): Promise<Array<{ subject: string; text: string }>> {
  const r = await fetch(`${API}/api/dev/emails?to=${encodeURIComponent(to)}`);
  return ((await r.json()) as { emails: Array<{ subject: string; text: string }> }).emails;
}
/** If the app asks for a verified email (first issue or subscription per wallet), verify it inline with the code. */
async function verifyIfAsked(page: Page, email: string) {
  const asked = await page.locator('[data-verify-email]').waitFor({ timeout: 8_000 }).then(() => true).catch(() => false);
  if (!asked) return false;
  await page.locator('#ve-email').fill(email);
  await page.locator('[data-send-code]').click();
  await page.locator('#ve-code').waitFor({ timeout: 30_000 });
  let code = '';
  for (let i = 0; i < 30 && !code; i++) {
    code = /code is (\d{6})/.exec((await mailbox(email)).at(-1)?.text ?? '')?.[1] ?? '';
    if (!code) await page.waitForTimeout(500);
  }
  await page.locator('#ve-code').fill(code);
  await page.locator('[data-verify-code]').click();
  // Verified, then the attestation is submitted on-chain and the original action continues.
  await page.locator('[data-verify-email]').waitFor({ state: 'detached', timeout: 120_000 });
  check(!!code, `${email} verified with the emailed code and attested on-chain`);
  return true;
}
async function issueOne(page: Page): Promise<string> {
  await page.goto(`${APP}/issue`);
  await page.getByRole('button', { name: /12M Phoenix \(memory\) on ETH/ }).click();
  await page.getByRole('navigation', { name: 'Stages' }).getByRole('button', { name: /^Issue$/ }).click();
  await page.locator('#is-size').fill('1000');
  await page.locator('#is-strike').fill('4');
  await page.locator('#is-every').fill('2');
  // The form proposes a pledge that exactly covers 100% of the notional.
  await page.locator('[data-collateral]').waitFor();
  check((await page.locator('#is-pledge-USD').inputValue()) === '1000', 'the issue form proposes 1,000 USDC of collateral for 100%');
  // Payment 40 s after each observation, 60 s of grace: room for the keeper's report and the issuer's click.
  await page.locator('#is-lag').fill('40');
  await page.locator('#is-grace').fill('60');
  await page.getByRole('button', { name: 'Publish and open the book' }).click();
  await verifyIfAsked(page, 'issuer@e2e.test');
  await page.waitForURL(/\/note\//, { timeout: 180_000 });
  const id = decodeURIComponent(page.url().split('/note/')[1]);
  await page.locator('h1').first().waitFor();
  return id;
}
async function subscribe(page: Page, id: string, units: number, email: string) {
  await page.goto(`${APP}/note/${encodeURIComponent(id)}`);
  await page.locator('[data-subscribe]').waitFor({ timeout: 60_000 });
  await page.locator('#units').fill(String(units));
  await page.getByRole('button', { name: /^Subscribe for / }).click();
  await verifyIfAsked(page, email);
  await page.getByText(`Subscribed ${units} units`).waitFor({ timeout: 120_000 });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on('pageerror', e => log(`page error: ${e.message}`));
try {
  // 1. Issue two notes as the issuer.
  await page.goto(APP);
  await page.getByRole('group', { name: 'Test account' }).waitFor();
  const connect = page.getByRole('button', { name: 'Connect Wallet' }).first();
  if (await connect.isVisible().catch(() => false)) {
    await connect.click();
    await page.getByText('StratosNotes test wallet').click();
  }
  await page.getByRole('button', { name: /^Test USDC$/ }).waitFor({ timeout: 30_000 });
  await role(page, 'Issuer');
  await faucet(page);
  log('issuer connected and funded');
  const paidId = await issueOne(page);
  check(true, `note 1 issued from the app, collateral pledged: ${paidId}`);
  const defaultId = await issueOne(page);
  check(true, `note 2 issued from the app, collateral pledged: ${defaultId}`);
  await page.locator('[data-economics]').waitFor();
  // The page polls for updates (the backend indexes on a cron), so give the ratio time to arrive.
  const ratioShown = await page.waitForFunction(() => document.querySelector('[data-ratio]')?.textContent?.trim() === '100.0%', null, { timeout: 90_000 }).then(() => true).catch(() => false);
  check(ratioShown, 'the note page shows the collateral ratio');

  // Without a verified email (no attestation on-chain), the engine itself refuses a subscription.
  {
    const p = parseNoteId(paidId)!;
    const n = await (await fetch(`${API}/api/notes/${encodeURIComponent(paidId)}`)).json() as { state: NoteState };
    const d = await (await fetch(`${API}/api/definitions/${p.chain}/${n.state.definition}`)).json() as { bytes: `0x${string}` };
    const step = decodeEvmDef(hexToBytes(d.bytes)).steps.findIndex(x => x.id === 'Task_Subscribe');
    const err = await client.simulateContract({
      account: acct(5).address, address: ENGINE, abi: flowEngineAbi, functionName: 'executeStep',
      args: [BigInt(p.pid), step, 0xffff, [{ tag: 1, data: `0x${dec(10).toString(16).padStart(64, '0')}` }]],
    }).then(() => 'no revert', (e: Error) => e.message);
    check(/SubscriberEmailNotVerified/.test(err), 'an unverified wallet subscribing directly on-chain is refused (SubscriberEmailNotVerified)');
  }

  // 2. Investors subscribe to both.
  for (const [k, inv] of PAID.entries()) {
    await role(page, inv.role);
    await faucet(page);
    const email = `${inv.role.toLowerCase().replace(/\s+/g, '-')}@e2e.test`;
    await subscribe(page, paidId, inv.units, email);
    await subscribe(page, defaultId, DEFAULTS[k].units, email);
    log(`${inv.role} subscribed ${inv.units} and ${DEFAULTS[k].units}`);
  }
  await page.goto(`${APP}/note/${encodeURIComponent(paidId)}`);
  await page.locator('[data-sold]').filter({ hasText: '1,000' }).waitFor({ timeout: 60_000 });
  check(true, 'subscriptions show on the note page (1,000 sold), via the indexer');

  // 3. The issuer: withdraw the proceeds, then fund note 1's payments as they fall due; note 2 is left unfunded.
  await role(page, 'Issuer');
  await page.goto(`${APP}/note/${encodeURIComponent(paidId)}`);
  await page.locator('[data-position] [data-cash]').filter({ hasText: '1,000.00' }).waitFor({ timeout: 60_000 });
  await page.getByRole('button', { name: /^Withdraw proceeds/ }).click();
  await page.getByText('Withdrawn to your wallet.').waitFor({ timeout: 120_000 });
  check(true, 'the issuer withdrew the 1,000 USDC raised before the strike');
  log('funding note 1 as payments fall due; waiting for both notes to finish (several minutes)…');
  let funded = 0;
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    if (await page.locator('[data-phase="redeemed"]').isVisible().catch(() => false)) break;
    const fund = page.locator('[data-fund]');
    if (await fund.isVisible().catch(() => false)) {
      // The page refreshes by polling, so the card can re-render (or the payment can already be funded) between
      // seeing the button and clicking it: on a miss, look again rather than fail.
      try {
        const period = await page.locator('[data-payment-due]').getAttribute('data-payment-due', { timeout: 5_000 });
        await fund.click({ timeout: 10_000 });
        await page.getByText(/moved into escrow/).waitFor({ timeout: 120_000 });
        funded++;
        log(`funded payment ${period}`);
      } catch (e) {
        log(`fund button moved (${(e instanceof Error ? e.message : String(e)).split('\n')[0]}); looking again`);
      }
    }
    await page.waitForTimeout(2000);
  }
  await page.locator('[data-phase="redeemed"]').waitFor({ timeout: 60_000 });
  check(funded > 0, `note 1 reached Redeemed without a reload; the issuer funded ${funded} payment(s) from the page`);
  check((await page.locator('[data-econ-state]').getAttribute('data-econ-state')) === 'released', 'note 1: collateral released to the issuer');

  // 4. Note 1 against the reference, along the prices the reports carried.
  const fetchNote = async (id: string) => (await (await fetch(`${API}/api/notes/${encodeURIComponent(id)}`)).json()) as { state: NoteState; view: { params: ProductParams } };
  const reportsOf = async (id: string) => ((await (await fetch(`${API}/api/notes/${encodeURIComponent(id)}/history?limit=500`)).json()) as { events: Array<{ name: string; data: { step: number; values: string[]; reporter: string } }> }).events.filter(e => e.name === 'ReportProcessed').reverse();
  const detail = await fetchNote(paidId);
  const def = (await adapter.getDefinition(detail.state.definition))!;
  const byStep = new Map<string, number[]>();
  for (const r of await reportsOf(paidId)) {
    const name = def.steps[r.data.step]?.id ?? 'advance';
    if (r.data.values.length) byStep.set(name, r.data.values.map(v => Number(BigInt(v)) / Number(SCALE)));
    check(r.data.reporter === EXPECT_REPORTER, `note 1 report ${name} [${r.data.values.map(v => (Number(BigInt(v)) / 1e10).toFixed(2)).join(', ')}] by ${r.data.reporter}`);
  }
  const params = detail.view.params;
  const strikes = byStep.get('Task_FixStrike')!.slice(0, params.underlyings.length);
  const rows = Array.from({ length: params.observations }, (_, k) => byStep.get(`Task_Observe${k + 1}`)?.slice(0, params.underlyings.length) ?? strikes.map(() => 0));
  const ref = simulateWorstOf(params, strikes, rows);
  const perUnit = totalPerUnit(ref);
  lines.push(`reference: coupons [${ref.coupons.join(', ')}], ${ref.calledAt ? `called at ${ref.calledAt}` : 'to maturity'}, redemption ${ref.redemptionCash} -> ${perUnit} per unit`);
  console.log(lines[lines.length - 1]);
  const shown = (await page.locator('[data-per-unit]').textContent())?.trim().split(' ')[0];
  check(shown === perUnit.toFixed(4), `note page "Paid so far / unit" ${shown} = reference ${perUnit.toFixed(4)}`);
  const agent = await page.locator('[data-agent]').getAttribute('data-agent');
  check(agent === (process.env.KEEPER === 'cre' ? 'cre' : 'fallback'), `note page shows the agent: ${agent}`);
  const chainNote = (await adapter.getNote(paidId))!;
  for (const inv of PAID) {
    const addr = acct(inv.i).address.toLowerCase();
    const cash = Number(BigInt(chainNote.holdings.find(h => h.owner === addr && h.asset === 1)?.balance ?? '0')) / Number(SCALE);
    check(Math.abs(cash - inv.units * perUnit) <= inv.units * 5e-7, `note 1 ${inv.role} ${inv.units} units: on-chain ${cash} USDC, reference ${inv.units * perUnit}`);
  }

  // 5. Note 2: defaulted; holders hold the collateral pro rata and withdraw it.
  await page.goto(`${APP}/note/${encodeURIComponent(defaultId)}`);
  await page.locator('[data-phase="defaulted"]').waitFor({ timeout: 5 * 60_000 });
  check(true, 'note 2 reached Defaulted (payment unfunded through grace)');
  const d2 = await fetchNote(defaultId);
  const def2 = (await adapter.getDefinition(d2.state.definition))!;
  const reports2 = new Map<string, number[]>();
  for (const r of await reportsOf(defaultId)) if (r.data.values.length) reports2.set(def2.steps[r.data.step]?.id ?? 'advance', r.data.values.map(v => Number(BigInt(v)) / Number(SCALE)));
  const s2 = reports2.get('Task_FixStrike')!.slice(0, params.underlyings.length);
  const rows2 = Array.from({ length: params.observations }, (_, k) => reports2.get(`Task_Observe${k + 1}`)?.slice(0, params.underlyings.length) ?? s2.map(() => 1));
  const firstDue = simulateNote(params, { perfs: rows2.map(r => Math.min(...r.map((o, i) => o / s2[i]))), sold: 1000, ratio: 0, collateral: [] }).calls[0]?.period ?? 1;
  const out2 = simulateNote(params, {
    perfs: rows2.map(r => Math.min(...r.map((o, i) => o / s2[i]))), sold: 1000, ratio: 1,
    collateral: [{ symbol: 'USD', amount: 1000, haircut: 1, prices: [1, 1, 1, 1, 1] }], behaviour: { missPayment: firstDue },
  });
  check(out2.defaulted?.period === firstDue, `reference: the issuer missed payment ${firstDue} -> default; ${out2.perUnit.cash} cash and ${out2.perUnit.collateral.USD} collateral per unit`);
  const chain2 = (await adapter.getNote(defaultId))!;
  // The stablecoin collateral asset (named after the cash token: USDG since the switch, tUSD before it).
  const colAsset = def2.assets.findIndex(a => /^Collateral (USDG|t?USD|USDC)$/.test(a.name));
  const colName = def2.assets[colAsset]?.name ?? 'Collateral USDG';
  for (const inv of DEFAULTS) {
    const addr = acct(inv.i).address.toLowerCase();
    const col = Number(BigInt(chain2.holdings.find(h => h.owner === addr && h.asset === colAsset)?.balance ?? '0')) / Number(SCALE);
    check(Math.abs(col - inv.units * out2.perUnit.collateral.USD) <= inv.units * 5e-7, `note 2 ${inv.role} ${inv.units} units: on-chain ${col} USDC collateral, reference ${inv.units * out2.perUnit.collateral.USD}`);
  }
  await role(page, 'Investor A');
  await page.goto(`${APP}/note/${encodeURIComponent(defaultId)}`);
  const colRow = page.locator(`[data-other-asset="${colName}"]`);
  await colRow.waitFor({ timeout: 60_000 });
  const usdc = chainNote.assetTokens[1] as Address;
  let before = await client.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [acct(3).address] });
  await colRow.getByRole('button').click();
  await page.getByText('Withdrawn to your wallet.').waitFor({ timeout: 120_000 });
  let after = await client.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [acct(3).address] });
  check(Math.abs(Number(after - before) / 1e6 - 300 * out2.perUnit.collateral.USD) < 0.01, `Investor A withdrew ${Number(after - before) / 1e6} USDC of collateral to the wallet`);
  await page.screenshot({ path: 'deployments/local/dev/e2e-default.png', fullPage: true });

  // Portfolio: Investor A sees note 1's cash and withdraws it.
  await page.goto(`${APP}/portfolio`);
  const row = page.locator(`tr[data-note="${paidId}"]`);
  await row.waitFor({ timeout: 30_000 });
  const want = money(600 * perUnit);
  const cell = (await row.locator('[data-cash]').textContent())?.trim();
  check(!!cell?.startsWith(`${want} USDC`), `portfolio shows ${cell} (want ${want} USDC)`);
  before = await client.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [acct(3).address] });
  await row.getByRole('button', { name: 'Withdraw' }).click();
  await page.getByText(/^Withdrew /).waitFor({ timeout: 120_000 });
  after = await client.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [acct(3).address] });
  const got = Number(after - before) / 1e6;
  check(Math.abs(got - 600 * perUnit) < 0.01, `withdrew ${got} USDC to the wallet`);
  await page.screenshot({ path: 'deployments/local/dev/e2e-portfolio.png' });
  await page.goto(`${APP}/note/${encodeURIComponent(paidId)}`);
  await page.locator('[data-economics]').waitFor();
  await page.screenshot({ path: 'deployments/local/dev/e2e-paid.png', fullPage: true });
} catch (e) {
  ok = false;
  console.log(`FAIL ${e instanceof Error ? e.message : String(e)}`);
  // What the page said: the issue progress and any error shown.
  for (const sel of ['[data-progress]', '[role=alert]']) {
    const t = await page.locator(sel).allInnerTexts().catch(() => []);
    if (t.length) console.log(`  page ${sel}: ${t.join(' | ').replace(/\s+/g, ' ')}`);
    // A reverted transaction: its gas against the limit, and the revert replayed on the block before.
    const hash = t.join(' ').match(/0x[0-9a-f]{64}/)?.[0] as `0x${string}` | undefined;
    if (hash) {
      const [tx, rc] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
      console.log(`  tx ${hash}: gas used ${rc.gasUsed} of limit ${tx.gas}`);
      try { await client.call({ account: tx.from, to: tx.to!, data: tx.input, blockNumber: rc.blockNumber - 1n }); console.log('  replay: succeeds'); }
      catch (err) { console.log(`  replay: ${(err instanceof Error ? err.message : String(err)).split('\n').slice(0, 3).join(' ')}`); }
    }
  }
  await page.screenshot({ path: 'deployments/local/dev/e2e-failure.png', fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
