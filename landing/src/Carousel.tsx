/**
 * What a note can do, in six plain cards on a slowly turning 3D ring (CSS perspective + rotateY, no library).
 * The front card is readable from the first frame; hover or focus pauses it; arrows, swipe and the keyboard
 * turn it. With reduced motion the ring becomes a static grid. "See this note" opens the full explorer on
 * that card's note and side.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ExplorerStart } from './explorer/start';

interface Card {
  side: 'Investors' | 'Issuers';
  title: string;
  body: string;
  note: string;
  chart: ReactNode;
  start: ExplorerStart;
}

// Mini charts: illustrations on a 0–120 × 0–60 grid (y down). Each one is drawn to its own scale and labelled.
const axis = <path d="M8 52H114" stroke="var(--c-axis)" strokeWidth="1" />;

const CARDS: Card[] = [
  {
    side: 'Investors', title: 'Earn yield', note: 'Phoenix on ETH',
    body: 'Get paid a coupon every quarter while the price stays above a floor, even if it drifts down a little.',
    chart: (
      <svg viewBox="0 0 120 60" role="img" aria-label="Price staying above a floor, with a coupon paid at each of four dates">
        {axis}
        <path d="M8 40H114" stroke="var(--c-floor)" strokeDasharray="3 3" strokeWidth="1" />
        <text x="114" y="37" textAnchor="end" className="mc-lbl">floor 70%</text>
        <polyline points="8,24 33,30 58,36 83,28 108,20" fill="none" stroke="var(--c-line)" strokeWidth="2" />
        {[33, 58, 83, 108].map(x => <circle key={x} cx={x} cy="12" r="3.2" fill="var(--c-pay)" />)}
        <text x="8" y="14" className="mc-lbl">coupons</text>
      </svg>
    ),
    start: { role: 'investor', goal: 'yield', type: 'phoenix', syms: ['ETH'], preset: 'Dip & recover' },
  },
  {
    side: 'Investors', title: 'Protect your capital', note: 'Protected note on BTC',
    body: 'Get your money back at maturity whatever happens, plus a share of any rise.',
    chart: (
      <svg viewBox="0 0 120 60" role="img" aria-label="Payout at maturity: flat at 100% below the start, rising above it">
        {axis}
        <path d="M60 52V8" stroke="var(--c-axis)" strokeDasharray="2 3" strokeWidth="1" />
        <polyline points="8,30 60,30 112,8" fill="none" stroke="var(--c-line)" strokeWidth="2" />
        <text x="10" y="26" className="mc-lbl">100% back</text>
        <text x="62" y="58" className="mc-lbl">start</text>
      </svg>
    ),
    start: { role: 'investor', goal: 'protect', type: 'ppn', syms: ['BTC'], preset: 'Rally' },
  },
  {
    side: 'Investors', title: 'Get exposure to stocks', note: 'Worst-of on TSLA and NVDA',
    body: 'Take a view on Tesla and NVIDIA together, priced by Chainlink, on terms set before you buy.',
    chart: (
      <svg viewBox="0 0 120 60" role="img" aria-label="Two stock prices over four dates; the note follows the weaker one">
        {axis}
        <polyline points="8,30 33,22 58,26 83,16 108,12" fill="none" stroke="var(--c-alt)" strokeWidth="1.6" />
        <polyline points="8,30 33,36 58,28 83,34 108,24" fill="none" stroke="var(--c-line)" strokeWidth="2" />
        <text x="110" y="10" textAnchor="end" className="mc-lbl">TSLA</text>
        <text x="110" y="34" textAnchor="end" className="mc-lbl">NVDA, the weaker one</text>
      </svg>
    ),
    start: { role: 'investor', goal: 'exposure', type: 'phoenix', syms: ['TSLA', 'NVDA'], preset: 'Choppy' },
  },
  {
    side: 'Investors', title: 'Hedge what you hold', note: 'Reverse convertible on AAPL',
    body: 'Earn a coupon on a stock you already own, and take delivery of more of it only if it falls far.',
    chart: (
      <svg viewBox="0 0 120 60" role="img" aria-label="Payout: capped at par plus coupons above a barrier, falling with the stock below it">
        {axis}
        <path d="M44 52V8" stroke="var(--c-floor)" strokeDasharray="3 3" strokeWidth="1" />
        <polyline points="8,46 44,24 44,14 112,14" fill="none" stroke="var(--c-line)" strokeWidth="2" />
        <text x="112" y="10" textAnchor="end" className="mc-lbl">par + coupons</text>
        <text x="46" y="58" className="mc-lbl">barrier</text>
      </svg>
    ),
    start: { role: 'investor', goal: 'hedge', type: 'reverse-convertible', syms: ['AAPL'], preset: 'Flat', physical: true },
  },
  {
    side: 'Issuers', title: 'Raise funding', note: 'Fixed coupon note on ETH',
    body: 'Raise stablecoins from investors today, against collateral you pledge and cannot withdraw until you have paid.',
    chart: (
      <svg viewBox="0 0 120 60" role="img" aria-label="Funding raised at the start, then smaller payments each quarter and the repayment at the end">
        <path d="M8 30H114" stroke="var(--c-axis)" strokeWidth="1" />
        <rect x="12" y="6" width="12" height="24" rx="2" fill="var(--c-pay)" />
        {[36, 60, 84].map(x => <rect key={x} x={x} y="30" width="10" height="4" rx="1.5" fill="var(--c-out)" />)}
        <rect x="102" y="30" width="10" height="26" rx="2" fill="var(--c-out)" />
        <text x="27" y="12" className="mc-lbl">raised</text>
        <text x="98" y="26" textAnchor="end" className="mc-lbl">repaid</text>
      </svg>
    ),
    start: { role: 'issuer', goal: 'fund', type: 'fcn', syms: ['ETH'], preset: 'Flat' },
  },
  {
    side: 'Issuers', title: 'Pay as you go, safely', note: 'Phoenix on BTC',
    body: 'Fund each coupon when it falls due. If a payment is missed, the collateral pays the holders instead.',
    chart: (
      <svg viewBox="0 0 120 60" role="img" aria-label="Four payment dates: three funded, one missed and covered by the collateral">
        <path d="M14 30H106" stroke="var(--c-axis)" strokeWidth="1" />
        {[14, 44, 74].map(x => (
          <g key={x}><circle cx={x} cy="30" r="7" fill="var(--c-pay)" /><path d={`M${x - 3} 30l2 2.5 4-5`} stroke="var(--c-ink)" strokeWidth="1.6" fill="none" /></g>
        ))}
        <circle cx="104" cy="30" r="7" fill="none" stroke="var(--c-floor)" strokeWidth="1.6" />
        <path d="M104 40l-7 3v5c0 4 3 6.5 7 8 4-1.5 7-4 7-8v-5z" fill="var(--c-alt)" />
        <text x="96" y="16" textAnchor="end" className="mc-lbl">missed: collateral pays</text>
      </svg>
    ),
    start: { role: 'issuer', goal: 'clients', type: 'phoenix', syms: ['BTC'], preset: 'Crash' },
  },
];

const STEP = 360 / CARDS.length;
const AUTO_MS = 4200;

export default function Carousel({ onOpen }: { onOpen: (s: ExplorerStart) => void }) {
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const drag = useRef<{ x: number; id: number } | null>(null);
  const front = ((idx % CARDS.length) + CARDS.length) % CARDS.length;

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  // Slow auto-rotation; stops while hovered or focused, and while the tab is hidden.
  useEffect(() => {
    if (reduced || paused) return;
    const t = window.setInterval(() => { if (!document.hidden) setIdx(i => i + 1); }, AUTO_MS);
    return () => clearInterval(t);
  }, [reduced, paused]);

  const go = useCallback((d: number) => setIdx(i => i + d), []);

  if (reduced) {
    return (
      <div className="cr-static">
        {CARDS.map(c => <CardBody key={c.title} c={c} onOpen={onOpen} />)}
      </div>
    );
  }

  return (
    <div
      className="cr"
      role="region"
      aria-roledescription="carousel"
      aria-label="What a note can do"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setPaused(false); }}
      onKeyDown={e => {
        if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      }}
    >
      <div
        className="cr-stage"
        onPointerDown={e => { drag.current = { x: e.clientX, id: e.pointerId }; }}
        onPointerUp={e => {
          const d = drag.current; drag.current = null;
          if (d && d.id === e.pointerId && Math.abs(e.clientX - d.x) > 40) go(e.clientX < d.x ? 1 : -1);
        }}
        onPointerCancel={() => { drag.current = null; }}
      >
        <div className="cr-ring" style={{ transform: `translateZ(calc(-1 * var(--cr-r))) rotateY(${-idx * STEP}deg)` }}>
          {CARDS.map((c, i) => {
            // Angular distance from the front, in steps (0 = front).
            const dist = Math.min((i - front + CARDS.length) % CARDS.length, (front - i + CARDS.length) % CARDS.length);
            return (
              <div
                key={c.title}
                className={`cr-slot${dist === 0 ? ' front' : ''}`}
                style={{ transform: `rotateY(${i * STEP}deg) translateZ(var(--cr-r))`, opacity: dist === 0 ? 1 : dist === 1 ? 0.42 : 0.12 }}
                aria-hidden={dist !== 0}
                inert={dist !== 0 ? true : undefined}
                role="group"
                aria-roledescription="slide"
                aria-label={`${i + 1} of ${CARDS.length}: ${c.title}`}
              >
                <CardBody c={c} onOpen={onOpen} />
              </div>
            );
          })}
        </div>
      </div>
      <div className="cr-controls">
        <button type="button" className="cr-arrow" onClick={() => go(-1)} aria-label="Previous">←</button>
        <div className="cr-dots" role="tablist" aria-label="Choose a card">
          {CARDS.map((c, i) => (
            <button
              key={c.title} type="button" role="tab" aria-selected={i === front} aria-label={c.title}
              className={i === front ? 'on' : ''}
              onClick={() => setIdx(idx + ((i - front + CARDS.length) % CARDS.length <= CARDS.length / 2 ? (i - front + CARDS.length) % CARDS.length : (i - front + CARDS.length) % CARDS.length - CARDS.length))}
            />
          ))}
        </div>
        <button type="button" className="cr-arrow" onClick={() => go(1)} aria-label="Next">→</button>
      </div>
    </div>
  );
}

function CardBody({ c, onOpen }: { c: Card; onOpen: (s: ExplorerStart) => void }) {
  return (
    <article className={`cr-card ${c.side === 'Issuers' ? 'issuer' : 'investor'}`}>
      <span className="cr-side">For {c.side.toLowerCase()}</span>
      <h3>{c.title}</h3>
      <div className="cr-chart">{c.chart}</div>
      <p>{c.body}</p>
      <div className="cr-foot">
        <span className="cr-note">{c.note} · illustration</span>
        <button type="button" className="cr-open" onClick={() => onOpen(c.start)}>See this note →</button>
      </div>
    </article>
  );
}
