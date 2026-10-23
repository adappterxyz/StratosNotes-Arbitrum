import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import './notes.css';
import { EDGES, STEPS, type Chain } from './lifecycle';
import proofJson from './proof.json';

const APP_URL = '/app/';
const REPO_URL = 'https://github.com/adappterxyz/StratosNotes-Arbitrum';
const FLOW_URL = 'https://stratoslab.app';
const SOLANA_BUILD = 'https://sp.stratoslab.app';

const CHAIN: Chain = 'evm';

// Written by scripts/landing-proof.ts from deployments/*.json and docs/evidence.json: no typed-in numbers.
type Deployment = { key: string; name: string; explorer: string } & (
  | { deployed: false }
  | { deployed: true; engine: string; lens: string; faucet: string | null; forwarder: string; block: number; tokens: Record<string, string> }
);
interface Run {
  chain: string; note: string; title: string; reporter: 'cre' | 'fallback';
  events: Array<{ what: string; detail: string; tx: string; gas?: string }>;
  paid: Array<{ holder: string; units: string; paid: string }>;
}
const proof = proofJson as unknown as { generatedAt: string; deployments: Deployment[]; runs: Run[] };
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// What people use structured notes for, in TradFi and DeFi alike.
const USES = [
  { k: 'Yield', v: 'Extra income while prices stay in a range: a coupon each period the underlying holds above a barrier.' },
  { k: 'Capital protection', v: 'Principal back at maturity whatever the market does, with a share of any rise.' },
  { k: 'Exposure', v: 'A defined position on a stock, an index or a basket, on terms agreed upfront.' },
  { k: 'Hedging', v: 'Cap the downside on holdings, or trade some upside for income you can count on.' },
];

// Verified on local forks of both testnets (scripts/e2e-cre-evm.sh, scripts/dev-local.sh) and in Foundry.
const LOCAL = [
  { v: '21 / 21', k: 'Foundry tests: 13 product scenarios pay the reference payoff, plus faucet and access checks' },
  { v: '254k', k: 'gas to subscribe; the largest report in the product runs is 426k' },
  { v: '630 / 420', k: 'test USD paid to two investors (600 and 400 units) in a phoenix run by Chainlink\'s CRE simulator on an Arbitrum Sepolia fork' },
  { v: '2.22M', k: 'gas for a coupon to a full book of 62 holders, under the 2.8M report limit' },
];

export default function Landing() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState('observe');
  const step = STEPS.find(s => s.id === active)!;

  // Terrain, nav state, reveals (shared with the Flow landing).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const cleanups: Array<() => void> = [];
    document.documentElement.classList.add('sn-smooth');
    cleanups.push(() => document.documentElement.classList.remove('sn-smooth'));

    (function terrain() {
      const canvas = root.querySelector<HTMLCanvasElement>('#bg-canvas');
      if (!canvas) return;
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const scene = new THREE.Scene();
      scene.fog = new THREE.FogExp2(0x050b0a, 0.055);
      const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 100);
      camera.position.set(0, 3.4, 9);
      camera.lookAt(0, -1.2, -6);
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.8));
      renderer.setSize(window.innerWidth, window.innerHeight);
      const COLS = 90, ROWS = 90, SIZE = 44;
      const geo = new THREE.PlaneGeometry(SIZE, SIZE, COLS, ROWS);
      geo.rotateX(-Math.PI / 2);
      const pos = geo.attributes.position;
      const colors = new Float32Array(pos.count * 3);
      const cA = new THREE.Color(0x10b981), cB = new THREE.Color(0x2dd4bf), cC = new THREE.Color(0xa78bfa);
      const tmp = new THREE.Color();
      for (let i = 0; i < pos.count; i++) {
        const tt = (pos.getZ(i) + SIZE / 2) / SIZE;
        if (tt < 0.5) tmp.copy(cC).lerp(cB, tt * 2); else tmp.copy(cB).lerp(cA, (tt - 0.5) * 2);
        colors[i * 3] = tmp.r; colors[i * 3 + 1] = tmp.g; colors[i * 3 + 2] = tmp.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      const mat = new THREE.MeshBasicMaterial({ wireframe: true, vertexColors: true, transparent: true, opacity: 0.42 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.y = -2.6;
      scene.add(mesh);
      const base = new Float32Array(pos.count);
      for (let i = 0; i < pos.count; i++) base[i] = pos.getY(i);
      let mx = 0, my = 0, tmx = 0, tmy = 0, scrollY = 0;
      const onPointer = (e: PointerEvent) => { tmx = e.clientX / window.innerWidth - 0.5; tmy = e.clientY / window.innerHeight - 0.5; };
      const onScroll = () => { scrollY = window.scrollY; };
      window.addEventListener('pointermove', onPointer);
      window.addEventListener('scroll', onScroll, { passive: true });
      const wave = (x: number, z: number, tt: number) => Math.sin(x * 0.4 + tt * 0.7) * 0.55 + Math.cos(z * 0.45 + tt * 0.55) * 0.5 + Math.sin((x + z) * 0.28 + tt * 0.9) * 0.4 + Math.sin(Math.sqrt(x * x + z * z) * 0.5 - tt * 1.1) * 0.35;
      const clock = new THREE.Clock();
      let raf = 0, stopped = false;
      const animate = () => {
        if (stopped) return;
        raf = requestAnimationFrame(animate);
        const tt = clock.getElapsedTime() * (reduce ? 0.15 : 1);
        const pa = geo.attributes.position;
        for (let i = 0; i < pa.count; i++) pa.setY(i, base[i] + wave(pa.getX(i), pa.getZ(i), tt) * 0.6);
        pa.needsUpdate = true;
        mx += (tmx - mx) * 0.04; my += (tmy - my) * 0.04;
        camera.position.x = mx * 2.2;
        camera.position.y = 3.4 - my * 1.2 - Math.min(scrollY, 1400) * 0.0016;
        camera.lookAt(0, -1.2, -6);
        mesh.rotation.z = mx * 0.04;
        renderer.render(scene, camera);
      };
      animate();
      const onResize = () => { camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight); };
      window.addEventListener('resize', onResize);
      const onVisible = () => { if (document.hidden) { stopped = true; cancelAnimationFrame(raf); } else if (stopped) { stopped = false; animate(); } };
      document.addEventListener('visibilitychange', onVisible);
      cleanups.push(() => {
        stopped = true; cancelAnimationFrame(raf);
        window.removeEventListener('pointermove', onPointer); window.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onResize); document.removeEventListener('visibilitychange', onVisible);
        geo.dispose(); mat.dispose(); renderer.dispose();
      });
    })();

    (function nav() {
      const header = root.querySelector('header.nav');
      if (!header) return;
      const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 30);
      onScroll();
      window.addEventListener('scroll', onScroll, { passive: true });
      cleanups.push(() => window.removeEventListener('scroll', onScroll));
    })();

    (function reveals() {
      root.classList.add('js');
      const els = [...root.querySelectorAll<HTMLElement>('[data-reveal]')];
      const reveal = (el: Element) => el.classList.add('in');
      const io = new IntersectionObserver(entries => entries.forEach(en => { if (en.isIntersecting) { reveal(en.target); io.unobserve(en.target); } }), { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
      els.forEach(el => io.observe(el));
      const firstPass = () => { const vh = window.innerHeight || 800; els.forEach(el => { if (el.getBoundingClientRect().top < vh * 0.96) { reveal(el); io.unobserve(el); } }); };
      const raf = requestAnimationFrame(firstPass);
      const t1 = window.setTimeout(firstPass, 250);
      const t2 = window.setTimeout(() => els.forEach(reveal), 2600);
      cleanups.push(() => { io.disconnect(); cancelAnimationFrame(raf); clearTimeout(t1); clearTimeout(t2); });
    })();

    return () => { cleanups.forEach(fn => fn()); root.classList.remove('js'); };
  }, []);


  const pos = (id: string) => STEPS.find(s => s.id === id)!;
  const live = proof.deployments.filter((d): d is Extract<Deployment, { deployed: true }> => d.deployed);
  return (
    <div className="sn-root" ref={rootRef}>
      <canvas id="bg-canvas" />
      <div className="bg-veil" />
      <div className="bg-grain" />

      <header className="nav">
        <div className="nav-inner">
          <a className="brand" href="#top" aria-label="StratosNotes home">
            <img className="mark" src="/logos/stratos-mark.png" alt="" width={28} height={28} />
            <span>StratosNotes</span>
          </a>
          <nav className="nav-links">
            <a href="#why-notes">Why notes</a>
            <a href="#how">How it works</a>
            <a href="#lifecycle">Lifecycle</a>
            <a href="#arbitrum">Why Arbitrum</a>
            <a href="#proof">Proof</a>
            <a href={REPO_URL} target="_blank" rel="noopener">Code</a>
          </nav>
          <div className="nav-cta">
            <a href={APP_URL} className="btn btn-primary">Open the app <span className="arrow">→</span></a>
          </div>
        </div>
      </header>

      <main id="top">
        <section className="hero">
          <div className="wrap hero-inner">
            <div className="badge" data-reveal>
              <span className="dot" />
              <span><b>Arbitrum Sepolia · Robinhood Chain testnet</b> · observed and paid by Chainlink CRE</span>
            </div>
            <h1 data-reveal data-reveal-d="1">
              Structured notes on stocks and crypto,<br /><span className="grad-text">on Arbitrum.</span>
            </h1>
            <p className="sub" data-reveal data-reveal-d="2">
              Design a note from a template, a term sheet, a sentence or a BPMN diagram, on one asset or a worst-of
              basket of crypto or stocks. Sell it for stablecoins, let holders transfer it, and let Chainlink CRE fix
              the strike, observe every date and pay every coupon and redemption on-chain.
            </p>
            <div className="hero-cta" data-reveal data-reveal-d="3">
              <a href={APP_URL} className="btn btn-primary">Issue a note <span className="arrow">→</span></a>
              <a href="#why-notes" className="btn btn-ghost">Why structured notes</a>
            </div>
            <div className="pipeline-tags" data-reveal data-reveal-d="4">
              <span className="chip"><i style={{ background: 'var(--blue)' }} /> Term sheet</span>
              <span className="sep">→</span>
              <span className="chip"><i style={{ background: 'var(--purple)' }} /> BPMN workflow</span>
              <span className="sep">→</span>
              <span className="chip"><i style={{ background: 'var(--cyan)' }} /> FlowEngine on Arbitrum</span>
              <span className="sep">→</span>
              <span className="chip"><i style={{ background: 'var(--blue)' }} /> Chainlink CRE observes and pays</span>
            </div>
          </div>
        </section>

        <section id="why-notes">
          <div className="wrap">
            <div className="section-head" data-reveal>
              <span className="eyebrow">Why structured notes</span>
              <h2>A market view, turned into <span className="grad-text">an outcome agreed upfront.</span></h2>
              <p>Banks sell structured notes to wealth and institutional clients; each one needs a calculation agent, a paying agent and weeks of structuring. DeFi's yield products are mostly vaults with rolling strategies, and few have a fixed term sheet, a schedule and an independent calculation agent. StratosNotes puts the term sheet, the schedule and the payouts on-chain.</p>
            </div>
            <div className="features">
              {USES.map((u, i) => (
                <div key={u.k} className="feature" data-reveal data-reveal-d={String(i % 3)}>
                  <h3>{u.k}</h3>
                  <p>{u.v}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="how">
          <div className="wrap">
            <div className="section-head" data-reveal>
              <span className="eyebrow">How it works</span>
              <h2>A promise about dates and prices,<br /><span className="grad-text">kept by the contract.</span></h2>
              <p>A structured note says what is paid, to whom, on which dates, depending on a price. Here the workflow is the contract and Chainlink CRE is the calculation and paying agent.</p>
            </div>
            <div className="steps">
              <div className="step" style={{ '--accent': 'var(--blue)' } as React.CSSProperties} data-reveal>
                <div className="num"><b>01</b> · DESIGN</div>
                <div className="ico"><svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /><path d="M10 6.5h4a2 2 0 0 1 2 2V14" /></svg></div>
                <h3>Term sheet, AI or BPMN</h3>
                <p>Pick one of five verified payoffs, describe the note to the AI (it asks for missing terms rather than guessing), or change the workflow itself in the studio. Every change passes the validator and compiler first.</p>
                <div className="tag">// fixed coupon · reverse convertible · phoenix · snowball · protected</div>
              </div>
              <div className="step" style={{ '--accent': 'var(--purple)' } as React.CSSProperties} data-reveal data-reveal-d="1">
                <div className="num"><b>02</b> · ISSUE &amp; SELL</div>
                <div className="ico"><svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8"><path d="M7 7h11l-3-3M17 17H6l3 3" /></svg></div>
                <h3>A book anyone can buy from</h3>
                <p>Size, strike date and observation dates are set per issuance. Investors subscribe until the strike date in one atomic stablecoin-for-note swap, and can transfer units in whole or in part.</p>
                <div className="tag">// per-issuance terms · atomic DvP · transfers</div>
              </div>
              <div className="step" style={{ '--accent': 'var(--cyan)' } as React.CSSProperties} data-reveal data-reveal-d="2">
                <div className="num"><b>03</b> · OBSERVE &amp; PAY</div>
                <div className="ico"><svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8"><circle cx="12" cy="12" r="3" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l2.5 2.5M16.5 16.5 19 19M19 5l-2.5 2.5M7.5 16.5 5 19" /></svg></div>
                <h3>Chainlink CRE keeps every date</h3>
                <p>On each date CRE reads the Chainlink feeds and writes a signed report through the KeystoneForwarder. The engine accepts it only from there, checks every price against its bounds, and pays in the same transaction.</p>
                <div className="tag">// one CRE workflow for every note, on every chain</div>
              </div>
            </div>
          </div>
        </section>

        <section id="lifecycle">
          <div className="wrap">
            <div className="section-head" data-reveal>
              <span className="eyebrow">The lifecycle</span>
              <h2>Every step, <span className="grad-text">on-chain.</span></h2>
              <p>A worst-of phoenix on ETH and BTC, step by step. Pick a step to see what it is: a call to FlowEngine, or the Chainlink CRE workflow that drives it.</p>
            </div>
            <div className="demo-shell" data-reveal>
              <div className="demo-topbar">
                <span className="dots"><i /><i /><i /></span>
                <span className="title">12M Worst-of Phoenix (memory) on ETH, BTC</span>
                <span className="hint">Pick a step <kbd>↳</kbd></span>
              </div>
              <div className="canvas-pane">
                <div className="grid-bg" />
                <div className="bpmn">
                  <svg className="edges" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                    {EDGES.map(([a, b], i) => {
                      const p1 = pos(a), p2 = pos(b);
                      const mx = (p1.x + p2.x) / 2;
                      const d = `M ${p1.x} ${p1.y} C ${mx} ${p1.y}, ${mx} ${p2.y}, ${p2.x} ${p2.y}`;
                      const lit = a === active || b === active;
                      return (
                        <g key={a + b}>
                          <path d={d} className={lit ? 'lit' : ''} vectorEffect="non-scaling-stroke" />
                          <circle r="0.9" className="flow-dot"><animateMotion dur="2.6s" repeatCount="indefinite" path={d} begin={`${i * 0.5}s`} /></circle>
                        </g>
                      );
                    })}
                  </svg>
                  {STEPS.map(s => (
                    <button key={s.id} type="button" className={`node${s.id === active ? ' active' : ''}`} style={{ left: `${s.x}%`, top: `${s.y}%`, background: 'none', border: 0, color: 'inherit', font: 'inherit' }} onClick={() => setActive(s.id)} aria-pressed={s.id === active} aria-label={s.label}>
                      {s.type === 'box' && <div className="node-box">{s.label}</div>}
                      {s.type === 'event' && <div className="node-event"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" strokeWidth="2" /></svg></div>}
                      {s.type === 'end' && <div className="node-event end"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" strokeWidth="2.6" /></svg></div>}
                      {s.type === 'gateway' && <div className="node-gateway"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" strokeWidth="2.2" /></svg></div>}
                      {s.type !== 'box' && <span className="label">{s.label}</span>}
                    </button>
                  ))}
                </div>
              </div>
              <div className="code-pane">
                <div className="code-head">
                  <div className="step-tag">{step.tag}</div>
                  <h4>{step.title}</h4>
                  <p>{step.desc}</p>
                </div>
                <div className="code-meta">Triggered by <b>{step.actor}</b> · FlowEngine on Arbitrum Sepolia and Robinhood Chain testnet</div>
                <div className="code-body">
                  <pre className="daml" dangerouslySetInnerHTML={{ __html: step.code[CHAIN] }} />
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="arbitrum">
          <div className="wrap">
            <div className="section-head" data-reveal>
              <span className="eyebrow">Why Arbitrum</span>
              <h2>A note on a stock needs the stock <span className="grad-text">and its price.</span></h2>
              <p>Robinhood Chain, built on Arbitrum, is made for tokenized stocks, and Chainlink publishes equity prices on Arbitrum One. So a note on Tesla, or a worst-of on NVIDIA and Apple, can be issued, observed and paid where those assets live.</p>
            </div>
            <div className="chain-cards">
              <div className="chain-card" data-reveal>
                <div className="logo">Robinhood Chain</div>
                <span className="status-pill"><i />Testnet 46630</span>
                <p>Robinhood's chain on the Arbitrum stack, built for tokenized stocks. CRE writes to its testnet; its mainnet carries Chainlink equity feeds, and a fallback keeper covers it until CRE does.</p>
                <ul><li>Stock tokens on testnet and mainnet</li><li>CRE on testnet today</li><li>The same engine as Arbitrum Sepolia</li></ul>
              </div>
              <div className="chain-card" data-reveal data-reveal-d="1">
                <div className="logo">Arbitrum Sepolia</div>
                <span className="status-pill"><i />Testnet 421614</span>
                <p>The crypto notes, and a path to Arbitrum One: the engine is plain EVM, so the contracts tested here are the ones that would run there.</p>
                <ul><li>CRE reads and writes Arbitrum</li><li>Equity prices from Arbitrum One feeds</li><li>Test tokens from an on-chain faucet</li></ul>
              </div>
              <div className="chain-card" data-reveal data-reveal-d="2">
                <div className="logo"><img src="/logos/chainlink.svg" alt="" /> Chainlink prices</div>
                <span className="status-pill"><i />Read by CRE</span>
                <p>Crypto from Chainlink's Ethereum feeds; TSLA, NVDA, AAPL and SPY from its Arbitrum One feeds, which follow NYSE hours. Every price is read at a finalized block and checked for staleness.</p>
                <ul><li>ETH · BTC · SOL</li><li>TSLA · NVDA · AAPL · SPY</li><li>Bounds-checked on-chain</li></ul>
              </div>
            </div>
          </div>
        </section>

        <section id="proof">
          <div className="wrap">
            <div className="section-head" data-reveal>
              <span className="eyebrow">Proof</span>
              <h2>Tested end to end, <span className="grad-text">then deployed.</span></h2>
              <p>Every product pays exactly the reference payoff in Foundry, and whole notes have run on local forks of both testnets, driven by Chainlink's CRE simulator. The contracts below are the live testnet deployment.</p>
            </div>
            <div className="proof" data-reveal>
              {LOCAL.map(x => <div key={x.k} className="cell"><div className="v">{x.v}</div><div className="k">{x.k}</div></div>)}
            </div>
            <div className="ledger" data-reveal>
              <table>
                <thead><tr><th>Network</th><th>FlowEngine</th><th>Faucet</th><th>CRE forwarder</th></tr></thead>
                <tbody>
                  {proof.deployments.map(d => (
                    <tr key={d.key}>
                      <td>{d.name}</td>
                      {d.deployed ? (
                        <>
                          <td><a href={`${d.explorer}/address/${d.engine}`} target="_blank" rel="noopener" style={{ color: 'var(--purple)', fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{short(d.engine)}</a></td>
                          <td>{d.faucet ? <a href={`${d.explorer}/address/${d.faucet}`} target="_blank" rel="noopener" style={{ color: 'var(--purple)', fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{short(d.faucet)}</a> : '—'}</td>
                          <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{short(d.forwarder)}</td>
                        </>
                      ) : <td colSpan={3} style={{ color: 'var(--muted)' }}>Deployment pending</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {proof.runs.map(r => (
              <div key={r.note} className="ledger" data-reveal>
                <table>
                  <thead><tr><th colSpan={3}>{r.title} · {r.reporter === 'cre' ? 'reported by Chainlink CRE' : 'reported by the fallback keeper'}</th></tr><tr><th>Event</th><th>Result</th><th>Transaction</th></tr></thead>
                  <tbody>
                    {r.events.map(e => {
                      const ex = proof.deployments.find(d => d.key === r.chain)?.explorer;
                      return <tr key={e.tx}><td>{e.what}</td><td>{e.detail}</td><td>{ex ? <a href={`${ex}/tx/${e.tx}`} target="_blank" rel="noopener" style={{ color: 'var(--purple)', fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{e.tx.slice(0, 10)}…</a> : e.tx.slice(0, 10)}</td></tr>;
                    })}
                  </tbody>
                </table>
              </div>
            ))}
            {live.length === 0 && <p style={{ color: 'var(--muted)', fontSize: 13 }}>The testnet contracts are listed here as soon as they are deployed.</p>}
          </div>
        </section>

        <section id="story">
          <div className="wrap">
            <div className="section-head" data-reveal>
              <span className="eyebrow">Where it comes from</span>
              <h2>From a workflow tool on Canton <span className="grad-text">to one product.</span></h2>
            </div>
            <div className="chain-cards">
              <div className="chain-card" data-reveal>
                <div className="logo">StratosFlow</div>
                <span className="status-pill"><i />Before · Canton</span>
                <p>A visual BPMN workflow builder that compiles any business process to Daml on the Canton Network, built through a Canton accelerator.</p>
                <span className="foot-note"><a href={FLOW_URL} target="_blank" rel="noopener">stratoslab.app</a></span>
              </div>
              <div className="chain-card" data-reveal data-reveal-d="1">
                <div className="logo">TOKEN2049</div>
                <span className="status-pill verified"><i />Chainlink CRE track</span>
                <p>A structured note is a workflow of dates and prices. We rebuilt the compiler around notes on Solana, with Chainlink CRE as calculation agent, and won Chainlink's CRE track.</p>
                <span className="foot-note"><a href={SOLANA_BUILD} target="_blank" rel="noopener">sp.stratoslab.app</a></span>
              </div>
              <div className="chain-card" data-reveal data-reveal-d="2">
                <div className="logo">StratosNotes on Arbitrum</div>
                <span className="status-pill"><i />Now · Arbitrum Hackerhouse</span>
                <p>The same compiler and payoffs on a Solidity engine, for Arbitrum Sepolia and Robinhood Chain, with an indexer, an API and the app on top.</p>
                <span className="foot-note">notes.stratoslab.app</span>
              </div>
            </div>
            <p style={{ marginTop: 16, color: 'var(--muted)', fontSize: 11.5, fontFamily: 'var(--font-mono)' }}>Chain and partner names are trademarks of their respective owners. No endorsement implied.</p>
          </div>
        </section>

        <section id="cta">
          <div className="wrap">
            <div className="cta-final" data-reveal>
              <span className="eyebrow" style={{ justifyContent: 'center' }}>Try it</span>
              <h2 style={{ marginTop: 18 }}>Your next note<br />doesn't need a structuring desk.</h2>
              <p>Claim test tokens, issue a phoenix with observations minutes apart, and watch Chainlink CRE run its whole life on Arbitrum Sepolia or Robinhood Chain testnet.</p>
              <div className="hero-cta">
                <a href={APP_URL} className="btn btn-primary">Open the app <span className="arrow">→</span></a>
                <a href={REPO_URL} target="_blank" rel="noopener" className="btn btn-ghost">Read the code</a>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="foot">
        <div className="wrap foot-inner">
          <a className="brand" href="#top"><img className="mark" src="/logos/stratos-mark.png" alt="" width={28} height={28} /><span>StratosNotes</span></a>
          <div className="foot-links">
            <a href="#why-notes">Why notes</a>
            <a href="#lifecycle">Lifecycle</a>
            <a href="#arbitrum">Why Arbitrum</a>
            <a href="#proof">Proof</a>
            <a href={FLOW_URL} target="_blank" rel="noopener">StratosFlow</a>
            <a href={REPO_URL} target="_blank" rel="noopener">GitHub</a>
          </div>
          <small>© {new Date().getFullYear()} StratosNotes · by Stratos Lab · Arbitrum · Robinhood Chain · Chainlink CRE</small>
        </div>
      </footer>
    </div>
  );
}
