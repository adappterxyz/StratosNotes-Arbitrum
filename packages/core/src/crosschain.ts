/**
 * Cross-chain collateral (stage 1): a note runs on its home chain (Arbitrum) while collateral stays locked in a
 * RemoteVault on another chain (Robinhood Chain first). The home side holds RemoteReceipts, which the engine
 * treats as ordinary collateral. The keeper (CRE) checks every run that each vault still backs its receipts:
 *
 *   vault backing   = token.balanceOf(vault) - unclaimedTotal(token)   (what the vault can still pay)
 *   vault liability = locked(token)                                     (receipts outstanding + releases in flight)
 *   receipts        = receipt.totalSupply() at home
 *
 * In-flight messages only ever make `locked` exceed `receipts` (a lock not yet credited at home, or a redemption
 * burned at home not yet paid on the asset chain), never the reverse, so:
 *   - backing < locked     -> the token took tokens back from the vault (paused, frozen, clawed back);
 *   - receipts > locked    -> receipts exist that the vault does not account for (must never happen).
 * Both are reported as shortfalls; the first one also makes the note's coverage overstated, so the app and the
 * keeper surface it next to the note's margin.
 */
export interface VaultWatch {
  /** Home chain (CRE chain-selector name) and its receipt contract. */
  homeChain: string;
  receipt: string;
  /** Asset chain (CRE chain-selector name), the vault there and the locked token. */
  assetChain: string;
  vault: string;
  token: string;
  /** Label for logs, e.g. "TSLA on Robinhood". */
  label?: string;
}

export interface VaultReading {
  watch: VaultWatch;
  locked: bigint;
  unclaimedTotal: bigint;
  vaultBalance: bigint;
  receiptsOutstanding: bigint;
}

export type ShortfallKind = 'vault-backing' | 'receipts-exceed-locked';

export interface Shortfall {
  watch: VaultWatch;
  kind: ShortfallKind;
  /** Base units of the token missing. */
  missing: bigint;
}

export function collateralShortfalls(readings: VaultReading[]): Shortfall[] {
  const out: Shortfall[] = [];
  for (const r of readings) {
    const backing = r.vaultBalance - r.unclaimedTotal;
    if (backing < r.locked) out.push({ watch: r.watch, kind: 'vault-backing', missing: r.locked - backing });
    if (r.receiptsOutstanding > r.locked) out.push({ watch: r.watch, kind: 'receipts-exceed-locked', missing: r.receiptsOutstanding - r.locked });
  }
  return out;
}

/** The ABI fragments the keeper reads (RemoteVault on the asset chain, RemoteReceipt at home). */
export const remoteVaultAbi = [
  { type: 'function', name: 'locked', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'unclaimedTotal', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

export const erc20ReadAbi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;
