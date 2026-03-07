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
  balance?: number | string;
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
  amountRaw: string;
  amount: number;
  metadata: TokenMetadata | null;
  price: number | null;
  priceFetched: boolean;
}

export interface FetchTokensOptions {
  signal?: AbortSignal;
  onFirstPage?: (tokens: WalletTokenBalance[]) => void;
}

export type TokenServiceErrorCode = 'API_ERROR';

export class TokenServiceError extends Error {
  code: TokenServiceErrorCode;

  constructor(code: TokenServiceErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'TokenServiceError';
  }
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

const DEFAULT_BACKEND_BASE_URL = '';
const MAX_TOKEN_DECIMALS = 30;

function isAllowedBackendOrigin(parsed: URL): boolean {
  if (parsed.protocol === 'https:') {
    return true;
  }

  return parsed.protocol === 'http:' && (
    parsed.hostname === 'localhost'
    || parsed.hostname === '127.0.0.1'
    || parsed.hostname === '[::1]'
  );
}

function clampTokenDecimals(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.floor(value), MAX_TOKEN_DECIMALS));
}

function toPlainNumberString(value: number): string {
  const valueStr = String(value);
  if (!/[eE]/.test(valueStr)) {
    return valueStr;
  }

  const [mantissa, exponentPart] = valueStr.toLowerCase().split('e');
  const exponent = parseInt(exponentPart, 10);
  if (Number.isNaN(exponent)) {
    return valueStr;
  }

  const negative = mantissa.startsWith('-');
  const normalizedMantissa = negative ? mantissa.slice(1) : mantissa;
  const [whole, fraction = ''] = normalizedMantissa.split('.');
  const digits = `${whole}${fraction}`.replace(/^0+/, '') || '0';

  if (exponent >= 0) {
    const zeros = exponent - fraction.length;
    if (zeros >= 0) {
      return `${negative ? '-' : ''}${digits}${'0'.repeat(zeros)}`;
    }
    const pivot = digits.length + zeros;
    return `${negative ? '-' : ''}${digits.slice(0, pivot)}.${digits.slice(pivot)}`;
  }

  const absoluteExponent = Math.abs(exponent);
  const integerLength = whole.length;
  const pivot = integerLength - absoluteExponent;
  if (pivot > 0) {
    return `${negative ? '-' : ''}${digits.slice(0, pivot)}.${digits.slice(pivot)}`;
  }

  return `${negative ? '-' : ''}0.${'0'.repeat(Math.abs(pivot))}${digits}`;
}

function decimalValueToRawAmount(value: number | string, decimals: number): bigint | null {
  const safeDecimals = clampTokenDecimals(decimals);

  let plain: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    plain = toPlainNumberString(value);
  } else {
    const trimmed = value.trim();
    if (!trimmed) return null;
    plain = trimmed;
  }

  if (plain.startsWith('-')) {
    return null;
  }

  if (!/^\d+(\.\d+)?$/.test(plain)) {
    return null;
  }

  const [wholePart, fractionPart = ''] = plain.split('.');
  const wholeDigits = wholePart.replace(/\D/g, '') || '0';
  const fractionDigits = fractionPart.replace(/\D/g, '');
  const paddedFraction = `${fractionDigits}${'0'.repeat(safeDecimals)}`;
  const raw = `${wholeDigits}${paddedFraction.slice(0, safeDecimals)}`.replace(/^0+/, '');

  return BigInt(raw || '0');
}

function rawAmountToDisplayAmount(rawAmount: bigint, decimals: number): number {
  if (rawAmount <= BigInt(0)) return 0;

  const safeDecimals = clampTokenDecimals(decimals);
  if (safeDecimals === 0) {
    const asNumber = Number(rawAmount.toString());
    return Number.isFinite(asNumber) ? asNumber : Number.MAX_VALUE;
  }

  const rawText = rawAmount.toString();
  const wholePart = rawText.length > safeDecimals
    ? rawText.slice(0, rawText.length - safeDecimals)
    : '0';
  const fractionPart = rawText.length > safeDecimals
    ? rawText.slice(rawText.length - safeDecimals)
    : rawText.padStart(safeDecimals, '0');
  const normalizedFraction = fractionPart.replace(/0+$/, '');
  const decimalText = normalizedFraction ? `${wholePart}.${normalizedFraction}` : wholePart;
  const parsed = Number(decimalText);

  return Number.isFinite(parsed) ? parsed : Number.MAX_VALUE;
}

function parseRawAmount(value: string): bigint {
  if (!/^\d+$/.test(value)) return BigInt(0);
  return BigInt(value);
}

function getBackendBaseUrl(): string {
  const configured = import.meta.env.VITE_BACKEND_API_URL;
  if (!configured) {
    return DEFAULT_BACKEND_BASE_URL;
  }

  try {
    const parsed = new URL(configured);
    if (!isAllowedBackendOrigin(parsed)) {
      throw new Error('Unsupported or insecure backend origin');
    }

    const normalizedPath = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.origin}${normalizedPath}`;
  } catch {
    console.warn('Invalid VITE_BACKEND_API_URL; falling back to same-origin API routes.');
    return DEFAULT_BACKEND_BASE_URL;
  }
}

function apiUrl(path: string): string {
  const baseUrl = getBackendBaseUrl();
  if (!baseUrl) {
    return path;
  }

  return `${baseUrl}${path}`;
}

export function displayAmountFromRaw(rawAmount: string, decimals: number): number {
  const rawValue = parseRawAmount(rawAmount);
  return rawAmountToDisplayAmount(rawValue, decimals);
}

function resolveImageUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;

  const trimmed = url.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith('ipfs://')) {
    const cid = trimmed.replace('ipfs://', '');
    return `https://ipfs.io/ipfs/${cid}`;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function getFallbackTokenName(mint: string): string {
  return `Token ${mint.slice(0, 4)}...${mint.slice(-4)}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

const FETCH_PAGE_SIZE = 100;
const FETCH_MAX_PAGES = 50;
const FETCH_PARALLEL_BATCH = 2;
const FETCH_INTER_BATCH_DELAY_MS = 150;
const FETCH_MAX_RETRIES = 3;
const FETCH_RETRY_BASE_DELAY_MS = 500;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

export async function fetchWalletTokenBalances(
  walletAddress: string,
  options?: FetchTokensOptions
): Promise<WalletTokenBalance[]> {
  if (!walletAddress) {
    return [];
  }

  const signal = options?.signal;
  const onFirstPage = options?.onFirstPage;
  const tokenMap = new Map<string, WalletTokenBalance>();

  async function fetchPage(page: number): Promise<HeliusWalletBalancesResponse> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= FETCH_MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const backoff = FETCH_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        await delay(backoff, signal);
      }

      const params = new URLSearchParams({
        page: page.toString(),
        limit: FETCH_PAGE_SIZE.toString(),
      });

      const response = await fetch(
        `${apiUrl(`/api/wallet/${encodeURIComponent(walletAddress)}/balances`)}?${params.toString()}`,
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
          },
          signal,
        }
      );

      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`Wallet API returned ${response.status}`);
        if (attempt < FETCH_MAX_RETRIES) continue;
      }

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const apiError =
          payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
            ? payload.error
            : null;
        throw new Error(apiError || `Wallet API returned ${response.status}`);
      }

      return (payload || {}) as HeliusWalletBalancesResponse;
    }

    throw lastError;
  }

  function processBalances(balances: HeliusWalletBalance[]) {
    for (const balance of balances) {
      const mint = balance.mint?.trim();
      if (!mint) {
        continue;
      }

      const existing = tokenMap.get(mint);
      const localToken = LOCAL_TOKEN_REGISTRY[mint];
      const decimals = typeof balance.decimals === 'number'
        ? clampTokenDecimals(balance.decimals)
        : clampTokenDecimals(localToken?.decimals ?? existing?.metadata?.decimals ?? 0);
      const balanceRaw = balance.balance === undefined
        ? null
        : decimalValueToRawAmount(balance.balance, decimals);

      if (balanceRaw === null || balanceRaw <= BigInt(0)) {
        continue;
      }

      const metadata: TokenMetadata = {
        name: balance.name || localToken?.name || existing?.metadata?.name || getFallbackTokenName(mint),
        symbol: balance.symbol || localToken?.symbol || existing?.metadata?.symbol || 'UNKNOWN',
        decimals,
        logoURI: resolveImageUrl(balance.logoUri || existing?.metadata?.logoURI),
        address: mint,
        tags: localToken?.tags || existing?.metadata?.tags || [],
      };

      const tokenPrice =
        typeof balance.pricePerToken === 'number' && balance.pricePerToken > 0
          ? balance.pricePerToken
          : existing?.price ?? null;

      if (existing) {
        const nextAmountRaw = parseRawAmount(existing.amountRaw) + balanceRaw;
        existing.amountRaw = nextAmountRaw.toString();
        existing.amount = rawAmountToDisplayAmount(nextAmountRaw, metadata.decimals);
        existing.metadata = metadata;
        existing.price = tokenPrice;
        existing.priceFetched = true;
      } else {
        const amountRaw = balanceRaw.toString();
        tokenMap.set(mint, {
          mint,
          amountRaw,
          amount: rawAmountToDisplayAmount(balanceRaw, metadata.decimals),
          metadata,
          price: tokenPrice,
          priceFetched: true,
        });
      }
    }
  }

  try {
    // Page 1: fetch first to check if more pages exist
    const firstPage = await fetchPage(1);
    processBalances(firstPage.balances || []);

    // Show first page results immediately for progressive rendering
    if (onFirstPage && tokenMap.size > 0) {
      onFirstPage(Array.from(tokenMap.values()));
    }

    if (!firstPage.pagination?.hasMore) {
      return Array.from(tokenMap.values());
    }

    // Remaining pages: fetch in small parallel batches with inter-batch delay
    let currentPage = 2;
    let hasMore = true;

    while (hasMore && currentPage <= FETCH_MAX_PAGES) {
      if (signal?.aborted) break;

      const batchEnd = Math.min(currentPage + FETCH_PARALLEL_BATCH - 1, FETCH_MAX_PAGES);
      const pageNumbers = Array.from(
        { length: batchEnd - currentPage + 1 },
        (_, i) => currentPage + i
      );

      const pages = await Promise.all(pageNumbers.map(p => fetchPage(p)));

      for (const pageData of pages) {
        processBalances(pageData.balances || []);
        if (!pageData.pagination?.hasMore) {
          hasMore = false;
          break;
        }
      }

      currentPage = batchEnd + 1;

      // Throttle between batches to avoid upstream rate limits
      if (hasMore && currentPage <= FETCH_MAX_PAGES) {
        await delay(FETCH_INTER_BATCH_DELAY_MS, signal);
      }
    }

    if (hasMore && currentPage > FETCH_MAX_PAGES) {
      console.warn(`Stopped wallet pagination at ${FETCH_MAX_PAGES} pages for wallet ${walletAddress}`);
    }

    return Array.from(tokenMap.values());
  } catch (error) {
    // On abort, return whatever we have so far
    if (signal?.aborted) return Array.from(tokenMap.values());
    if (tokenMap.size > 0) {
      console.warn('Returning partial wallet token balances after API error:', error);
      return Array.from(tokenMap.values());
    }

    throw new TokenServiceError(
      'API_ERROR',
      `Error fetching wallet token balances from Helius Wallet API: ${errorMessage(error)}`
    );
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
