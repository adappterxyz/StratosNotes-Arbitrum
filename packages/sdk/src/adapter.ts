/**
 * ChainAdapter: the one interface the app and the services use to read and act on notes, whatever chain runs
 * them. EvmAdapter (evm/adapter.ts) implements it for FlowEngine on Arbitrum Sepolia and Robinhood Chain; another
 * chain family would implement it over its own API, with its own credential as its
 * signer.
 *
 * Reads here go to the chain directly (for scripts, keepers and verification). The app reads notes from the
 * indexer's API instead, which serves the same NoteState shape for every chain.
 */
import type { WorkflowDef } from '@sn/core';
import type { EngineEvent } from './events';
import type { InputValue, IssuePlan } from './issue';
import type { ChainInfo, NoteId, NoteState } from './model';

export interface IssueRequest {
  /** The definition's canonical bytes (CORE ‖ META); registered first if the chain does not have it yet. */
  definition: Uint8Array;
  def: WorkflowDef;
  plan: IssuePlan;
  /** The issuer's own reference for this issuance (e.g. an issuance number). */
  ref: bigint;
  /** The token behind each cash asset (EVM: an ERC-20 address), by asset index. */
  cashTokens: Record<number, string>;
  /** Inputs for the start step and each pre-trade step: step index -> field index -> value. */
  inputs: Record<number, Record<number, InputValue>>;
}

export type Progress = (message: string) => void;

export interface Submitted { tx: string[] }

export interface ChainAdapter<Signer> {
  readonly chain: ChainInfo;

  /** A definition by id, decoded (null when this chain does not have it). */
  getDefinition(id: string): Promise<WorkflowDef | null>;
  /** Every note this engine runs (direct chain read; the indexer is the scalable path). */
  listNotes(): Promise<NoteState[]>;
  getNote(id: NoteId): Promise<NoteState | null>;
  /** A note's events in chain order. */
  history(id: NoteId): Promise<Array<{ block: number; tx: string; event: EngineEvent }>>;

  /** Publish a workflow (idempotent). */
  registerDefinition(signer: Signer, bytes: Uint8Array, onProgress?: Progress): Promise<Submitted & { definition: string }>;
  /** Start an issuance and run its pre-trade steps (terms, reserves); the book opens at the end. */
  issue(signer: Signer, req: IssueRequest, onProgress?: Progress): Promise<Submitted & { id: NoteId }>;
  /**
   * Complete a waiting user task or decision: its inputs by field index, and for a decision the chosen
   * outgoing flow. Deposits the step takes are approved and pulled from the signer.
   */
  executeStep(signer: Signer, id: NoteId, step: number, inputs: Record<number, InputValue>, choice?: number, onProgress?: Progress): Promise<Submitted>;
  /** Buy `units` (engine fixed point) from an open book, paying in the note's stablecoin. */
  subscribe(signer: Signer, id: NoteId, units: bigint, onProgress?: Progress): Promise<Submitted>;
  /** Move note units (engine fixed point), in whole or in part. */
  transferUnits(signer: Signer, id: NoteId, to: string, units: bigint, onProgress?: Progress): Promise<Submitted>;
  /** Withdraw a cash or delivered-token balance to the holder's wallet (all of it by default). */
  withdraw(signer: Signer, id: NoteId, asset: number, amount?: bigint, onProgress?: Progress): Promise<Submitted>;
}
