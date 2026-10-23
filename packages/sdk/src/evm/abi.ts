/**
 * The FlowEngine and NotesLens ABI the platform uses (packages/evm-engine). Pure data: safe to bundle into
 * the CRE workflow's WASM.
 */
import { parseAbi } from 'viem';

export const engineAbi = parseAbi([
  'struct Input { uint8 tag; bytes32 data; }',
  'struct Proc { bytes32 definition; address creator; uint8 status; uint8 nTokens; uint32 stepsRun; uint40 createdAt; uint64 ref; uint40 updatedAt; uint128 tags; }',
  'function registerDefinition(bytes data) returns (bytes32 id)',
  'function startProcess(bytes32 definition, uint64 ref, address[] roles, address[] assetTokens, uint16 startStep, Input[] inputs) returns (uint256 pid)',
  'function executeStep(uint256 pid, uint16 step, uint16 choice, Input[] inputs)',
  'function poke(uint256 pid)',
  'function withdraw(uint256 pid, uint8 asset, uint256 base)',
  'function transferUnits(uint256 pid, uint8 asset, address to, int256 amount)',
  'function onReport(bytes metadata, bytes report)',
  'function fallbackReport(bytes report)',
  'function setFallbackReporter(address next)',
  'function fallbackReporter() view returns (address)',
  'function getForwarderAddress() view returns (address)',
  'function processCount() view returns (uint256)',
  'function processOf(uint256 pid) view returns (Proc)',
  'function tokensOf(uint256 pid) view returns (uint16[])',
  'function valueOf(uint256 pid, uint256 field) view returns (uint8 tag, bytes32 data)',
  'function balanceOf(uint256 pid, address owner, uint256 asset) view returns (int256)',
  'function holdersOf(uint256 pid) view returns (address[])',
  'event ProcessStarted(uint256 indexed pid, bytes32 indexed definition, address indexed creator, uint64 ref, address[] roles, address[] assetTokens)',
  'event ReportProcessed(uint256 indexed pid, uint16 indexed step, int256[] values, address reporter)',
  'event ProcessCompleted(uint256 indexed pid)',
]);

export const lensAbi = parseAbi([
  'struct Snapshot { uint256 pid; bytes32 definition; uint8 status; uint40 updatedAt; uint16[] tokens; uint128 tags; bytes32[] values; }',
  'function publish(bytes data) returns (bytes32 id)',
  'function isPublished(bytes32 id) view returns (bool)',
  'function definitionBytes(bytes32 id) view returns (bytes)',
  'function snapshot(uint256 pid) view returns (Snapshot)',
  'function running(uint256 from, uint256 scan, uint256 max) view returns (Snapshot[] out, uint256 next)',
]);

export const feedAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
]);
