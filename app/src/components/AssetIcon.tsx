/**
 * Asset marks: a small neutral circle with the asset's logo, next to its ticker (the ticker always stays as text).
 *
 * Marks come from simple-icons (CC0-1.0): Bitcoin, Ethereum, Solana, Tesla, NVIDIA, Apple, Netflix. They identify the
 * asset (nominative use); trademarks belong to their owners. Where no openly licensed mark exists (AMZN, SPY, USDG,
 * HYPE) a plain text badge is shown instead of a lookalike. Sources: app/public/assets/SOURCES.md.
 *
 * Variants: test tokens (tETH, tTSLA…) carry a small "t" tag; receipts for collateral held on Robinhood Chain
 * (TSLA.rh, USDG.rh…) carry a small Robinhood Chain tag.
 */
import { siApple, siBitcoin, siEthereum, siNetflix, siNvidia, siSolana, siTesla } from 'simple-icons';

type Mark = { path: string; hex: string; title: string };
const MARKS: Record<string, Mark> = {
  BTC: { path: siBitcoin.path, hex: siBitcoin.hex, title: 'Bitcoin' },
  ETH: { path: siEthereum.path, hex: siEthereum.hex, title: 'Ethereum' },
  SOL: { path: siSolana.path, hex: siSolana.hex, title: 'Solana' },
  TSLA: { path: siTesla.path, hex: siTesla.hex, title: 'Tesla' },
  NVDA: { path: siNvidia.path, hex: siNvidia.hex, title: 'NVIDIA' },
  AAPL: { path: siApple.path, hex: siApple.hex, title: 'Apple' },
  NFLX: { path: siNetflix.path, hex: siNetflix.hex, title: 'Netflix' },
};
/** No openly licensed mark: a short text badge (never a drawn lookalike). */
const BADGES: Record<string, string> = { AMZN: 'AMZN', SPY: 'S&P', USDG: '$G', USDC: '$C', TUSD: '$t', HYPE: 'HY' };

/** "tTSLA" -> { base: TSLA, test }, "TSLA.rh" -> { base: TSLA, rh }, "USDG" -> { base: USDG }. */
export function parseAsset(sym: string): { base: string; test: boolean; rh: boolean } {
  let s = sym.trim();
  const rh = /\.rh$/i.test(s);
  if (rh) s = s.slice(0, -3);
  let test = false;
  if (s === 'tUSD') return { base: 'TUSD', test: true, rh };
  if (/^t[A-Z]{2,}$/.test(s)) { test = true; s = s.slice(1); }
  return { base: s.toUpperCase(), test, rh };
}

export function AssetIcon({ sym, size = 18, title }: { sym: string; size?: number; title?: string }) {
  const { base, test, rh } = parseAsset(sym);
  const mark = MARKS[base];
  const label = title ?? `${mark?.title ?? base}${test ? ' (test token)' : ''}${rh ? ' (held on Robinhood Chain)' : ''}`;
  return (
    <span className="asset-ic" style={{ width: size, height: size }} role="img" aria-label={label} title={label}>
      {mark ? (
        <svg viewBox="0 0 24 24" width={size * 0.62} height={size * 0.62} aria-hidden="true"><path d={mark.path} fill={`#${mark.hex}`} /></svg>
      ) : (
        <span className="asset-badge" style={{ fontSize: Math.max(7, size * (BADGES[base]?.length > 2 ? 0.3 : 0.38)) }} aria-hidden="true">{BADGES[base] ?? base.slice(0, 3)}</span>
      )}
      {test && <span className="asset-tag t" aria-hidden="true">t</span>}
      {rh && <span className="asset-tag rh" aria-hidden="true"><img src={`${import.meta.env.BASE_URL}assets/robinhood-feather.svg`} alt="" /></span>}
    </span>
  );
}

/** Ticker with its mark: the ticker text always stays. */
export function Asset({ sym, size = 18, className }: { sym: string; size?: number; className?: string }) {
  return <span className={`asset ${className ?? ''}`}><AssetIcon sym={sym} size={size} /><span className="asset-sym">{sym}</span></span>;
}

/** A worst-of basket: overlapping marks, then the tickers. */
export function AssetStack({ syms, size = 20, label = true }: { syms: string[]; size?: number; label?: boolean }) {
  if (!syms.length) return null;
  return (
    <span className="asset-stack">
      <span className="asset-stack-ics" style={{ marginRight: syms.length > 1 ? 2 : 0 }}>
        {syms.map((s, i) => <span key={s} style={{ marginLeft: i ? -size * 0.32 : 0, zIndex: syms.length - i }}><AssetIcon sym={s} size={size} /></span>)}
      </span>
      {label && <span className="asset-sym">{syms.length > 1 ? `worst of ${syms.join(', ')}` : syms[0]}</span>}
    </span>
  );
}
