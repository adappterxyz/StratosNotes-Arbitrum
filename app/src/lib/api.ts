/**
 * The API client (services/api). The app reads every note, portfolio and template from here; it writes to
 * chains directly through the SDK (lib/chains.tsx).
 */
import type { TemplateEntry, TemplateSummary, WorkflowDraft } from '@sn/core';
import type { ChainInfo, NoteState, NoteView } from '@sn/sdk';

export interface ChainConfig extends ChainInfo {
  rpc: string;
  engine: `0x${string}`;
  lens: `0x${string}`;
  fromBlock: number;
  stablecoin: { symbol: string; address: `0x${string}`; decimals: number };
  /** The API mints the stablecoin (local dev chains). */
  faucet: boolean;
  /** Testnets: the on-chain TokenFaucet, claimed from with the user's own wallet. */
  tokenFaucet: `0x${string}` | null;
  /** Test tokens by symbol (tUSD, tETH, tTSLA…): what physically settled notes deliver. */
  tokens: Record<string, `0x${string}`>;
}
export interface AppConfig { chains: ChainConfig[]; ai: boolean }

export interface NoteItem { id: string; chain: string; definition: string; view: NoteView }
export interface NoteDetail { state: NoteState; view: NoteView }
export interface HistoryEvent { seq: number; name: string; block: number; tx: string; at: number; data: Record<string, unknown> }
export interface PortfolioItem extends NoteItem { position: { units: number; cash: number; holdings: NoteState['holdings'] } }

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const j = await r.json().catch(() => null) as (T & { error?: string }) | null;
  if (!r.ok) throw new ApiError(r.status, j?.error ?? `The API answered ${r.status}.`);
  return j as T;
}

export interface NoteFilters { chain?: string; status?: 'book' | 'live' | 'redeemed' | 'active' | 'all'; underlying?: string; product?: string; q?: string; limit?: number; cursor?: string }

export const api = {
  config: () => call<AppConfig>('/api/config'),
  notes: (f: NoteFilters = {}) => {
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]));
    return call<{ notes: NoteItem[]; next: string | null }>(`/api/notes?${qs}`);
  },
  note: (id: string) => call<NoteDetail>(`/api/notes/${encodeURIComponent(id)}`),
  history: (id: string) => call<{ events: HistoryEvent[] }>(`/api/notes/${encodeURIComponent(id)}/history`),
  definition: (chain: string, id: string) => call<{ id: string; bytes: `0x${string}` }>(`/api/definitions/${chain}/${id}`),
  portfolio: (address: string) => call<{ positions: PortfolioItem[] }>(`/api/portfolio/${address}`),
  templates: () => call<TemplateSummary[]>('/api/templates'),
  template: (definition: string) => call<TemplateEntry>(`/api/templates/${definition}`),
  saveTemplate: (entry: Omit<TemplateEntry, 'createdAt'>, signature: string) =>
    call<TemplateSummary>('/api/templates', { method: 'POST', body: JSON.stringify({ entry, signature }) }),
  ai: (prompt: string, draft?: WorkflowDraft) => call<unknown>('/api/ai', { method: 'POST', body: JSON.stringify({ prompt, draft }) }),
  faucet: (chain: string, address: string) => call<{ tx: string; amount: string; symbol: string }>('/api/faucet', { method: 'POST', body: JSON.stringify({ chain, address }) }),
};
