/**
 * Issue one short-dated demo note on a real testnet and fill part of its book, so the marketplace has something
 * live and CRE has something to run:
 *
 *   CHAIN=arbitrum-sepolia NOTE=crypto STRIKE_IN=900 OBS_EVERY=300 npx tsx scripts/seed-note.ts
 *   CHAIN=robinhood-testnet NOTE=equity npx tsx scripts/seed-note.ts
 *
 * NOTE=crypto: a worst-of phoenix on ETH and BTC; NOTE=equity: on TSLA and NVDA (Chainlink feeds on Arbitrum One,
 * NYSE hours: outside them the observations see the last close).
 * The deployer key (.keys/deployer.json) is issuer and paying agent and mints the test tUSD (it owns the test
 * tokens). Two demo investors (.keys/investor1.json, investor2.json, created if missing) get a little ETH for gas
 * from the deployer, claim tUSD from the faucet and subscribe 600 and 400 units; UNSOLD units stay open for
 * visitors. Keys are read from files and never printed. Writes deployments/notes/<chain>-<pid>.json.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseEther, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { compile, dec, EXAMPLE_PRODUCTS, evmInput, FEEDS, instantiateProduct, parseBpmn, reservePerUnit, type ProductParams } from '@sn/core';
import { engineAbi, lensAbi } from '@sn/sdk';

const RPCS: Record<string, { rpc: string; id: number }> = {
  'arbitrum-sepolia': { rpc: process.env.RPC ?? 'https://sepolia-rollup.arbitrum.io/rpc', id: 421614 },
  'robinhood-testnet': { rpc: process.env.RPC ?? 'https://rpc.testnet.chain.robinhood.com', id: 46630 },
};
const chainKey = process.env.CHAIN ?? 'arbitrum-sepolia';
const net = RPCS[chainKey];
if (!net) throw new Error(`CHAIN: ${Object.keys(RPCS).join(' | ')}`);
const DIR = process.env.DEPLOY_DIR ?? 'deployments';
const dep = JSON.parse(readFileSync(`${DIR}/${chainKey}.json`, 'utf8')) as { engine: Address; lens: Address; faucet: Address; tokens: Record<string, Address> };
const tusd = dep.tokens.tUSD;

const keyFrom = (file: string): Hex => {
  if (!existsSync(file)) execFileSync('bash', ['-c', `umask 077 && cast wallet new --json > ${file}`]);
  const k = (JSON.parse(readFileSync(file, 'utf8')) as Array<{ private_key: string }>)[0].private_key;
  return (k.startsWith('0x') ? k : `0x${k}`) as Hex;
};
const deployer = privateKeyToAccount(keyFrom('.keys/deployer.json'));
const investors = [privateKeyToAccount(keyFrom('.keys/investor1.json')), privateKeyToAccount(keyFrom('.keys/investor2.json'))];

const chain = defineChain({ id: net.id, name: chainKey, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [net.rpc] } } });
const client = createPublicClient({ chain, transport: http(net.rpc) });
const walletOf = (a: typeof deployer) => createWalletClient({ chain, account: a, transport: http(net.rpc) });
const erc20 = parseAbi(['function mint(address to, uint256 amount)', 'function approve(address spender, uint256 amount) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const faucetAbi = parseAbi(['function claim(address token)', 'function nextClaimAt(address token, address account) view returns (uint256)']);
const NO = 0xffff;

async function send(a: typeof deployer, req: Record<string, unknown>) {
  const hash = await walletOf(a).writeContract(req as never);
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`reverted: ${String(req.functionName)} (${hash})`);
  console.log(`  ${String(req.functionName).padEnd(18)} ${hash}`);
  return r;
}

const product: ProductParams = process.env.NOTE === 'equity'
  ? { ...EXAMPLE_PRODUCTS.phoenix, name: 'Demo Worst-of Phoenix on TSLA, NVDA', underlyings: [FEEDS.TSLA, FEEDS.NVDA], observations: 3 }
  : { ...EXAMPLE_PRODUCTS.phoenix, name: 'Demo Worst-of Phoenix on ETH, BTC', underlyings: [FEEDS.ETH, FEEDS.BTC], observations: 3 };
const prod = instantiateProduct(product);
const c = compile(parseBpmn(prod.bpmnXml, prod.assets), { product: prod.params });
const def = toHex(c.bytes);
const definition = toHex(c.hash);
const roleIdx = (name: string) => c.def.roles.indexOf(name);
const subs = [600, 400];
const unsold = Number(process.env.UNSOLD ?? 1000);
const notional = subs.reduce((a, b) => a + b, 0) + unsold;
const reserve = Math.ceil(notional * reservePerUnit(product)!);

console.log(`${product.name} on ${chainKey}: ${notional} units (${unsold} left for visitors), reserve ${reserve} tUSD`);
// Both are content-addressed and idempotent: re-running for the same design is a cheap no-op.
await send(deployer, { address: dep.engine, abi: engineAbi, functionName: 'registerDefinition', args: [def] });
await send(deployer, { address: dep.lens, abi: lensAbi, functionName: 'publish', args: [def] });

const roles: Address[] = c.def.roles.map(() => zeroAddress);
roles[roleIdx('Issuer')] = deployer.address;
roles[roleIdx('Paying Agent')] = deployer.address; // the Investor role stays open
const assetTokens: Address[] = c.def.assets.map(a => (a.kind === 1 ? tusd : zeroAddress));
const start = await send(deployer, { address: dep.engine, abi: engineAbi, functionName: 'startProcess', args: [definition, BigInt(Date.now()), roles, assetTokens, c.stepIndex.Start_Issuer, []] });
const pid = await client.readContract({ address: dep.engine, abi: engineAbi, functionName: 'processCount' });

const now = Number((await client.getBlock()).timestamp);
const strikeAt = now + Number(process.env.STRIKE_IN ?? 900);
const every = Number(process.env.OBS_EVERY ?? 300);
const obsAt = Array.from({ length: product.observations }, (_, k) => strikeAt + every * (k + 1));
await send(deployer, { address: tusd, abi: erc20, functionName: 'mint', args: [deployer.address, BigInt(reserve) * 10n ** 6n] });
await send(deployer, { address: tusd, abi: erc20, functionName: 'approve', args: [dep.engine, BigInt(reserve) * 10n ** 6n] });
await send(deployer, {
  address: dep.engine, abi: engineAbi, functionName: 'executeStep',
  args: [pid, c.stepIndex.Task_ApproveTerms, NO, [
    evmInput.text(`XSDEMO${String(now).slice(-6)}`), evmInput.number(dec(notional)), evmInput.number(BigInt(strikeAt)),
    ...obsAt.map(t => evmInput.number(BigInt(t))), evmInput.number(dec(reserve)),
  ]],
});
await send(deployer, { address: dep.engine, abi: engineAbi, functionName: 'executeStep', args: [pid, c.stepIndex.Task_Mandate, NO, []] });

for (const [i, inv] of investors.entries()) {
  const units = subs[i];
  const cash = BigInt(units) * 10n ** 6n; // issue price 100%
  if ((await client.getBalance({ address: inv.address })) < parseEther('0.0005')) {
    const hash = await walletOf(deployer).sendTransaction({ to: inv.address, value: parseEther('0.001') } as never);
    await client.waitForTransactionReceipt({ hash });
    console.log(`  gas for investor ${i + 1}  ${hash}`);
  }
  if ((await client.readContract({ address: tusd, abi: erc20, functionName: 'balanceOf', args: [inv.address] })) < cash) {
    await send(inv, { address: dep.faucet, abi: faucetAbi, functionName: 'claim', args: [tusd] });
  }
  await send(inv, { address: tusd, abi: erc20, functionName: 'approve', args: [dep.engine, cash] });
  await send(inv, { address: dep.engine, abi: engineAbi, functionName: 'executeStep', args: [pid, c.stepIndex.Task_Subscribe, NO, [evmInput.number(dec(units))]] });
}

const out = {
  chain: chainKey, pid: pid.toString(), name: product.name, definition, engine: dep.engine, fromBlock: start.blockNumber.toString(),
  strikeAt, obsAt, investors: investors.map((a, i) => ({ address: a.address, units: subs[i] })), unsold,
};
mkdirSync(`${DIR}/notes`, { recursive: true });
writeFileSync(`${DIR}/notes/${chainKey}-${pid}.json`, JSON.stringify(out, null, 2) + '\n');
console.log(`note ${chainKey}:${dep.engine.toLowerCase()}:${pid}  strike ${new Date(strikeAt * 1000).toISOString()}`);
