/** A local D1 (Miniflare, the engine behind `wrangler dev`) with web/migrations applied. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import { applyMigrations, type D1Database } from '../src/d1';

const DIR = join(__dirname, '../../../web/migrations');
export const MIGRATIONS = readdirSync(DIR).filter(f => f.endsWith('.sql')).sort().map(name => ({ name, sql: readFileSync(join(DIR, name), 'utf8') }));

export async function localD1(): Promise<{ db: D1Database; dispose: () => Promise<void> }> {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("") } }', d1Databases: ['DB'] });
  const db = (await mf.getD1Database('DB')) as unknown as D1Database;
  await applyMigrations(db, MIGRATIONS);
  return { db, dispose: () => mf.dispose() };
}
