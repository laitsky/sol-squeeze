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

function getJupiterBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_JUPITER_SWAP_API_URL || 'https://api.jup.ag'
  return configured.replace(/\/+$/, '')
}

function getJupiterApiKey(): string | null {
  return process.env.NEXT_PUBLIC_JUPITER_API_KEY || null
}

function getJupiterHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...extra,
  }
  const apiKey = getJupiterApiKey()
  if (apiKey) {
    headers['x-api-key'] = apiKey
  }
  return headers
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
}: JupiterQuoteRequest): Promise<Record<string, unknown>> {
  const cacheKey = `${inputMint}:${outputMint}:${amount}:${slippageBps}:${restrictIntermediateTokens}`
  const now = Date.now()

  if (!forceRefresh) {
    const cached = quoteCache.get(cacheKey)
    if (cached && (now - cached.timestamp) < cacheTtlMs) {
      return cached.quote
    }
  }

  const baseUrl = getJupiterBaseUrl()
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount,
    slippageBps: slippageBps.toString(),
    restrictIntermediateTokens: String(restrictIntermediateTokens),
  })

  const response = await fetch(`${baseUrl}/swap/v1/quote?${params.toString()}`, {
    method: 'GET',
    headers: getJupiterHeaders(),
  })

  const payload = await response.json()
  if (!response.ok || payload.error) {
    throw new Error(payload.error || `Quote API returned ${response.status}`)
  }

  quoteCache.set(cacheKey, {
    quote: payload,
    timestamp: now,
  })

  return payload
}

export async function buildJupiterSwapTransaction({
  quoteResponse,
  userPublicKey,
}: JupiterSwapRequest): Promise<{ transaction: VersionedTransaction; lastValidBlockHeight: number }> {
  const baseUrl = getJupiterBaseUrl()
  const response = await fetch(`${baseUrl}/swap/v1/swap`, {
    method: 'POST',
    headers: getJupiterHeaders({
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          maxLamports: 1000000,
          priorityLevel: 'high',
        },
      },
    }),
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
