/**
 * How many of Robinhood Chain testnet's own stock tokens (TSLA, AMZN, NFLX) the demo accounts hold, so you know
 * whether the issuer must claim some from Robinhood's faucet before issuing a note that pledges or delivers them.
 * Read-only: it reads the public addresses from .keys/*.json (never the keys) and calls balanceOf.
 *
 *   npx tsx scripts/stock-token-holdings.ts            # deployer (the demo issuer), keeper, demo investors
 *   npx tsx scripts/stock-token-holdings.ts 0xabc…     # the deployer plus any addresses (e.g. your own wallet)
 */
import { existsSync, readFileSync } from 'node:fs';
import { createPublicClient, formatUnits, http, parseAbi, type Address } from 'viem';
import { EXTERNAL_TOKENS, ROBINHOOD_STOCK_TOKENS, STOCK_TOKEN_FAUCETS } from '../packages/core/src';

const RPC = process.env.RPC ?? 'https://rpc.testnet.chain.robinhood.com';
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);

function addressOf(file: string): Address | null {
  if (!existsSync(file)) return null;
  const d = JSON.parse(readFileSync(file, 'utf8')) as Array<{ address?: string }> | { address?: string };
  const a = Array.isArray(d) ? d[0]?.address : d.address;
  return a ? (a as Address) : null;
}

const args = process.argv.slice(2);
for (const a of args) if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`Not an address: ${a}`);
const own = (args.length ? ['deployer'] as const : ['deployer', 'keeper', 'investor1', 'investor2'] as const)
  .map(n => [n, addressOf(`.keys/${n}.json`)] as [string, Address | null])
  .filter((x): x is [string, Address] => !!x[1]);
const named: Array<[string, Address]> = [...own, ...args.map((a, i) => [`address ${i + 1}`, a as Address] as [string, Address])];

const client = createPublicClient({ transport: http(RPC) });
const tokens = EXTERNAL_TOKENS['robinhood-testnet'];
for (const [name, who] of named) {
  const row: string[] = [];
  for (const [sym, meta] of Object.entries(ROBINHOOD_STOCK_TOKENS)) {
    const bal = await client.readContract({ address: tokens[meta.token], abi: erc20, functionName: 'balanceOf', args: [who] });
    row.push(`${sym} ${formatUnits(bal, meta.decimals)}`);
  }
  console.log(`${name.padEnd(10)} ${who}  ${row.join('  ')}`);
}
console.log(`Claim more from ${STOCK_TOKEN_FAUCETS['robinhood-testnet']} (connect the address there).`);
