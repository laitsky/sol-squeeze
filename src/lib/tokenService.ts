interface TokenMetadata {
  name: string;
  symbol: string;
  decimals: number;
  logoURI?: string;
  address: string;
  price?: number;
  tags?: string[];
}

interface LocalTokenInfo {
  name: string;
  symbol: string;
  decimals: number;
  tags: Array<'strict' | 'verified' | 'community'>;
}

interface HeliusWalletBalance {
  mint?: string;
  balance?: number;
  decimals?: number;
  symbol?: string;
  name?: string;
  logoUri?: string;
  pricePerToken?: number;
}

interface HeliusWalletBalancesResponse {
  balances?: HeliusWalletBalance[];
  pagination?: {
    page?: number;
    limit?: number;
    hasMore?: boolean;
  };
}

export interface WalletTokenBalance {
  mint: string;
  amount: number;
  metadata: TokenMetadata | null;
  price: number | null;
  priceFetched: boolean;
}

const LOCAL_TOKEN_REGISTRY: Record<string, LocalTokenInfo> = {
  So11111111111111111111111111111111111111112: {
    name: 'Wrapped SOL',
    symbol: 'SOL',
    decimals: 9,
    tags: ['strict'],
  },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: {
    name: 'USD Coin',
    symbol: 'USDC',
    decimals: 6,
    tags: ['strict'],
  },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: {
    name: 'Tether USD',
    symbol: 'USDT',
    decimals: 6,
    tags: ['strict'],
  },
};

function resolveImageUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;

  if (url.startsWith('ipfs://')) {
    const cid = url.replace('ipfs://', '');
    return `https://ipfs.io/ipfs/${cid}`;
  }

  return url;
}

function getFallbackTokenName(mint: string): string {
  return `Token ${mint.slice(0, 4)}...${mint.slice(-4)}`;
}

function getHeliusApiKey(): string | null {
  const explicitKey = process.env.NEXT_PUBLIC_HELIUS_API_KEY;
  if (explicitKey) {
    return explicitKey;
  }

  const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
  if (!rpcUrl) {
    return null;
  }

  try {
    const parsedUrl = new URL(rpcUrl);
    return parsedUrl.searchParams.get('api-key');
  } catch (error) {
    console.warn('Failed to parse NEXT_PUBLIC_SOLANA_RPC_URL for api-key:', error);
    return null;
  }
}

function getHeliusWalletApiBaseUrl(): string {
  const baseUrl = process.env.NEXT_PUBLIC_HELIUS_WALLET_API_URL || 'https://api.helius.xyz';
  return baseUrl.replace(/\/+$/, '');
}

export async function fetchWalletTokenBalances(walletAddress: string): Promise<WalletTokenBalance[]> {
  if (!walletAddress) {
    return [];
  }

  const apiKey = getHeliusApiKey();
  if (!apiKey) {
    console.error('Helius API key missing. Set NEXT_PUBLIC_HELIUS_API_KEY or include api-key in NEXT_PUBLIC_SOLANA_RPC_URL.');
    return [];
  }

  const baseUrl = getHeliusWalletApiBaseUrl();
  const tokenMap = new Map<string, WalletTokenBalance>();
  let page = 1;
  let hasMore = true;
  let pagesFetched = 0;
  const maxPages = 50;
  const pageSize = 100;

  try {
    while (hasMore && pagesFetched < maxPages) {
      const params = new URLSearchParams({
        'api-key': apiKey,
        page: page.toString(),
        limit: pageSize.toString(),
        showNative: 'false',
        showNfts: 'false',
        showZeroBalance: 'false',
      });

      const response = await fetch(
        `${baseUrl}/v1/wallet/${encodeURIComponent(walletAddress)}/balances?${params.toString()}`,
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'x-api-key': apiKey,
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Helius Wallet API returned ${response.status}`);
      }

      const data: HeliusWalletBalancesResponse = await response.json();
      const balances = data.balances || [];

      for (const balance of balances) {
        const mint = balance.mint?.trim();
        if (!mint || typeof balance.balance !== 'number' || balance.balance <= 0) {
          continue;
        }

        const existing = tokenMap.get(mint);
        const localToken = LOCAL_TOKEN_REGISTRY[mint];

        const metadata: TokenMetadata = {
          name: balance.name || localToken?.name || existing?.metadata?.name || getFallbackTokenName(mint),
          symbol: balance.symbol || localToken?.symbol || existing?.metadata?.symbol || 'UNKNOWN',
          decimals: typeof balance.decimals === 'number'
            ? balance.decimals
            : (localToken?.decimals ?? existing?.metadata?.decimals ?? 0),
          logoURI: resolveImageUrl(balance.logoUri || existing?.metadata?.logoURI),
          address: mint,
          tags: localToken?.tags || existing?.metadata?.tags || [],
        };

        const tokenPrice =
          typeof balance.pricePerToken === 'number' && balance.pricePerToken > 0
            ? balance.pricePerToken
            : existing?.price ?? null;

        if (existing) {
          existing.amount += balance.balance;
          existing.metadata = metadata;
          existing.price = tokenPrice;
          existing.priceFetched = true;
        } else {
          tokenMap.set(mint, {
            mint,
            amount: balance.balance,
            metadata,
            price: tokenPrice,
            priceFetched: true,
          });
        }
      }

      hasMore = Boolean(data.pagination?.hasMore);
      page += 1;
      pagesFetched += 1;
    }

    if (hasMore && pagesFetched >= maxPages) {
      console.warn(`Stopped wallet pagination at ${maxPages} pages for wallet ${walletAddress}`);
    }

    return Array.from(tokenMap.values());
  } catch (error) {
    console.error('Error fetching wallet token balances from Helius Wallet API:', error);
    return [];
  }
}

export function getTokenDisplayName(mintAddress: string, metadata: TokenMetadata | null): string {
  if (metadata) {
    return `${metadata.name} (${metadata.symbol})`;
  }

  return `${mintAddress.slice(0, 8)}...${mintAddress.slice(-8)}`;
}

export function formatPrice(price: number | null | undefined): string {
  if (!price || price === 0) return 'N/A';

  if (price < 0.01) {
    return '<$0.01';
  }
  if (price < 1) {
    return `$${price.toFixed(4)}`;
  }
  if (price < 1000) {
    return `$${price.toFixed(2)}`;
  }
  return `$${price.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export function isTokenVerified(metadata: TokenMetadata | null): boolean {
  if (!metadata || !metadata.tags) return false;
  return metadata.tags.includes('verified') || metadata.tags.includes('strict');
}

export function getVerificationLevel(metadata: TokenMetadata | null): 'verified' | 'strict' | 'community' | 'unverified' {
  if (!metadata || !metadata.tags) return 'unverified';

  if (metadata.tags.includes('strict')) return 'strict';
  if (metadata.tags.includes('verified')) return 'verified';
  if (metadata.tags.includes('community')) return 'community';
  return 'unverified';
}
