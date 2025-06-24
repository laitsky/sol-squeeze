interface TokenMetadata {
  name: string;
  symbol: string;
  decimals: number;
  logoURI?: string;
  address: string;
  price?: number; // USDC price
  tags?: string[]; // Jupiter tags including verification status
}

// Jupiter API v2 price response format
// The API returns prices nested under a 'data' object with mint addresses as keys
interface TokenPrice {
  data: {
    [mintAddress: string]: {
      id: string;           // The mint address (same as the key)
      type: string;         // Price derivation type (e.g., "derivedPrice")
      price: string;        // Price in USDC as string - needs parsing to number
    };
  };
  timeTaken: number;        // API processing time in seconds
}

// Simple cache to avoid hitting API limits
const metadataCache = new Map<string, TokenMetadata | null>();
const priceCache = new Map<string, { price: number; timestamp: number }>();

// Cache prices for 30 seconds to avoid excessive API calls
const PRICE_CACHE_DURATION = 30 * 1000;

export async function fetchTokenMetadata(mintAddress: string): Promise<TokenMetadata | null> {
  // Check cache first
  if (metadataCache.has(mintAddress)) {
    return metadataCache.get(mintAddress) || null;
  }

  try {
    // Use Jupiter API to fetch token metadata
    const response = await fetch(`https://lite-api.jup.ag/tokens/v1/token/${mintAddress}`);
    
    if (!response.ok) {
      // If token not found in Jupiter, cache null to avoid repeated requests
      metadataCache.set(mintAddress, null);
      return null;
    }

    const data = await response.json();
    
    const metadata: TokenMetadata = {
      name: data.name || 'Unknown Token',
      symbol: data.symbol || 'UNKNOWN',
      decimals: data.decimals || 0,
      logoURI: data.logoURI,
      address: mintAddress,
      tags: data.tags || []
    };

    // Cache the result
    metadataCache.set(mintAddress, metadata);
    return metadata;
  } catch (error) {
    console.error(`Error fetching metadata for ${mintAddress}:`, error);
    // Cache null to avoid repeated failed requests
    metadataCache.set(mintAddress, null);
    return null;
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

  // Batch fetch uncached prices from Jupiter API v2
  if (uncachedMints.length > 0) {
    try {
      // Jupiter API v2 endpoint - accepts comma-separated mint addresses
      const response = await fetch(
        `https://lite-api.jup.ag/price/v2?ids=${uncachedMints.join(',')}`
      );
      
      if (response.ok) {
        // Parse the Jupiter API v2 response format
        const data: TokenPrice = await response.json();
        
        // Process each mint address we requested
        uncachedMints.forEach(mint => {
          // Access price data from the nested 'data' object using mint address as key
          const priceInfo = data.data?.[mint];
          if (priceInfo && priceInfo.price) {
            // Jupiter API v2 returns price as string, convert to number
            const price = parseFloat(priceInfo.price);
            // Ensure the parsed price is a valid number
            if (!isNaN(price)) {
              pricesMap.set(mint, price);
              // Cache the price with timestamp to avoid repeated API calls
              priceCache.set(mint, { price, timestamp: now });
            }
          }
          // If no price data is found, the token simply won't be added to pricesMap
          // This will result in 'N/A' being displayed in the UI
        });
      }
      // If response is not ok, silently fail - prices will show as 'N/A'
    } catch (error) {
      // Log API errors but don't throw - allows UI to gracefully show 'N/A' for failed fetches
      console.error('Error fetching token prices:', error);
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
  
  if (price < 0.0001) {
    return `$${price.toExponential(2)}`;
  } else if (price < 1) {
    return `$${price.toFixed(6)}`;
  } else if (price < 1000) {
    return `$${price.toFixed(4)}`;
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