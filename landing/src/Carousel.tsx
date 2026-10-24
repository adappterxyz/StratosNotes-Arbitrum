/**
 * What a note does, in six cards on a slowly turning 3D ring (CSS perspective + rotateY, no library).
 *
 * The ring is sized from its own width (ResizeObserver), so it scales from a 320px phone to a 2560px screen:
 * the front card is ~86% of the width on a phone and ~44% on a desktop (capped at 720px), side cards peek in
 * from the edges, and the card height is the tallest card's natural height at that width (measured, so no
 * text is ever clipped). Each card has its own diagram: shapes in SVG on a fixed 200 x 100 grid, labels in
 * HTML positioned on the same grid, so the text stays readable however large the chart is drawn.
 *
 * Hover or focus pauses it; arrows, dots, swipe and the arrow keys turn it. With reduced motion the ring
 * becomes a static grid. "See this note" opens the full explorer on that card's note and side.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ExplorerStart } from './explorer/start';

interface Label { x: number; y: number; t: string; a?: 'start' | 'middle' | 'end'; tone?: 'soft' | 'pay' | 'warn' | 'alt' }
interface Chart { aria: string; shapes: ReactNode; labels: Label[] }
interface Card {
  side: 'Investors' | 'Issuers';
  title: string;
  body: string;
  note: string;
  chart: Chart;
  start: ExplorerStart;
}

// Every chart is drawn on a 200 x 100 grid (y down). Plot area: x 14–190, y 10–86.
const S = { strokeWidth: 2, vectorEffect: 'non-scaling-stroke' as const, fill: 'none' };
const thin = { strokeWidth: 1, vectorEffect: 'non-scaling-stroke' as const, fill: 'none' };
const baseline = <path d="M14 86H190" stroke="var(--c-axis)" {...thin} />;

const CARDS: Card[] = [
  {
    side: 'Investors', title: 'Earn yield', note: 'Phoenix on ETH',
    body: 'A coupon each quarter while the price stays in range.',
    chart: {
      aria: 'A price path that stays between a floor at 70% and an early-repayment level at 100%, with a coupon paid at each of four dates.',
      shapes: <>
        {baseline}
        <rect x="14" y="30" width="176" height="36" fill="rgba(76,141,255,.10)" />
        <path d="M14 30H190" stroke="var(--c-alt)" strokeDasharray="4 4" {...thin} />
        <path d="M14 66H190" stroke="var(--c-floor)" strokeDasharray="4 4" {...thin} />
        {[70, 110, 150, 190].map(x => <path key={x} d={`M${x} 18V86`} stroke="var(--c-axis)" strokeDasharray="2 4" {...thin} />)}
        <polyline points="14,44 42,50 70,56 90,48 110,60 130,52 150,42 170,47 190,38" stroke="var(--c-line)" {...S} />
        {[[70, 56], [110, 60], [150, 42], [190, 38]].map(([x, y]) => <circle key={x} cx={x} cy={y} r="3.4" fill="var(--c-line)" />)}
        {[70, 110, 150, 190].map(x => <circle key={`c${x}`} cx={x} cy="11" r="5" fill="var(--c-pay)" />)}
      </>,
      labels: [
        { x: 16, y: 21, t: 'early repayment 100%', tone: 'alt' },
        { x: 16, y: 74, t: 'floor 70%', tone: 'warn' },
        { x: 14, y: 3, t: 'coupons', tone: 'pay' },
      ],
    },
    start: { role: 'investor', goal: 'yield', type: 'phoenix', syms: ['ETH'], preset: 'Dip & recover' },
  },
  {
    side: 'Investors', title: 'Protect your capital', note: 'Protected note on BTC',
    body: 'Your money back at maturity, plus a share of any rise.',
    chart: {
      aria: 'Payout at maturity against the final price: flat at 100% below the starting price, rising at half the stock\'s rate above it; the stock alone falls below 100%.',
      shapes: <>
        {baseline}
        <path d="M102 10V86" stroke="var(--c-axis)" strokeDasharray="2 4" {...thin} />
        <polyline points="14,86 102,48 190,10" stroke="var(--c-out)" strokeDasharray="5 4" {...thin} />
        <rect x="14" y="48" width="88" height="38" fill="rgba(47,179,122,.10)" />
        <polyline points="14,48 102,48 190,29" stroke="var(--c-line)" {...S} />
        <circle cx="102" cy="48" r="3.4" fill="var(--c-line)" />
      </>,
      labels: [
        { x: 16, y: 35, t: 'floor: 100% back', tone: 'pay' },
        { x: 188, y: 43, t: 'half of the rise', a: 'end', tone: 'soft' },
        { x: 186, y: 4, t: 'the coin alone', a: 'end' },
        { x: 102, y: 90, t: 'starting price', a: 'middle' },
      ],
    },
    start: { role: 'investor', goal: 'protect', type: 'ppn', syms: ['BTC'], preset: 'Rally' },
  },
  {
    side: 'Investors', title: 'Get exposure to stocks', note: 'Worst-of on TSLA and NVDA',
    body: 'Tesla and NVIDIA in one note. The weaker sets the payout.',
    chart: {
      aria: 'Two stock prices over four dates: TSLA rises, NVDA lags; the note follows NVDA, the weaker one.',
      shapes: <>
        {baseline}
        <path d="M14 48H190" stroke="var(--c-axis)" strokeDasharray="2 4" {...thin} />
        <polyline points="14,48 58,40 102,44 146,30 190,24" stroke="var(--c-out)" {...thin} strokeWidth={1.5} />
        <polyline points="14,48 58,56 102,50 146,60 190,54" stroke="var(--c-line)" {...S} strokeWidth={3} />
        {[[58, 56], [102, 50], [146, 60], [190, 54]].map(([x, y]) => <circle key={x} cx={x} cy={y} r="3.6" fill="var(--c-line)" />)}
      </>,
      labels: [
        { x: 188, y: 18, t: 'TSLA', a: 'end' },
        { x: 188, y: 64, t: 'NVDA, the weaker one, sets the payout', a: 'end', tone: 'pay' },
        { x: 16, y: 36, t: 'start', tone: 'soft' },
      ],
    },
    start: { role: 'investor', goal: 'exposure', type: 'phoenix', syms: ['TSLA', 'NVDA'], preset: 'Choppy' },
  },
  {
    side: 'Investors', title: 'Hedge what you hold', note: 'Reverse convertible on AAPL',
    body: 'Coupons offset part of a slow decline in shares you hold.',
    chart: {
      aria: 'Shares you hold fall from 100 to 80; adding the note\'s coupons, the combined value falls only to about 90.',
      shapes: <>
        {baseline}
        <path d="M14 22H190" stroke="var(--c-axis)" strokeDasharray="2 4" {...thin} />
        <polygon points="14,22 58,30 102,36 146,42 190,50 190,40 146,34 102,30 58,26" fill="rgba(76,141,255,.16)" />
        <polyline points="14,22 58,30 102,36 146,42 190,50" stroke="var(--c-out)" strokeDasharray="5 4" {...thin} strokeWidth={1.5} />
        <polyline points="14,22 58,26 102,30 146,34 190,40" stroke="var(--c-line)" {...S} />
        {[58, 102, 146, 190].map(x => <rect key={x} x={x - 4} y="74" width="8" height="12" rx="1.5" fill="var(--c-pay)" />)}
      </>,
      labels: [
        { x: 188, y: 9, t: 'shares + coupons', a: 'end', tone: 'pay' },
        { x: 188, y: 56, t: 'shares alone', a: 'end', tone: 'soft' },
        { x: 16, y: 70, t: 'coupons', tone: 'pay' },
      ],
    },
    start: { role: 'investor', goal: 'hedge', type: 'reverse-convertible', syms: ['AAPL'], preset: 'Flat', physical: true },
  },
  {
    side: 'Issuers', title: 'Raise funding', note: 'Fixed coupon note on ETH',
    body: 'Raise USDG today against collateral locked in the note.',
    chart: {
      aria: 'Funding comes in at the start; collateral is locked for the whole term; small payments go out each quarter and the repayment at the end, after which the collateral is released.',
      shapes: <>
        <path d="M14 50H190" stroke="var(--c-axis)" {...thin} />
        <rect x="18" y="12" width="20" height="38" rx="3" fill="var(--c-pay)" />
        <rect x="14" y="62" width="160" height="16" rx="4" {...thin} fill="rgba(111,163,255,.14)" stroke="var(--c-alt)" />
        <path d="M30 66v-3a4 4 0 0 1 8 0v3" stroke="var(--c-alt)" {...thin} strokeWidth={1.6} />
        <rect x="28" y="66" width="12" height="9" rx="1.5" fill="var(--c-alt)" />
        {[70, 110, 150].map(x => <rect key={x} x={x - 6} y="50" width="12" height="7" rx="1.5" fill="var(--c-out)" />)}
        <rect x="176" y="50" width="14" height="34" rx="2" fill="var(--c-out)" />
      </>,
      labels: [
        { x: 42, y: 20, t: 'funding raised' , tone: 'pay' },
        { x: 46, y: 72, t: 'collateral locked', tone: 'alt' },
        { x: 110, y: 40, t: 'coupons', a: 'middle', tone: 'soft' },
        { x: 172, y: 96, t: 'repaid, released', a: 'end', tone: 'soft' },
      ],
    },
    start: { role: 'issuer', goal: 'fund', type: 'fcn', syms: ['ETH'], preset: 'Flat' },
  },
  {
    side: 'Issuers', title: 'Pay as you go', note: 'Phoenix on BTC',
    body: 'Fund each payment when due. Miss one and collateral pays holders.',
    chart: {
      aria: 'Four payment dates: the issuer funds three on time; the fourth is missed, the grace period runs out, and the collateral pays the holders.',
      shapes: <>
        <path d="M14 34H190" stroke="var(--c-axis)" {...thin} />
        {[30, 76, 122].map(x => (
          <g key={x}>
            <rect x={x - 9} y="12" width="18" height="16" rx="3" fill="var(--c-pay)" />
            <circle cx={x} cy="34" r="6" fill="var(--c-pay)" />
            <path d={`M${x - 3} 34l2 2.6 4.2-5`} stroke="var(--c-ink)" {...thin} strokeWidth={1.6} />
          </g>
        ))}
        <rect x="159" y="12" width="18" height="16" rx="3" {...thin} fill="none" stroke="var(--c-floor)" strokeDasharray="3 3" />
        <circle cx="168" cy="34" r="6" {...thin} fill="none" stroke="var(--c-floor)" strokeWidth={1.6} />
        <path d="M168 40V58" stroke="var(--c-floor)" {...thin} strokeWidth={1.6} />
        <rect x="104" y="60" width="86" height="28" rx="4" {...thin} fill="rgba(111,163,255,.14)" stroke="var(--c-alt)" />
      </>,
      labels: [
        { x: 30, y: 46, t: 'funded', a: 'middle', tone: 'pay' },
        { x: 76, y: 46, t: 'funded', a: 'middle', tone: 'pay' },
        { x: 122, y: 46, t: 'funded', a: 'middle', tone: 'pay' },
        { x: 168, y: 2, t: 'missed + grace', a: 'middle', tone: 'warn' },
        { x: 147, y: 63, t: 'collateral', a: 'middle', tone: 'alt' },
        { x: 147, y: 74, t: 'pays the holders', a: 'middle', tone: 'alt' },
      ],
    },
    start: { role: 'issuer', goal: 'clients', type: 'phoenix', syms: ['BTC'], preset: 'Crash' },
  },
];

const N = CARDS.length;
const STEP = 360 / N;
const AUTO_MS = 4600;

interface Dims { w: number; r: number; persp: number; h: number }

/** Card width, ring radius and perspective from the ring's width (px). */
function size(W: number): Omit<Dims, 'h'> {
  // Phone: front card ~86% wide, side cards peek in at the edges. Tablet: ~60%. Desktop: ~44%, capped at 720.
  const w = W < 600 ? Math.round(W * 0.86) : W < 1000 ? Math.round(W * 0.6) : Math.round(Math.min(720, Math.max(440, W * 0.44)));
  // On wide screens the radius also grows with the screen, so the ring keeps spanning ~90% of the width
  // even once the front card stops growing.
  const r = Math.round(W < 600 ? w * 0.8 : W < 1000 ? w * 0.95 : Math.max(w * 1.06, W * 0.46));
  const persp = Math.round(Math.max(900, w * 3.4, r * 3));
  return { w, r, persp };
}

export default function Carousel({ onOpen }: { onOpen: (s: ExplorerStart) => void }) {
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [dims, setDims] = useState<Dims | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; id: number } | null>(null);
  const front = ((idx % N) + N) % N;

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  // Size from the ring's own width; card height = the tallest card's natural height at that width.
  const measure = useCallback(() => {
    const box = boxRef.current, m = measureRef.current;
    if (!box || !m) return;
    const base = size(box.clientWidth);
    m.style.width = `${base.w}px`;
    const h = Math.ceil(Math.max(...[...m.children].map(c => (c as HTMLElement).offsetHeight)));
    setDims(d => (d && d.w === base.w && d.h === h && d.r === base.r ? d : { ...base, h }));
  }, []);
  useLayoutEffect(() => {
    if (reduced) return;
    measure();
    const ro = new ResizeObserver(() => measure());
    if (boxRef.current) ro.observe(boxRef.current);
    if (measureRef.current) ro.observe(measureRef.current);
    document.fonts?.ready.then(() => measure()).catch(() => {});
    return () => ro.disconnect();
  }, [reduced, measure]);

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

  const style = dims ? {
    '--cr-w': `${dims.w}px`, '--cr-h': `${dims.h}px`, '--cr-r': `${dims.r}px`, '--cr-p': `${dims.persp}px`,
  } as React.CSSProperties : undefined;

  return (
    <div
      ref={boxRef}
      className={`cr${dims ? ' ready' : ''}`}
      style={style}
      role="region"
      aria-roledescription="carousel"
      aria-label="What a note can do"
      tabIndex={0}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setPaused(false); }}
      onKeyDown={e => {
        if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      }}
    >
      {/* Off-screen copies at the front card's width, to find the tallest card. */}
      <div className="cr-measure" ref={measureRef} aria-hidden="true" inert>
        {CARDS.map(c => <CardBody key={c.title} c={c} onOpen={() => {}} />)}
      </div>
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
            const dist = Math.min((i - front + N) % N, (front - i + N) % N);
            return (
              <div
                key={c.title}
                className={`cr-slot${dist === 0 ? ' front' : ''}`}
                style={{ transform: `rotateY(${i * STEP}deg) translateZ(var(--cr-r))`, opacity: dist === 0 ? 1 : dist === 1 ? 0.5 : 0.14 }}
                aria-hidden={dist !== 0}
                inert={dist !== 0 ? true : undefined}
                role="group"
                aria-roledescription="slide"
                aria-label={`${i + 1} of ${N}: ${c.title}`}
                onClick={dist === 1 ? () => go((i - front + N) % N === 1 ? 1 : -1) : undefined}
              >
                <CardBody c={c} onOpen={onOpen} />
              </div>
            );
          })}
        </div>
      </div>
      <div className="cr-controls">
        <button type="button" className="cr-arrow" onClick={() => go(-1)} aria-label="Previous card">←</button>
        <div className="cr-dots" role="tablist" aria-label="Choose a card">
          {CARDS.map((c, i) => (
            <button
              key={c.title} type="button" role="tab" aria-selected={i === front} aria-label={c.title}
              className={i === front ? 'on' : ''}
              onClick={() => { const d = (i - front + N) % N; setIdx(idx + (d <= N / 2 ? d : d - N)); }}
            ><span /></button>
          ))}
        </div>
        <button type="button" className="cr-arrow" onClick={() => go(1)} aria-label="Next card">→</button>
      </div>
    </div>
  );
}

function ChartView({ c }: { c: Chart }) {
  return (
    <div className="cr-chart" role="img" aria-label={c.aria}>
      <svg viewBox="0 0 200 100" preserveAspectRatio="xMidYMid meet" aria-hidden="true">{c.shapes}</svg>
      {c.labels.map(l => (
        <span
          key={l.t + l.x}
          className={`mc-lbl ${l.tone ?? ''}`}
          style={{ left: `calc(6% + ${(l.x / 200) * 88}%)`, top: `calc(6% + ${(l.y / 100) * 88}%)`, transform: l.a === 'end' ? 'translateX(-100%)' : l.a === 'middle' ? 'translateX(-50%)' : undefined }}
        >{l.t}</span>
      ))}
    </div>
  );
}

function CardBody({ c, onOpen }: { c: Card; onOpen: (s: ExplorerStart) => void }) {
  return (
    <article className={`cr-card ${c.side === 'Issuers' ? 'issuer' : 'investor'}`}>
      <span className="cr-side">For {c.side.toLowerCase()}</span>
      <h3>{c.title}</h3>
      <ChartView c={c.chart} />
      <p>{c.body}</p>
      <div className="cr-foot">
        <span className="cr-note">{c.note} · illustration</span>
        <button type="button" className="cr-open" onClick={() => onOpen(c.start)}>See this note →</button>
      </div>
    </article>
  );
}
