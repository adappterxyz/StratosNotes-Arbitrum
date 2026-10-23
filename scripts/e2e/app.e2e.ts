/**
 * The app end to end, in a headless browser, against the local stack (scripts/dev-local.sh with E2E=1):
 *
 *   1. connect the dev test wallet as the issuer, get test USDC, open the phoenix from Issue, set a short
 *      schedule and publish: the book opens and the app lands on the note page;
 *   2. switch to two investors in turn and subscribe 600 and 400 units from the note page;
 *   3. wait, without touching anything, while the keeper (fallback or CRE simulator) fixes the strike and runs
 *      the observations: the note page updates live until it shows Redeemed;
 *   4. check the payoff: the reference payoff along the prices the reports actually carried must equal what the
 *      note page shows per unit, what each investor holds on-chain, and what the Portfolio page shows;
 *      every report must come from the expected reporter; then withdraw from the Portfolio page.
 */
import { chromium, type Page } from 'playwright';
import { createPublicClient, erc20Abi, http, type Address } from 'viem';
import { SCALE, simulateWorstOf, totalPerUnit, type ProductParams } from '@sn/core';
import { CHAINS, EvmAdapter, type NoteState } from '@sn/sdk';
import { acct } from './lib';

const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`set ${k}`); return v; };
const APP = env('APP_URL'), API = env('API_URL'), RPC = env('RPC');
const ENGINE = env('ENGINE') as Address, LENS = env('LENS') as Address;
const EXPECT_REPORTER = env('EXPECT_REPORTER').toLowerCase();
const INVESTORS = [{ role: 'Investor A', i: 3, units: 600 }, { role: 'Investor B', i: 4, units: 400 }];
const lines: string[] = [];
let ok = true;
const check = (good: boolean, what: string) => { lines.push(`${good ? 'ok  ' : 'FAIL'} ${what}`); if (!good) ok = false; console.log(lines[lines.length - 1]); };
const log = (s: string) => console.log(`[e2e] ${s}`);

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

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on('pageerror', e => log(`page error: ${e.message}`));
try {
  // 1. Issue as the issuer.
  await page.goto(APP);
  // wagmi reconnects to an authorised injected wallet on load; otherwise connect through RainbowKit.
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
  await page.goto(`${APP}/issue`);
  await page.getByRole('button', { name: /12M Phoenix \(memory\) on ETH/ }).click();
  await page.getByRole('navigation', { name: 'Stages' }).getByRole('button', { name: /^Issue$/ }).click();
  await page.locator('#is-size').fill('1000');
  await page.locator('#is-strike').fill('3');
  await page.locator('#is-every').fill('1');
  await page.getByRole('button', { name: 'Publish and open the book' }).click();
  await page.waitForURL(/\/note\//, { timeout: 180_000 });
  const noteId = decodeURIComponent(page.url().split('/note/')[1]);
  log(`issued ${noteId}`);
  await page.locator('h1').first().waitFor();
  check(true, `issued from the app: ${noteId}`);

  // 2. Two investors subscribe from the note page.
  for (const inv of INVESTORS) {
    await role(page, inv.role);
    await faucet(page);
    await page.locator('[data-subscribe]').waitFor({ timeout: 60_000 });
    await page.locator('#units').fill(String(inv.units));
    await page.getByRole('button', { name: 'Subscribe', exact: true }).click();
    await page.getByText(`Subscribed ${inv.units} units`).waitFor({ timeout: 120_000 });
    log(`${inv.role} subscribed ${inv.units}`);
  }
  await page.locator('[data-sold]').filter({ hasText: '1,000' }).waitFor({ timeout: 60_000 });
  check(true, 'both subscriptions show on the note page (1,000 sold), via the indexer');

  // 3. Let the keeper run the note to the end; the page updates by itself.
  log('waiting for the keeper to fix the strike and observe (several minutes)…');
  await page.locator('[data-phase="redeemed"]').waitFor({ timeout: 15 * 60_000 });
  check(true, 'the note page reached Redeemed without a reload');

  // 4. The payoff, from the reported prices, against the page, the chain and the portfolio.
  const detail = await (await fetch(`${API}/api/notes/${encodeURIComponent(noteId)}`)).json() as { state: NoteState; view: { params: ProductParams; reports: { cre: number; fallback: number } } };
  const hist = await (await fetch(`${API}/api/notes/${encodeURIComponent(noteId)}/history?limit=500`)).json() as { events: Array<{ name: string; data: { step: number; values: string[]; reporter: string } }> };
  const def = (await adapter.getDefinition(detail.state.definition))!;
  const byStep = new Map<string, number[]>();
  const reports = hist.events.filter(e => e.name === 'ReportProcessed').reverse();
  for (const r of reports) {
    byStep.set(def.steps[r.data.step]?.id ?? 'advance', r.data.values.map(v => Number(BigInt(v)) / Number(SCALE)));
    check(r.data.reporter === EXPECT_REPORTER, `report ${def.steps[r.data.step]?.id ?? 'advance'} [${r.data.values.map(v => (Number(BigInt(v)) / 1e10).toFixed(2)).join(', ')}] by ${r.data.reporter}`);
  }
  const params = detail.view.params;
  const strikes = byStep.get('Task_FixStrike')!;
  const rows = Array.from({ length: params.observations }, (_, k) => byStep.get(`Task_Observe${k + 1}`) ?? strikes.map(() => 0));
  const ref = simulateWorstOf(params, strikes, rows);
  const perUnit = totalPerUnit(ref);
  lines.push(`reference: coupons [${ref.coupons.join(', ')}], ${ref.calledAt ? `called at ${ref.calledAt}` : 'to maturity'}, redemption ${ref.redemptionCash} -> ${perUnit} per unit`);
  console.log(lines[lines.length - 1]);
  const shown = (await page.locator('[data-per-unit]').textContent())?.trim();
  check(shown === perUnit.toFixed(4), `note page "Paid so far / unit" ${shown} = reference ${perUnit.toFixed(4)}`);
  const agent = await page.locator('[data-agent]').getAttribute('data-agent');
  check(agent === (process.env.KEEPER === 'cre' ? 'cre' : 'fallback'), `note page shows the agent: ${agent}`);
  const chainNote = (await adapter.getNote(noteId))!;
  for (const inv of INVESTORS) {
    const addr = acct(inv.i).address.toLowerCase();
    const cash = Number(BigInt(chainNote.holdings.find(h => h.owner === addr && h.asset === 1)?.balance ?? '0')) / Number(SCALE);
    check(Math.abs(cash - inv.units * perUnit) <= inv.units * 5e-7, `${inv.role} ${inv.units} units: on-chain ${cash} USDC, reference ${inv.units * perUnit}`);
  }

  // Portfolio: Investor A sees the cash and withdraws it.
  await role(page, 'Investor A');
  await page.goto(`${APP}/portfolio`);
  const row = page.locator(`tr[data-note="${noteId}"]`);
  await row.waitFor({ timeout: 30_000 });
  const want = (600 * perUnit).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const cell = (await row.locator('[data-cash]').textContent())?.trim();
  check(cell === `${want} USDC`, `portfolio shows ${cell} (want ${want} USDC)`);
  const usdc = chainNote.assetTokens[1] as Address;
  const before = await client.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [acct(3).address] });
  await row.getByRole('button', { name: 'Withdraw' }).click();
  await page.getByText(/^Withdrew /).waitFor({ timeout: 120_000 });
  const after = await client.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [acct(3).address] });
  const got = Number(after - before) / 1e6;
  check(Math.abs(got - 600 * perUnit) < 0.01, `withdrew ${got} USDC to the wallet`);
  await page.screenshot({ path: 'deployments/local/dev/e2e-portfolio.png' });
} catch (e) {
  ok = false;
  console.log(`FAIL ${e instanceof Error ? e.message : String(e)}`);
  await page.screenshot({ path: 'deployments/local/dev/e2e-failure.png' }).catch(() => {});
} finally {
  await browser.close();
}
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
