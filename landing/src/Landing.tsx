import { useCallback, useEffect, useRef, useState } from 'react';
import './notes.css';
import Carousel from './Carousel';
import ExplorerPanel from './ExplorerPanel';
import { DEFAULT_START, type ExplorerStart } from './explorer/start';
import proofJson from './proof.json';

const APP_URL = '/app/';
const FLOW_URL = 'https://stratoslab.app';
const SOLANA_BUILD = 'https://sp.stratoslab.app';
const STRATOS_URL = 'https://stratoslab.xyz';
const REPO_URL = 'https://github.com/adappterxyz/StratosNotes-Arbitrum';

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

/** The wordmark: lowercase, with the dot as the one blue mark. */
export function Wordmark({ size = 'md' }: { size?: 'md' | 'lg' }) {
  return <span className={`wordmark ${size}`} aria-label="notes.markets">notes<i>.</i>markets</span>;
}

export default function Landing() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState(false);
  // The full explorer opens on request only (a card, the "Try a note" buttons, or a #explore link).
  const [explorer, setExplorer] = useState<ExplorerStart | null>(() =>
    typeof window !== 'undefined' && window.location.hash === '#explore' ? DEFAULT_START : null);
  const openExplorer = useCallback((s: ExplorerStart = DEFAULT_START) => { setMenu(false); setExplorer(s); }, []);
  const closeExplorer = useCallback(() => {
    setExplorer(null);
    if (window.location.hash === '#explore') history.replaceState(null, '', window.location.pathname + window.location.search);
  }, []);
  useEffect(() => {
    const onHash = () => { if (window.location.hash === '#explore') setExplorer(e => e ?? DEFAULT_START); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  // Nav state and gentle reveals; the page is complete without them.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const header = root.querySelector('header.nav');
    const onScroll = () => header?.classList.toggle('scrolled', window.scrollY > 20);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    root.classList.add('js');
    const els = [...root.querySelectorAll<HTMLElement>('[data-reveal]')];
    const io = new IntersectionObserver(entries => entries.forEach(en => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } }), { threshold: 0.1 });
    els.forEach(el => io.observe(el));
    const all = window.setTimeout(() => els.forEach(el => el.classList.add('in')), 1800);
    return () => { window.removeEventListener('scroll', onScroll); io.disconnect(); clearTimeout(all); root.classList.remove('js'); };
  }, []);
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);

  const live = proof.deployments.filter((d): d is Extract<Deployment, { deployed: true }> => d.deployed);
  const links = [['#notes', 'What notes do'], ['#how', 'How it works'], ['#arbitrum', 'Why Arbitrum'], ['#proof', 'Proof']];

  return (
    <div className="sn-root" ref={rootRef}>
      <div className="bg-grid" aria-hidden="true" />

      <header className={`nav${menu ? ' open' : ''}`}>
        <div className="nav-inner">
          <a className="brand" href="#top" aria-label="notes.markets home"><Wordmark /></a>
          <nav className="nav-links" aria-label="Sections">
            {links.map(([h, t]) => <a key={h} href={h}>{t}</a>)}
          </nav>
          <div className="nav-cta">
            <button type="button" className="btn btn-ghost hide-sm" onClick={() => openExplorer()}>Try a note</button>
            <a href={APP_URL} className="btn btn-primary">Open the app</a>
            <button type="button" className="nav-menu" aria-label={menu ? 'Close menu' : 'Open menu'} aria-expanded={menu} aria-controls="nav-sheet" onClick={() => setMenu(m => !m)}>
              <span /><span /><span />
            </button>
          </div>
        </div>
        <div id="nav-sheet" className="nav-sheet" hidden={!menu}>
          {links.map(([h, t]) => <a key={h} href={h} onClick={() => setMenu(false)}>{t}</a>)}
          <button type="button" className="btn btn-ghost" onClick={() => openExplorer()}>Try a note</button>
        </div>
      </header>

      <main id="top">
        <section className="hero">
          <div className="wrap hero-inner">
            <span className="badge"><i />Live on Arbitrum Sepolia and Robinhood Chain testnet</span>
            <h1>Structured notes, on-chain.</h1>
            <p className="sub">
              A structured note is an agreement made before you buy: what you are paid, and when, depending on the price of
              a stock or a coin. On notes.markets anyone can issue one, and Chainlink checks the prices and enforces every payment.
            </p>
            <div className="hero-cta">
              <a href={APP_URL} className="btn btn-primary btn-lg">Open the app</a>
              <button type="button" className="btn btn-ghost btn-lg" onClick={() => openExplorer()}>Try a note</button>
            </div>
            <div className="sides">
              <div className="side">
                <span className="side-k">For investors</span>
                <p>A result agreed in advance on stocks or crypto: regular income, your money back with some upside, exposure to a basket, or a hedge.</p>
              </div>
              <div className="side">
                <span className="side-k">For issuers</span>
                <p>Raise stablecoins today against collateral you pledge, and pay each coupon when it falls due.</p>
              </div>
            </div>
            <div className="built-on">
              <span className="built-label">Built on</span>
              <span className="built-mark"><img src="/logos/arbitrum.svg" alt="" height={26} />Arbitrum</span>
              <span className="built-mark"><img src="/logos/robinhood-chain.svg" alt="" height={24} />Robinhood Chain</span>
              <span className="built-mark"><img src="/logos/chainlink.svg" alt="Chainlink" height={20} /></span>
            </div>
          </div>
        </section>

        <section id="notes" className="notes-sec">
          <div className="wrap">
            <div className="section-head">
              <span className="eyebrow">What a note can do</span>
              <h2>Six things a note can do.</h2>
              <p>Four for investors, two for issuers. Each card opens a working example you can change.</p>
            </div>
          </div>
          <Carousel onOpen={openExplorer} />
          <div className="wrap">
            <div className="try-row">
              <button type="button" className="btn btn-ghost" onClick={() => openExplorer()}>Try a note yourself</button>
              <span>Pick a side, shape the market, and see every payment.</span>
            </div>
          </div>
        </section>

        <section id="how">
          <div className="wrap">
            <div className="section-head" data-reveal>
              <span className="eyebrow">How it works</span>
              <h2>Funding for the issuer, protection for the holder.</h2>
              <p>One contract runs each note step by step. People sign their own steps. Chainlink CRE, Chainlink's automation, writes the prices, and the contract accepts them only from Chainlink.</p>
            </div>
            <ol className="steps" data-reveal>
              <li><span className="who">Issuer</span><h3>Set terms, pledge collateral</h3><p>Size, dates, a grace period of 0 to 7 days, and collateral at a ratio the issuer chooses. It stays locked in the note.</p></li>
              <li><span className="who">Investors</span><h3>Buy units</h3><p>Stablecoins in, note units out, in one transaction. The money goes to the issuer.</p></li>
              <li><span className="who cl">Chainlink</span><h3>Fix the strike</h3><p>On the strike date, Chainlink records the starting price of each underlying.</p></li>
              <li><span className="who cl">Chainlink</span><h3>Check each date</h3><p>Works out what is owed and whether the collateral still covers the note. If not, the issuer must top up.</p></li>
              <li><span className="who">Issuer</span><h3>Fund each payment</h3><p>Pays in before the payment date, or within the grace period. Every holder is then paid.</p></li>
              <li><span className="who risk">The contract</span><h3>Release or default</h3><p>Paid in full: the collateral goes back to the issuer. A payment missed: holders take what they are owed from the collateral.</p></li>
            </ol>
          </div>
        </section>

        <section id="arbitrum">
          <div className="wrap">
            <div className="section-head" data-reveal>
              <span className="eyebrow">Why Arbitrum</span>
              <h2>A note on a stock needs the stock and its price.</h2>
              <p>Robinhood Chain, built on Arbitrum, is made for tokenized stocks, and Chainlink publishes stock prices on Arbitrum One. So a note on Tesla, or on NVIDIA and Apple together, can live where those assets do.</p>
            </div>
            <div className="cards3">
              <div className="card" data-reveal>
                <div className="card-logo"><img src="/logos/robinhood-chain.svg" alt="" height={24} />Robinhood Chain</div>
                <span className="tag">Testnet 46630</span>
                <p>Robinhood's chain on the Arbitrum stack, built for tokenized stocks. Our stock notes run here.</p>
              </div>
              <div className="card" data-reveal>
                <div className="card-logo"><img src="/logos/arbitrum.svg" alt="" height={26} />Arbitrum Sepolia</div>
                <span className="tag">Testnet 421614</span>
                <p>Our crypto notes run here. The contracts are plain EVM, so the same code can move to Arbitrum One.</p>
              </div>
              <div className="card" data-reveal>
                <div className="card-logo"><img src="/logos/chainlink.svg" alt="Chainlink" height={20} /></div>
                <span className="tag">Prices and automation</span>
                <p>ETH, BTC and SOL from Chainlink's Ethereum feeds; TSLA, NVDA, AAPL and SPY from its Arbitrum One feeds. Every price is checked for age and range.</p>
              </div>
            </div>
          </div>
        </section>

        <section id="proof">
          <div className="wrap">
            <div className="section-head" data-reveal>
              <span className="eyebrow">Proof</span>
              <h2>Two notes, run start to finish on testnet.</h2>
              <p>Every row links to the transaction. Each report was written by Chainlink CRE and accepted only through Chainlink's forwarder. The table below lists the contracts these two runs used.</p>
            </div>
            <div className="ledger">
              <table>
                <thead><tr><th>Network</th><th>Note engine</th><th>Test-token faucet</th><th>Chainlink forwarder</th></tr></thead>
                <tbody>
                  {proof.deployments.map(d => (
                    <tr key={d.key}>
                      <td>{d.name}</td>
                      {d.deployed ? (
                        <>
                          <td><a className="mono" href={`${d.explorer}/address/${d.engine}`} target="_blank" rel="noopener">{short(d.engine)}</a></td>
                          <td>{d.faucet ? <a className="mono" href={`${d.explorer}/address/${d.faucet}`} target="_blank" rel="noopener">{short(d.faucet)}</a> : '—'}</td>
                          <td><a className="mono" href={`${d.explorer}/address/${d.forwarder}`} target="_blank" rel="noopener">{short(d.forwarder)}</a></td>
                        </>
                      ) : <td colSpan={3} className="muted">Not deployed yet</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {proof.runs.map(r => {
              const ex = proof.deployments.find(d => d.key === r.chain)?.explorer;
              return (
                <div key={r.note} className="run">
                  <h3>{r.title}</h3>
                  <div className="ledger">
                    <table>
                      <thead><tr><th>Step</th><th>What happened</th><th>Transaction</th></tr></thead>
                      <tbody>
                        {r.events.map(e => (
                          <tr key={e.tx + e.what}>
                            <td className={e.what.startsWith('Chainlink') ? 'cl' : undefined}>{e.what}</td>
                            <td>{e.detail}</td>
                            <td>{ex ? <a className="mono" href={`${ex}/tx/${e.tx}`} target="_blank" rel="noopener">{e.tx.slice(0, 10)}…</a> : <span className="mono">{e.tx.slice(0, 10)}…</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {r.paid.length > 0 && (
                    <div className="paid">
                      {r.paid.map(p => <span key={p.holder}><b>{p.holder}</b> held {p.units} units and was paid <b className="up">{p.paid}</b></span>)}
                    </div>
                  )}
                </div>
              );
            })}
            {live.length === 0 && <p className="muted">Nothing is deployed yet.</p>}
          </div>
        </section>

        <section id="story">
          <div className="wrap">
            <div className="section-head" data-reveal>
              <span className="eyebrow">Where it comes from</span>
              <h2>From a workflow builder to one product.</h2>
            </div>
            <div className="cards3">
              <div className="card" data-reveal>
                <span className="tag">Before</span>
                <h3>StratosFlow</h3>
                <p>Our visual workflow builder: draw a business process and it compiles to smart-contract code.</p>
                <a className="card-link" href={FLOW_URL} target="_blank" rel="noopener">stratoslab.app</a>
              </div>
              <div className="card" data-reveal>
                <span className="tag ok">Chainlink CRE track winner</span>
                <h3>TOKEN2049</h3>
                <p>A structured note is a workflow of dates and prices. We rebuilt the compiler around notes on Solana, with Chainlink CRE as the calculation agent.</p>
                <a className="card-link" href={SOLANA_BUILD} target="_blank" rel="noopener">sp.stratoslab.app</a>
              </div>
              <div className="card" data-reveal>
                <span className="tag">Now</span>
                <h3>notes.markets on Arbitrum</h3>
                <p>The same compiler on a Solidity engine for Arbitrum Sepolia and Robinhood Chain, rebuilt around collateral and payments funded period by period.</p>
                <a className="card-link" href={REPO_URL} target="_blank" rel="noopener">Code on GitHub</a>
              </div>
            </div>
          </div>
        </section>

        <section id="cta">
          <div className="wrap">
            <div className="cta-final" data-reveal>
              <h2>Try it on testnet.</h2>
              <p>Claim free test tokens, buy into an open note, or issue your own. Chainlink runs it from there.</p>
              <div className="hero-cta">
                <a href={APP_URL} className="btn btn-primary btn-lg">Open the app</a>
                <button type="button" className="btn btn-ghost btn-lg" onClick={() => openExplorer()}>Try a note</button>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="foot">
        <div className="wrap foot-inner">
          <Wordmark />
          <div className="foot-links">
            <a href={APP_URL}>App</a>
            <a href={REPO_URL} target="_blank" rel="noopener">GitHub</a>
            <a href={STRATOS_URL} target="_blank" rel="noopener">stratoslab.xyz</a>
            <a href={FLOW_URL} target="_blank" rel="noopener">stratoslab.app</a>
            <a href={SOLANA_BUILD} target="_blank" rel="noopener">sp.stratoslab.app</a>
          </div>
          <small className="by"><img src="/logos/stratos-mark.png" alt="" width={16} height={16} />by Stratos Lab · Testnet only. Chain and partner names are trademarks of their owners; no endorsement implied.</small>
        </div>
      </footer>
      {explorer && <ExplorerPanel start={explorer} onClose={closeExplorer} />}
    </div>
  );
}
