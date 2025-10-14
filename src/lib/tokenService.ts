interface TokenMetadata {
  name: string;
  symbol: string;
  decimals: number;
  logoURI?: string;
  address: string;
  price?: number; // USDC price
  tags?: string[]; // Jupiter tags including verification status
}

// Helius DAS API response types
interface HeliusAsset {
  id: string;
  content?: {
    metadata?: {
      name?: string;
      symbol?: string;
    };
    links?: {
      image?: string;
    };
  };
  token_info?: {
    decimals?: number;
    symbol?: string;
  };
}

// Jupiter Price API v3 response format
// The API returns prices with mint addresses as keys
interface TokenPriceV3 {
  [mintAddress: string]: {
    usdPrice: number;           // Price in USD
    decimals?: number;          // Token decimals for display
    blockId?: number;           // Block ID for recency verification
    priceChange24h?: number;    // 24h price change percentage
  };
}

// Simple cache to avoid hitting API limits
const metadataCache = new Map<string, TokenMetadata | null>();
const priceCache = new Map<string, { price: number; timestamp: number }>();

// Jupiter token list cache - stores entire token list in memory
let tokenListCache: Map<string, TokenMetadata> | null = null;
let tokenListTimestamp: number = 0;

/**
 * Converts IPFS URLs to use a public gateway to avoid CORS issues
 * @param url The original URL (might be IPFS)
 * @returns Proxied URL or original URL
 */
function resolveImageUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;

  // Handle IPFS URLs (ipfs:// protocol)
  if (url.startsWith('ipfs://')) {
    const cid = url.replace('ipfs://', '');
    return `https://ipfs.io/ipfs/${cid}`;
  }

  // Handle IPFS gateway URLs that might have CORS issues
  if (url.includes('.ipfs.') || url.includes('ipfs.io') || url.includes('cloudflare-ipfs.com')) {
    // Already using a gateway, return as-is
    return url;
  }

  return url;
}

// Cache prices for 30 seconds to avoid excessive API calls
const PRICE_CACHE_DURATION = 30 * 1000;
// Cache token list for 24 hours to minimize API calls
const TOKEN_LIST_CACHE_DURATION = 24 * 60 * 60 * 1000;
const TOKEN_LIST_STORAGE_KEY = 'jupiter_token_list_cache';
const TOKEN_LIST_TIMESTAMP_KEY = 'jupiter_token_list_timestamp';

/**
 * Fetches token metadata in batch using Helius DAS API
 * More efficient than individual calls - can fetch up to 1000 tokens per request
 * @param mintAddresses Array of token mint addresses to fetch
 * @returns Map of mint address to TokenMetadata
 */
export async function fetchTokenMetadataBatch(mintAddresses: string[]): Promise<Map<string, TokenMetadata>> {
  const metadataMap = new Map<string, TokenMetadata>();

  if (mintAddresses.length === 0) {
    return metadataMap;
  }

  // Check cache first
  const uncachedMints = mintAddresses.filter(mint => !metadataCache.has(mint));

  // If all are cached, return from cache
  if (uncachedMints.length === 0) {
    mintAddresses.forEach(mint => {
      const cached = metadataCache.get(mint);
      if (cached) {
        metadataMap.set(mint, cached);
      }
    });
    return metadataMap;
  }

  // Get RPC URL (should be Helius endpoint)
  const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL;

  if (!rpcUrl) {
    console.error('NEXT_PUBLIC_SOLANA_RPC_URL not configured');
    return metadataMap;
  }

  try {
    // Helius DAS API supports up to 1000 assets per request
    // Split into chunks if needed
    const chunkSize = 1000;
    const chunks: string[][] = [];

    for (let i = 0; i < uncachedMints.length; i += chunkSize) {
      chunks.push(uncachedMints.slice(i, i + chunkSize));
    }

    console.log(`Fetching metadata for ${uncachedMints.length} tokens using Helius DAS API...`);

    // Process each chunk
    for (const chunk of chunks) {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'metadata-batch',
          method: 'getAssetBatch',
          params: {
            ids: chunk
          }
        })
      });

      if (!response.ok) {
        console.error(`Helius API returned ${response.status}`);
        continue;
      }

      const data = await response.json();

      if (data.result && Array.isArray(data.result)) {
        // Try to get Jupiter token list for verification tags
        let jupiterTokens: Map<string, TokenMetadata> | null = null;
        try {
          jupiterTokens = await fetchJupiterTokenList();
        } catch (error) {
          console.warn('Could not fetch Jupiter token list for verification tags');
        }

        data.result.forEach((asset: HeliusAsset) => {
          if (!asset) return;

          // Check if token exists in Jupiter list for verification tags
          const jupiterToken = jupiterTokens?.get(asset.id);

          const metadata: TokenMetadata = {
            name: asset.content?.metadata?.name || jupiterToken?.name || 'Unknown Token',
            symbol: asset.content?.metadata?.symbol || asset.token_info?.symbol || jupiterToken?.symbol || 'UNKNOWN',
            decimals: asset.token_info?.decimals || jupiterToken?.decimals || 0,
            logoURI: resolveImageUrl(asset.content?.links?.image || jupiterToken?.logoURI),
            address: asset.id,
            tags: jupiterToken?.tags || [] // Use Jupiter tags for verification if available
          };

          // Cache the result
          metadataCache.set(asset.id, metadata);
          metadataMap.set(asset.id, metadata);
        });
      }
    }

    // Add cached results for mints that were already in cache
    mintAddresses.forEach(mint => {
      if (!metadataMap.has(mint) && metadataCache.has(mint)) {
        const cached = metadataCache.get(mint);
        if (cached) {
          metadataMap.set(mint, cached);
        }
      }
    });

    console.log(`Successfully fetched metadata for ${metadataMap.size} tokens`);
    return metadataMap;
  } catch (error) {
    console.error('Error fetching token metadata from Helius:', error);
    return metadataMap;
  }
}

/**
 * Fetches and caches the entire Jupiter token list
 * This reduces API calls from N requests (one per token) to just 1 request
 * Cache persists in localStorage for 24 hours
 */
async function fetchJupiterTokenList(): Promise<Map<string, TokenMetadata>> {
  const now = Date.now();

  // Check if in-memory cache is still valid
  if (tokenListCache && (now - tokenListTimestamp) < TOKEN_LIST_CACHE_DURATION) {
    return tokenListCache;
  }

  // Try to load from localStorage first
  if (typeof window !== 'undefined') {
    try {
      const cachedData = localStorage.getItem(TOKEN_LIST_STORAGE_KEY);
      const cachedTimestamp = localStorage.getItem(TOKEN_LIST_TIMESTAMP_KEY);

      if (cachedData && cachedTimestamp) {
        const timestamp = parseInt(cachedTimestamp, 10);
        // Check if localStorage cache is still valid (within 24 hours)
        if ((now - timestamp) < TOKEN_LIST_CACHE_DURATION) {
          const parsedData = JSON.parse(cachedData);
          tokenListCache = new Map(parsedData);
          tokenListTimestamp = timestamp;
          console.log(`Loaded ${tokenListCache.size} tokens from localStorage cache`);
          return tokenListCache;
        }
      }
    } catch (error) {
      console.warn('Failed to load token list from localStorage:', error);
    }
  }

  // Fetch fresh token list from Jupiter
  try {
    console.log('Fetching fresh token list from Jupiter API...');
    // Use CDN endpoint which is more reliable than API endpoint
    const response = await fetch('https://token.jup.ag/all', {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Jupiter API returned ${response.status}`);
    }

    const tokens = await response.json();

    // Build a Map for O(1) lookups by mint address
    // Filter for tokens with verification tags only to reduce cache size
    const tokenMap = new Map<string, TokenMetadata>();
    tokens.forEach((token: any) => {
      const tags = token.tags || [];
      // Only cache verified, strict, or community tagged tokens
      if (tags.includes('verified') || tags.includes('strict') || tags.includes('community')) {
        tokenMap.set(token.address, {
          name: token.name,
          symbol: token.symbol,
          decimals: token.decimals,
          logoURI: resolveImageUrl(token.logoURI),
          address: token.address,
          tags: tags
        });
      }
    });

    // Update in-memory cache
    tokenListCache = tokenMap;
    tokenListTimestamp = now;

    // Persist to localStorage
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(TOKEN_LIST_STORAGE_KEY, JSON.stringify(Array.from(tokenMap.entries())));
        localStorage.setItem(TOKEN_LIST_TIMESTAMP_KEY, now.toString());
        console.log(`Cached ${tokenMap.size} tokens to localStorage`);
      } catch (error) {
        console.warn('Failed to save token list to localStorage:', error);
      }
    }

    return tokenMap;
  } catch (error) {
    console.error('Error fetching Jupiter token list:', error);
    // Return empty map on error - will fall back to individual API calls
    return new Map();
  }
}

export async function fetchTokenPrices(mintAddresses: string[]): Promise<Map<string, number>> {
  const pricesMap = new Map<string, number>();
  const uncachedMints: string[] = [];

  // Check cache first to avoid unnecessary API calls
  // Only fetch prices that are either not cached or have expired (older than 30 seconds)
  const now = Date.now();
  mintAddresses.forEach(mint => {
    const cached = priceCache.get(mint);
    if (cached && (now - cached.timestamp) < PRICE_CACHE_DURATION) {
      // Use cached price if it's still fresh
      pricesMap.set(mint, cached.price);
    } else {
      // Mark this mint for fetching from API
      uncachedMints.push(mint);
    }
  });

  // Batch fetch uncached prices from Jupiter API v3 beta
  if (uncachedMints.length > 0) {
    try {
      // Jupiter API v3 has a limit of 50 ids per request
      const batchSize = 50;
      const batches: string[][] = [];

      for (let i = 0; i < uncachedMints.length; i += batchSize) {
        batches.push(uncachedMints.slice(i, i + batchSize));
      }

      console.log(`Fetching prices for ${uncachedMints.length} tokens in ${batches.length} batch(es)...`);

      // Get API key from environment
      const apiKey = process.env.NEXT_PUBLIC_JUPITER_API_KEY;

      if (!apiKey) {
        console.warn('NEXT_PUBLIC_JUPITER_API_KEY not configured, prices may not be available');
      }

      // Process each batch
      for (const batch of batches) {
        const headers: HeadersInit = {
          'Accept': 'application/json',
        };

        // Add API key to headers if available
        if (apiKey) {
          headers['x-api-key'] = apiKey;
        }

        const response = await fetch(
          `https://lite-api.jup.ag/price/v3?ids=${batch.join(',')}`,
          {
            method: 'GET',
            headers,
          }
        );

        if (response.ok) {
          // Parse the Jupiter Price API v3 response format
          const data: TokenPriceV3 = await response.json();

          // Process each mint address in this batch
          batch.forEach(mint => {
            // Access price data directly using mint address as key
            const priceInfo = data[mint];
            if (priceInfo && priceInfo.usdPrice !== undefined && priceInfo.usdPrice !== null) {
              const price = priceInfo.usdPrice;

              // Ensure the price is a valid number
              if (!isNaN(price) && price > 0) {
                pricesMap.set(mint, price);
                // Cache the price with timestamp to avoid repeated API calls
                priceCache.set(mint, { price, timestamp: now });
              }
            }
            // If no price data is found, the token simply won't be added to pricesMap
            // This will result in 'N/A' being displayed in the UI
          });
        } else {
          console.warn(`Jupiter Price API v3 returned ${response.status} for batch of ${batch.length} tokens`);
        }
      }
      // If response is not ok, silently fail - prices will show as 'N/A'
    } catch (error) {
      // Log API errors but don't throw - allows UI to gracefully show 'N/A' for failed fetches
      console.error('Error fetching token prices from Jupiter v3:', error);
    }
  }

  return pricesMap;
}

export async function fetchTokenPrice(mintAddress: string): Promise<number | null> {
  const pricesMap = await fetchTokenPrices([mintAddress]);
  return pricesMap.get(mintAddress) || null;
}

export function getTokenDisplayName(mintAddress: string, metadata: TokenMetadata | null): string {
  if (metadata) {
    return `${metadata.name} (${metadata.symbol})`;
  }
  // Fallback to shortened mint address
  return `${mintAddress.slice(0, 8)}...${mintAddress.slice(-8)}`;
}

export function formatPrice(price: number | null | undefined): string {
  if (!price || price === 0) return 'N/A';
  
  // For very small values (less than $0.01), show "<$0.01"
  if (price < 0.01) {
    return '<$0.01';
  } else if (price < 1) {
    return `$${price.toFixed(4)}`;
  } else if (price < 1000) {
    return `$${price.toFixed(2)}`;
  } else {
    return `$${price.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  }
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