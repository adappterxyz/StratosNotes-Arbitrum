import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import './notes.css';
import Explorer from './explorer/Explorer';
import './explorer/explorer.css';
import proofJson from './proof.json';

const APP_URL = '/app/';
const FLOW_URL = 'https://stratoslab.app';
const SOLANA_BUILD = 'https://sp.stratoslab.app';
const STRATOS_URL = 'https://stratoslab.xyz';

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

export default function Landing() {
  const rootRef = useRef<HTMLDivElement>(null);
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
            <a href="#explore">Explore notes</a>
            <a href="#how">How a note works</a>
            <a href="#arbitrum">Why Arbitrum</a>
            <a href="#story">Story</a>
            <a href="#proof">Proof</a>
          </nav>
          <div className="nav-cta">
            <a href="#explore" className="btn btn-primary">Explore notes <span className="arrow">→</span></a>
          </div>
        </div>
      </header>

      <main id="top">
        <section className="hero">
          <div className="wrap hero-inner">
            <div className="badge" data-reveal>
              <span className="dot" />
              <span><b>Launching on Arbitrum Sepolia · Robinhood Chain testnet</b> · priced and enforced by Chainlink CRE</span>
            </div>
            <h1 data-reveal data-reveal-d="1">
              One note, two sides:<br /><span className="grad-text">yield for investors, funding for issuers.</span>
            </h1>
            <p className="sub" data-reveal data-reveal-d="2">
              A structured note turns a view on stocks or crypto into an outcome agreed upfront. Investors pick it for
              yield, protection, exposure or a hedge. Issuers use it to raise stablecoins against collateral they pledge
              and cannot withdraw. Chainlink observes every date and checks that collateral; the issuer funds each
              payment when it falls due, or the collateral goes to the holders.
            </p>
            <div className="hero-cta" data-reveal data-reveal-d="3">
              <a href="#explore" className="btn btn-primary">Find the note for you <span className="arrow">→</span></a>
              <a href="#how" className="btn btn-ghost">How a note works</a>
            </div>
          </div>
        </section>

        <section id="explore">
          <div className="wrap">
            <div className="section-head" data-reveal>
              <span className="eyebrow">Note explorer</span>
              <h2>Choose a side, a goal and a market. <span className="grad-text">See what the note does.</span></h2>
              <p>Every number below is computed by the same reference payoff the on-chain engine is tested against. Drag the price path to try your own market.</p>
            </div>
            <Explorer />
          </div>
        </section>

        <section id="how">
          <div className="wrap">
            <div className="section-head" data-reveal>
              <span className="eyebrow">How a note works</span>
              <h2>Secured funding, <span className="grad-text">enforced on-chain.</span></h2>
              <p>The note is a BPMN workflow run by one contract. Each step is either a party signing, or Chainlink CRE writing a signed report the contract accepts only from Chainlink's forwarder.</p>
            </div>
            <ol className="rail" data-reveal>
              <li><span className="who">Issuer</span><h3>Issue &amp; pledge</h3><p>Sets size, dates, settlement lag and a 0–7 day grace period. Pledges collateral at a ratio they choose; it is locked in the note.</p></li>
              <li><span className="who">Investors</span><h3>Subscribe</h3><p>Stablecoins for note units in one swap, until the strike date. The proceeds go to the issuer as funding.</p></li>
              <li className="cl"><span className="who">Chainlink CRE</span><h3>Fix the strike</h3><p>Reads the Chainlink feeds at a finalized block and writes the strike for every underlying.</p></li>
              <li className="cl"><span className="who">Chainlink CRE</span><h3>Observe &amp; check</h3><p>Each date fixes what the issuer owes and values the collateral after haircuts. Short of the ratio: a margin call.</p></li>
              <li><span className="who">Issuer</span><h3>Fund each payment</h3><p>Deposits the coupon or redemption before the payment date plus grace. Funded: every holder is paid.</p></li>
              <li className="risk"><span className="who">Contract</span><h3>Release or default</h3><p>After the last payment the collateral goes back to the issuer. A missed payment: it goes to holders pro rata.</p></li>
            </ol>
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
                <p>Robinhood's chain on the Arbitrum stack, built for tokenized stocks. Chainlink CRE writes to its testnet; until CRE reaches its mainnet, a fallback keeper covers it.</p>
                <ul><li>Tokenized stocks</li><li>CRE on testnet today</li><li>The same engine as Arbitrum Sepolia</li></ul>
              </div>
              <div className="chain-card" data-reveal data-reveal-d="1">
                <div className="logo">Arbitrum Sepolia</div>
                <span className="status-pill"><i />Testnet 421614</span>
                <p>The crypto notes, and a path to Arbitrum One: the engine is plain EVM, so the contracts tested here are the ones that would run there.</p>
                <ul><li>CRE reads and writes Arbitrum</li><li>Test tokens from an on-chain faucet</li><li>Collateral in stablecoin or tokens</li></ul>
              </div>
              <div className="chain-card" data-reveal data-reveal-d="2">
                <div className="logo"><img src="/logos/chainlink.svg" alt="" /> Chainlink prices</div>
                <span className="status-pill"><i />Read by CRE</span>
                <p>Crypto from Chainlink's Ethereum feeds; TSLA, NVDA, AAPL and SPY from its Arbitrum One feeds, which follow NYSE hours. Every price is read at a finalized block and checked for staleness and bounds.</p>
                <ul><li>ETH · BTC · SOL</li><li>TSLA · NVDA · AAPL · SPY</li><li>Underlyings and collateral</li></ul>
              </div>
            </div>
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
                <span className="status-pill"><i />Now · Arbitrum</span>
                <p>The same compiler and payoffs on a Solidity engine for Arbitrum Sepolia and Robinhood Chain, rebuilt around collateral and per-period funding.</p>
                <span className="foot-note">notes.markets</span>
              </div>
            </div>
          </div>
        </section>

        <section id="proof">
          <div className="wrap">
            <div className="section-head" data-reveal>
              <span className="eyebrow">Proof</span>
              <h2>On testnet, <span className="grad-text">in the open.</span></h2>
              <p>The contracts and the first notes run by Chainlink CRE are listed here as they go live, each linked to its explorer.</p>
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
            {live.length === 0 && <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 12 }}>Nothing is deployed yet: the testnet contracts appear here as soon as they are.</p>}
          </div>
        </section>

        <section id="cta">
          <div className="wrap">
            <div className="cta-final" data-reveal>
              <span className="eyebrow" style={{ justifyContent: 'center' }}>The app</span>
              <h2 style={{ marginTop: 18 }}>Issue, subscribe and fund,<br />on testnet soon.</h2>
              <p>Claim test tokens, pledge collateral, issue a note with observations minutes apart, and watch Chainlink CRE run it on Arbitrum Sepolia or Robinhood Chain testnet.</p>
              <div className="hero-cta">
                <a href={APP_URL} className="btn btn-primary">App launching soon <span className="arrow">→</span></a>
                <a href="#explore" className="btn btn-ghost">Back to the explorer</a>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="foot">
        <div className="wrap foot-inner">
          <a className="brand" href="#top"><img className="mark" src="/logos/stratos-mark.png" alt="" width={28} height={28} /><span>StratosNotes</span></a>
          <div className="foot-links">
            <a href={STRATOS_URL} target="_blank" rel="noopener">stratoslab.xyz</a>
            <a href={FLOW_URL} target="_blank" rel="noopener">stratoslab.app</a>
            <a href={SOLANA_BUILD} target="_blank" rel="noopener">sp.stratoslab.app</a>
            <span style={{ color: 'var(--muted)', fontSize: 14 }}>Code: coming soon</span>
          </div>
          <small>© {new Date().getFullYear()} StratosNotes · by Stratos Lab · Chain and partner names are trademarks of their owners; no endorsement implied.</small>
        </div>
      </footer>
    </div>
  );
}
