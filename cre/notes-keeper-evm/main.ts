// StratosNotes keeper (EVM): one Chainlink CRE workflow that is the calculation agent for EVERY note on every
// configured EVM chain (Arbitrum Sepolia, Robinhood Chain testnet; Arbitrum One by config).
//
// Each cron run, per chain:
//  1. Reads every running process through the chain's NotesLens at the last FINALIZED block (one call), and
//     each distinct definition's full bytes (the oracle feeds live in its metadata).
//  2. Decides what is due with the shared keeper logic (packages/core/src/keeper.ts): a strike fixing or an
//     observation whose date has come, or a plain timer to advance.
//  3. For each due oracle step, reads the Chainlink price feed of every underlying it captures (one for a
//     single-asset note, several for a worst-of basket), on the chain the feed lives on, at a finalized block,
//     staleness-checked against the feed's heartbeat.
//  4. Writes a DON-signed report to the chain's FlowEngine through the KeystoneForwarder:
//     abi.encode(uint256 pid, uint16 step, int256[] values). The engine bounds-checks every value, runs the
//     step and everything after it that needs nobody (coupons, autocall, redemption) in that transaction.
import {
  bytesToHex, consensusIdenticalAggregation, CronCapability, EVMClient, encodeCallMsg, getNetwork, handler,
  LAST_FINALIZED_BLOCK_NUMBER, LATEST_BLOCK_NUMBER, prepareReportRequest, Runner, TxStatus, type Runtime,
} from '@chainlink/cre-sdk'
import { decodeFunctionResult, encodeFunctionData, zeroAddress, type Address, type Hex } from 'viem'
import { z } from 'zod'
import { decodeEvmDef, encodeEvmReport } from '../../packages/core/src/compile-evm'
import { checkRound, dueReports, routeFeed, type DueReport, type FeedRef } from '../../packages/core/src/keeper'
import type { WorkflowDef } from '../../packages/core/src/def-types'
import { feedAbi, lensAbi } from '../../packages/sdk/src/evm/abi'
import { hexToBytes, snapshotToState } from '../../packages/sdk/src/evm/state'

void consensusIdenticalAggregation // reads go through the EVM capability, which reaches consensus itself

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
/** An engine or lens: the zero address means "not deployed yet" and fails the config, closed. */
const deployed = address.refine(a => !/^0x0{40}$/.test(a), 'not deployed yet (zero address): run scripts/cre-config.ts after deploying')

const configSchema = z.object({
  /** 6-field cron, e.g. "0 * * * * *" = every minute. */
  schedule: z.string(),
  chains: z.array(z.object({
    /** CRE chain-selector name, e.g. ethereum-testnet-sepolia-arbitrum-1, robinhood-testnet. */
    chainSelectorName: z.string(),
    engine: deployed,
    lens: deployed,
    /** Gas for one report: a coupon to a full book (62 holders) needs ~2.3M of execution, plus Arbitrum L1 data gas. */
    gasLimit: z.string().regex(/^\d+$/),
    /** First pid to scan (skip finished history) and how many pids one lens call scans / returns. */
    fromPid: z.number().int().positive(),
    scan: z.number().int().positive(),
    maxProcesses: z.number().int().positive(),
    /**
     * Block to read the engine at. 'finalized' (default) needs an RPC that serves recent historical state; public
     * testnet RPCs (Robinhood Chain testnet) refuse it, so they read 'latest'. Safe either way: the engine re-checks
     * on-chain that a step is due before it applies a report. Feeds are always read at a finalized block.
     */
    stateBlock: z.enum(['finalized', 'latest']).optional(),
  })).min(1),
  /** Reports written per run across all chains (each is one transaction). */
  maxReportsPerRun: z.number().int().positive(),
  /** Feeds are read at a finalized block, which lags the head: allowed on top of each feed's heartbeat. */
  finalityAllowanceSec: z.number().int().nonnegative(),
  /** Optional: send a recorded feed (lowercase address) to another source, e.g. a chain's own feeds. */
  feedRoutes: z.record(z.object({ feed: address, feedChain: z.string(), staleness: z.number().int().positive().optional() })).optional(),
})
type Config = z.infer<typeof configSchema>
type ChainConfig = Config['chains'][number]

function client(name: string): EVMClient {
  const network = getNetwork({ chainFamily: 'evm', chainSelectorName: name })
  if (!network) throw new Error(`unknown chain-selector name: ${name}`)
  return new EVMClient(network.chainSelector.selector)
}

/** One view call, at the last finalized block unless `at` is 'latest'; returns the raw result. */
function view(runtime: Runtime<Config>, evm: EVMClient, to: string, data: Hex, at: 'finalized' | 'latest' = 'finalized'): Hex {
  const reply = evm.callContract(runtime, {
    call: encodeCallMsg({ from: zeroAddress, to: to as Address, data }),
    blockNumber: at === 'latest' ? LATEST_BLOCK_NUMBER : LAST_FINALIZED_BLOCK_NUMBER,
  }).result()
  return bytesToHex(reply.data)
}

/** What is due on one chain: running processes from the lens, their definitions, the shared keeper logic. */
function dueOn(runtime: Runtime<Config>, chain: ChainConfig, nowSec: number): DueReport[] {
  const evm = client(chain.chainSelectorName)
  const out: DueReport[] = []
  const defs = new Map<string, WorkflowDef | null>()
  let from = BigInt(chain.fromPid)
  for (let page = 0; page < 4; page++) {
    const raw = view(runtime, evm, chain.lens, encodeFunctionData({
      abi: lensAbi, functionName: 'running', args: [from, BigInt(chain.scan), BigInt(chain.maxProcesses)],
    }), chain.stateBlock ?? 'finalized')
    const [snaps, next] = decodeFunctionResult({ abi: lensAbi, functionName: 'running', data: raw })
    for (const s of snaps) {
      const p = snapshotToState({ ...s, tokens: s.tokens, values: s.values, balances: s.balances })
      if (!defs.has(p.definition)) {
        const bytes = decodeFunctionResult({
          abi: lensAbi, functionName: 'definitionBytes',
          data: view(runtime, evm, chain.lens, encodeFunctionData({ abi: lensAbi, functionName: 'definitionBytes', args: [p.definition as Hex] }), chain.stateBlock ?? 'finalized'),
        })
        defs.set(p.definition, bytes === '0x' ? null : decodeEvmDef(hexToBytes(bytes)))
      }
      const def = defs.get(p.definition)
      if (!def) {
        runtime.log(`${chain.chainSelectorName} pid ${p.id}: definition ${p.definition} not published on the lens; skipped`)
        continue
      }
      out.push(...dueReports(p, def, nowSec))
    }
    if (next === 0n) break
    from = next
  }
  return out
}

/** A Chainlink feed's latest answer as engine fixed point (10 decimals), finalized block, staleness-checked. */
function readFeed(runtime: Runtime<Config>, f: FeedRef, nowSec: number): bigint {
  const evm = client(f.feedChain)
  const [roundId, answer, , updatedAt, answeredInRound] = decodeFunctionResult({
    abi: feedAbi, functionName: 'latestRoundData',
    data: view(runtime, evm, f.feed, encodeFunctionData({ abi: feedAbi, functionName: 'latestRoundData' })),
  })
  const decimals = decodeFunctionResult({
    abi: feedAbi, functionName: 'decimals',
    data: view(runtime, evm, f.feed, encodeFunctionData({ abi: feedAbi, functionName: 'decimals' })),
  })
  return checkRound({ roundId, answer, updatedAt, answeredInRound }, decimals, nowSec, f.staleness, runtime.config.finalityAllowanceSec)
}

export const onCron = (runtime: Runtime<Config>): string => {
  const cfg = runtime.config
  const nowSec = Math.floor(runtime.now().getTime() / 1000)
  const written: string[] = []
  const failed: string[] = []
  let due = 0
  let budget = cfg.maxReportsPerRun
  // A basket reads one feed per underlying; read each feed at most once per run, whatever needs it.
  const prices = new Map<string, bigint>()
  const price = (f: FeedRef) => {
    const k = `${f.feedChain}:${f.feed.toLowerCase()}:${f.staleness}`
    if (!prices.has(k)) prices.set(k, readFeed(runtime, f, nowSec))
    return prices.get(k)!
  }
  for (const chain of cfg.chains) {
    const reports = dueOn(runtime, chain, nowSec)
    due += reports.length
    runtime.log(`${chain.chainSelectorName}: ${reports.length} report(s) due`)
    const evm = client(chain.chainSelectorName)
    for (const d of reports) {
      if (budget <= 0) break
      budget--
      const tag = `${chain.chainSelectorName} pid ${d.process} ${d.stepId}`
      let values: bigint[]
      try {
        values = d.feeds.map(f => price(routeFeed(f, cfg.feedRoutes)))
      } catch (e) {
        runtime.log(`${tag} -> skipped: ${(e as Error).message}`)
        failed.push(tag)
        continue
      }
      const report = runtime.report(prepareReportRequest(bytesToHex(encodeEvmReport(BigInt(d.process), d.step, values)))).result()
      const resp = evm.writeReport(runtime, { receiver: chain.engine, report, gasConfig: { gasLimit: chain.gasLimit } }).result()
      const ok = resp.txStatus === TxStatus.SUCCESS && !!resp.txHash && resp.txHash.length > 0
      runtime.log(`${tag} [${values.join(',')}] -> ${ok ? `written ${bytesToHex(resp.txHash!)}` : `failed: ${resp.errorMessage || resp.txStatus}`}`)
      ;(ok ? written : failed).push(tag)
    }
  }
  return JSON.stringify({ due, written, failed })
}

export const initWorkflow = (config: Config) => [
  handler(new CronCapability().trigger({ schedule: config.schedule }), onCron),
]

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema })
  await runner.run(initWorkflow)
}

main()
