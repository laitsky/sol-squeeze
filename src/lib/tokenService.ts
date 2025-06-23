interface TokenMetadata {
  name: string;
  symbol: string;
  decimals: number;
  logoURI?: string;
  address: string;
  price?: number; // USDC price
}

interface TokenPrice {
  [mintAddress: string]: {
    price: number;
  };
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
      address: mintAddress
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
  
  // Check cache first
  const now = Date.now();
  mintAddresses.forEach(mint => {
    const cached = priceCache.get(mint);
    if (cached && (now - cached.timestamp) < PRICE_CACHE_DURATION) {
      pricesMap.set(mint, cached.price);
    } else {
      uncachedMints.push(mint);
    }
  });

  // Fetch uncached prices
  if (uncachedMints.length > 0) {
    try {
      const response = await fetch(
        `https://lite-api.jup.ag/price/v2?ids=${uncachedMints.join(',')}`
      );
      
      if (response.ok) {
        const data: TokenPrice = await response.json();
        
        uncachedMints.forEach(mint => {
          const priceData = data[mint];
          if (priceData && typeof priceData.price === 'number') {
            const price = priceData.price;
            pricesMap.set(mint, price);
            priceCache.set(mint, { price, timestamp: now });
          }
        });
      }
    } catch (error) {
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