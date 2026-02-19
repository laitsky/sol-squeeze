import { VersionedTransaction } from '@solana/web3.js'

export const SOL_MINT = 'So11111111111111111111111111111111111111112'

interface JupiterQuoteRequest {
  inputMint: string
  outputMint: string
  amount: string
  slippageBps?: number
  restrictIntermediateTokens?: boolean
  cacheTtlMs?: number
  forceRefresh?: boolean
  signal?: AbortSignal
}

interface JupiterSwapRequest {
  quoteResponse: Record<string, unknown>
  userPublicKey: string
}

interface JupiterSwapResponse {
  swapTransaction: string
  lastValidBlockHeight: number
}

interface QuoteCacheEntry {
  quote: Record<string, unknown>
  timestamp: number
}

const quoteCache = new Map<string, QuoteCacheEntry>()
const inFlightQuoteRequests = new Map<string, Promise<Record<string, unknown>>>()
const QUOTE_CACHE_MAX_ENTRIES = 500
const DEFAULT_BACKEND_BASE_URL = ''
const DEFAULT_MAX_PRIORITY_FEE_LAMPORTS = 0
const MAX_PRIORITY_FEE_LAMPORTS_CAP = 2_000_000

function getBackendBaseUrl(): string {
  const configured = import.meta.env.VITE_BACKEND_API_URL
  if (!configured) {
    return DEFAULT_BACKEND_BASE_URL
  }

  try {
    const parsed = new URL(configured)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Unsupported protocol')
    }

    const normalizedPath = parsed.pathname.replace(/\/+$/, '')
    return `${parsed.origin}${normalizedPath}`
  } catch {
    console.warn('Invalid VITE_BACKEND_API_URL; falling back to same-origin API routes.')
    return DEFAULT_BACKEND_BASE_URL
  }
}

function apiUrl(path: string): string {
  const baseUrl = getBackendBaseUrl()
  if (!baseUrl) {
    return path
  }

  return `${baseUrl}${path}`
}

function pruneQuoteCache() {
  if (quoteCache.size <= QUOTE_CACHE_MAX_ENTRIES) {
    return
  }

  let oldestKey: string | null = null
  let oldestTimestamp = Number.POSITIVE_INFINITY

  for (const [key, value] of quoteCache.entries()) {
    if (value.timestamp < oldestTimestamp) {
      oldestTimestamp = value.timestamp
      oldestKey = key
    }
  }

  if (oldestKey) {
    quoteCache.delete(oldestKey)
  }
}

function parseMaxPriorityFeeLamports(value: string | undefined): number {
  if (!value) return DEFAULT_MAX_PRIORITY_FEE_LAMPORTS

  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return DEFAULT_MAX_PRIORITY_FEE_LAMPORTS
  }

  const integerValue = Math.floor(parsed)
  if (integerValue <= 0) return 0

  return Math.min(integerValue, MAX_PRIORITY_FEE_LAMPORTS_CAP)
}

export function getMaxPriorityFeeLamports(): number {
  return parseMaxPriorityFeeLamports(import.meta.env.VITE_JUPITER_MAX_PRIORITY_FEE_LAMPORTS)
}

function getJupiterHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Accept: 'application/json',
    ...extra,
  }
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i += 1) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return bytes
}

function toPlainNumberString(value: number): string {
  const valueStr = String(value)
  if (!/[eE]/.test(valueStr)) {
    return valueStr
  }

  const [mantissa, exponentPart] = valueStr.toLowerCase().split('e')
  const exponent = parseInt(exponentPart, 10)
  if (Number.isNaN(exponent)) {
    return valueStr
  }

  const negative = mantissa.startsWith('-')
  const normalizedMantissa = negative ? mantissa.slice(1) : mantissa
  const [whole, fraction = ''] = normalizedMantissa.split('.')
  const digits = `${whole}${fraction}`.replace(/^0+/, '') || '0'

  if (exponent >= 0) {
    const zeros = exponent - fraction.length
    if (zeros >= 0) {
      return `${negative ? '-' : ''}${digits}${'0'.repeat(zeros)}`
    }
    const pivot = digits.length + zeros
    return `${negative ? '-' : ''}${digits.slice(0, pivot)}.${digits.slice(pivot)}`
  }

  const absoluteExponent = Math.abs(exponent)
  const integerLength = whole.length
  const pivot = integerLength - absoluteExponent
  if (pivot > 0) {
    return `${negative ? '-' : ''}${digits.slice(0, pivot)}.${digits.slice(pivot)}`
  }

  return `${negative ? '-' : ''}0.${'0'.repeat(Math.abs(pivot))}${digits}`
}

export function toRawAmount(amount: number, decimals: number): string {
  if (!Number.isFinite(amount) || amount <= 0) {
    return '0'
  }

  const safeDecimals = Math.max(0, Math.min(decimals, 18))
  const plain = toPlainNumberString(amount)

  if (plain.startsWith('-')) {
    return '0'
  }

  const [wholePart, fractionPart = ''] = plain.split('.')
  const wholeDigits = wholePart.replace(/\D/g, '') || '0'
  const fractionDigits = fractionPart.replace(/\D/g, '')
  const paddedFraction = `${fractionDigits}${'0'.repeat(safeDecimals)}`
  const raw = `${wholeDigits}${paddedFraction.slice(0, safeDecimals)}`.replace(/^0+/, '')

  return raw || '0'
}

export async function getJupiterQuote({
  inputMint,
  outputMint,
  amount,
  slippageBps = 100,
  restrictIntermediateTokens = true,
  cacheTtlMs = 15_000,
  forceRefresh = false,
  signal,
}: JupiterQuoteRequest): Promise<Record<string, unknown>> {
  const cacheKey = `${inputMint}:${outputMint}:${amount}:${slippageBps}:${restrictIntermediateTokens}`

  if (!forceRefresh) {
    const cached = quoteCache.get(cacheKey)
    if (cached && (Date.now() - cached.timestamp) < cacheTtlMs) {
      return cached.quote
    }
  }

  if (!forceRefresh && !signal) {
    const inFlight = inFlightQuoteRequests.get(cacheKey)
    if (inFlight) {
      return inFlight
    }
  }

  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount,
    slippageBps: slippageBps.toString(),
    restrictIntermediateTokens: String(restrictIntermediateTokens),
  })

  const request = async () => {
    const response = await fetch(`${apiUrl('/api/quote')}?${params.toString()}`, {
      method: 'GET',
      headers: getJupiterHeaders(),
      signal,
    })

    const payload = await response.json()
    if (!response.ok || payload.error) {
      throw new Error(payload.error || `Quote API returned ${response.status}`)
    }

    quoteCache.set(cacheKey, {
      quote: payload,
      timestamp: Date.now(),
    })
    pruneQuoteCache()

    return payload
  }

  if (forceRefresh || signal) {
    return request()
  }

  const inFlight = request().finally(() => {
    inFlightQuoteRequests.delete(cacheKey)
  })
  inFlightQuoteRequests.set(cacheKey, inFlight)
  return inFlight
}

export async function buildJupiterSwapTransaction({
  quoteResponse,
  userPublicKey,
}: JupiterSwapRequest): Promise<{ transaction: VersionedTransaction; lastValidBlockHeight: number }> {
  const body: Record<string, unknown> = {
    quoteResponse,
    userPublicKey,
  }

  const response = await fetch(apiUrl('/api/swap'), {
    method: 'POST',
    headers: getJupiterHeaders({
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify(body),
  })

  const payload: JupiterSwapResponse & { error?: string } = await response.json()
  if (!response.ok || payload.error || !payload.swapTransaction) {
    throw new Error(payload.error || `Swap API returned ${response.status}`)
  }

  const txBytes = base64ToUint8Array(payload.swapTransaction)
  const transaction = VersionedTransaction.deserialize(txBytes)

  return {
    transaction,
    lastValidBlockHeight: payload.lastValidBlockHeight,
  }
}
