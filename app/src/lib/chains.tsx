/**
 * Chains and wallets. The API's /api/config says which chains this deployment serves (RPC, engine, lens,
 * stablecoin); this builds the wagmi + RainbowKit setup for them (injected wallets, discovered with EIP-6963)
 * and one SDK adapter per chain. Writes go through `useActions`, which puts the wallet on the note's chain
 * first.
 */
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { connectorsForWallets, darkTheme, RainbowKitProvider } from '@rainbow-me/rainbowkit';
import { injectedWallet } from '@rainbow-me/rainbowkit/wallets';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createPublicClient, defineChain, http, type Chain, type PublicClient, type WalletClient } from 'viem';
import { createConfig, WagmiProvider, useAccount } from 'wagmi';
import { getAccount, getWalletClient, switchChain } from 'wagmi/actions';
import { EvmAdapter } from '@sn/sdk';
import { EXTERNAL_TOKENS } from '@sn/core';
import type { AppConfig, ChainConfig } from './api';
import '@rainbow-me/rainbowkit/styles.css';

/**
 * The network the app leads with: Arbitrum (Sepolia), where a note's lifecycle runs. Robinhood Chain is the asset
 * chain, where the stock tokens live (STOCK_CHAIN); its notes stay selectable until the cross-chain vaults exist.
 */
export const PREFERRED_CHAIN = 'arbitrum-sepolia';
export const STOCK_CHAIN = 'robinhood-testnet';

/**
 * The deployment's config as the app uses it: Arbitrum first (so it is the default everywhere a network is picked),
 * and each chain's own tokens (Robinhood Chain's TSLA, AMZN, NFLX) added to the ones the deployment records.
 */
export function prepareConfig(config: AppConfig): AppConfig {
  const rank = (k: string) => (k === PREFERRED_CHAIN ? 0 : 1);
  const chains = [...config.chains]
    .sort((a, b) => rank(a.key) - rank(b.key))
    .map(c => ({ ...c, tokens: { ...(EXTERNAL_TOKENS[c.key] ?? {}), ...c.tokens } }));
  return { ...config, chains };
}

/** Native gas tokens that are not ETH (every chain here pays gas in ETH today). */
const NATIVE: Record<string, { name: string; symbol: string }> = {};

function toChain(c: ChainConfig): Chain {
  return defineChain({
    id: c.chainId!, name: c.name, testnet: c.testnet,
    nativeCurrency: { ...(NATIVE[c.key] ?? { name: 'Ether', symbol: 'ETH' }), decimals: 18 },
    rpcUrls: { default: { http: [c.rpc] } },
    ...(c.explorer ? { blockExplorers: { default: { name: 'Explorer', url: c.explorer } } } : {}),
  });
}

interface Chains {
  config: AppConfig;
  byKey: Record<string, { cfg: ChainConfig; chain: Chain; adapter: EvmAdapter; client: PublicClient }>;
  wagmi: ReturnType<typeof createConfig>;
}

const Ctx = createContext<Chains | null>(null);

export function ChainsProvider({ config, children }: { config: AppConfig; children: ReactNode }) {
  const value = useMemo<Chains>(() => {
    const evm = config.chains.filter(c => c.family === 'evm' && c.chainId);
    const byKey: Chains['byKey'] = {};
    for (const cfg of evm) {
      const chain = toChain(cfg);
      const client = createPublicClient({ chain, transport: http(cfg.rpc) }) as PublicClient;
      byKey[cfg.key] = { cfg, chain, client, adapter: new EvmAdapter(cfg, client, { engine: cfg.engine, lens: cfg.lens, fromBlock: BigInt(cfg.fromBlock) }) };
    }
    const chains = Object.values(byKey).map(x => x.chain);
    // Injected wallets only (MetaMask, Rabby, Coinbase Wallet extension…, each discovered via EIP-6963).
    // WalletConnect needs a project id; add it with VITE_WC_PROJECT_ID when mobile wallets are wanted.
    const connectors = connectorsForWallets([{ groupName: 'Browser wallets', wallets: [injectedWallet] }], {
      appName: 'notes.markets', projectId: import.meta.env.VITE_WC_PROJECT_ID ?? 'injected-only',
    });
    const wagmi = createConfig({
      chains: chains as [Chain, ...Chain[]],
      connectors,
      transports: Object.fromEntries(Object.values(byKey).map(x => [x.chain.id, http(x.cfg.rpc)])),
      multiInjectedProviderDiscovery: true,
      ssr: false,
    });
    return { config, byKey, wagmi };
  }, [config]);
  const queryClient = useMemo(() => new QueryClient(), []);
  return (
    <Ctx.Provider value={value}>
      <WagmiProvider config={value.wagmi}>
        <QueryClientProvider client={queryClient}>
          <RainbowKitProvider theme={darkTheme({ accentColor: '#4C8DFF', accentColorForeground: '#0A1628', borderRadius: 'medium', fontStack: 'system' })} modalSize="compact">
            {children}
          </RainbowKitProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </Ctx.Provider>
  );
}

export function useChains() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useChains outside ChainsProvider');
  return c;
}

/** The connected wallet's address (lower-case), or null. */
export function useAddress(): string | null {
  const { address } = useAccount();
  return address ? address.toLowerCase() : null;
}

/** A WalletClient on `chainKey`, switching the wallet's network first when needed. */
export function useSigner() {
  const { wagmi, byKey } = useChains();
  return useCallback(async (chainKey: string): Promise<WalletClient> => {
    const target = byKey[chainKey];
    if (!target) throw new Error(`This app is not configured for ${chainKey}.`);
    const acct = getAccount(wagmi);
    if (!acct.address) throw new Error('Connect a wallet first.');
    if (acct.chainId !== target.chain.id) await switchChain(wagmi, { chainId: target.chain.id });
    return (await getWalletClient(wagmi, { chainId: target.chain.id })) as WalletClient;
  }, [wagmi, byKey]);
}
