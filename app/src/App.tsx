import { useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { Briefcase, LayoutGrid, Mail, Menu, Moon, PenTool, Sun, X } from 'lucide-react';
import Marketplace from './pages/Marketplace';
import OfferingPage from './pages/Offering';
import Portfolio from './pages/Portfolio';
import Workspace from './pages/Workspace';
import AlertsPage, { AlertsConfirm, AlertsUnsubscribe } from './pages/Alerts';
import FaucetButton from './components/FaucetButton';
import RoleSwitch from './components/RoleSwitch';
import { useChains } from './lib/chains';
import { watchTables } from './lib/stackTables';

function ThemeToggle() {
  const [light, setLight] = useState(() => document.documentElement.classList.contains('light'));
  useEffect(() => {
    document.documentElement.classList.toggle('light', light);
    try { localStorage.setItem('sn-theme', light ? 'light' : 'dark'); } catch { /* private mode */ }
  }, [light]);
  return (
    <button className="btn" onClick={() => setLight(l => !l)} aria-label={light ? 'Switch to dark theme' : 'Switch to light theme'} title={light ? 'Dark theme' : 'Light theme'}>
      {light ? <Moon className="i" /> : <Sun className="i" />}
    </button>
  );
}

/** True below the width where the header's extra controls fold into a menu. */
function useNarrow(px = 1000) {
  const q = `(max-width: ${px}px)`;
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [q]);
  return narrow;
}

/** The wordmark: lowercase, the dot in the accent blue. */
function Wordmark() {
  return <span className="wordmark">notes<i>.</i>markets</span>;
}

export default function App() {
  const { pathname } = useLocation();
  const { config } = useChains();
  const narrow = useNarrow();
  const [menu, setMenu] = useState(false);
  useEffect(() => { setMenu(false); }, [pathname, narrow]);
  useEffect(() => watchTables(), []);
  const networks = config.chains.map(c => c.name).join(' · ');
  const workspace = pathname.startsWith('/issue');
  const extras = (
    <>
      <span className="pill plain" title="Networks this deployment serves"><span className="dot" style={{ color: 'hsl(var(--success))' }} />{networks}</span>
      <FaucetButton />
      <RoleSwitch />
      <ThemeToggle />
    </>
  );
  return (
    <>
      <header className={`appbar${menu ? ' open' : ''}`}>
        <div className="appbar-row">
          <Link to="/" className="brand" aria-label="notes.markets marketplace"><Wordmark /></Link>
          <nav className="seg main-nav" aria-label="Sections">
            <NavLink to="/" end><LayoutGrid className="i" />Marketplace</NavLink>
            <NavLink to="/issue"><PenTool className="i" />Issue</NavLink>
            <NavLink to="/portfolio"><Briefcase className="i" />Portfolio</NavLink>
            <NavLink to="/alerts"><Mail className="i" />Alerts</NavLink>
          </nav>
          <div className="right">
            {!narrow && extras}
            <ConnectButton chainStatus="icon" accountStatus={narrow ? 'avatar' : 'address'} showBalance={false} />
            {narrow && (
              <button className="btn menu-btn" aria-label={menu ? 'Close menu' : 'Open menu'} aria-expanded={menu} aria-controls="appbar-sheet" onClick={() => setMenu(m => !m)}>
                {menu ? <X className="i" /> : <Menu className="i" />}
              </button>
            )}
          </div>
        </div>
        {narrow && menu && <div id="appbar-sheet" className="appbar-sheet">{extras}</div>}
      </header>
      <Routes>
        <Route path="/" element={<Marketplace />} />
        <Route path="/note/:id" element={<OfferingPage />} />
        <Route path="/issue" element={<Workspace />} />
        <Route path="/studio" element={<Navigate to="/issue" replace />} />
        <Route path="/portfolio" element={<Portfolio />} />
        <Route path="/alerts" element={<AlertsPage />} />
        <Route path="/alerts/confirm" element={<AlertsConfirm />} />
        <Route path="/alerts/unsubscribe" element={<AlertsUnsubscribe />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {!workspace && (
        <footer className="foot">
          <span>notes.markets · testnet. Each note is a workflow run by one contract; Chainlink CRE writes the strikes and observations.</span>
          {config.chains.filter(c => c.explorer).map(c => <a key={c.key} href={`${c.explorer}/address/${c.engine}`} target="_blank" rel="noreferrer">Engine on {c.name}</a>)}
        </footer>
      )}
    </>
  );
}
