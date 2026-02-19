import dotenv from 'dotenv'
import express, { type NextFunction, type Request, type Response } from 'express'
import helmet from 'helmet'
import path from 'path'
import { PublicKey, VersionedTransaction } from '@solana/web3.js'
import { z } from 'zod'

dotenv.config()
dotenv.config({ path: '.env.local', override: true })

const SOL_MINT = 'So11111111111111111111111111111111111111112'
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const DEFAULT_JUPITER_BASE_URL = 'https://api.jup.ag'
const DEFAULT_HELIUS_BASE_URL = 'https://api.helius.xyz'
const DEFAULT_JUPITER_ALLOWED_HOSTS = new Set(['api.jup.ag', 'lite-api.jup.ag', 'quote-api.jup.ag'])
const DEFAULT_HELIUS_ALLOWED_HOSTS = new Set(['api.helius.xyz'])
const DEFAULT_MAX_PRIORITY_FEE_LAMPORTS = 0
const MAX_PRIORITY_FEE_LAMPORTS_CAP = 2_000_000
const ALLOWED_OUTPUT_MINTS = new Set([SOL_MINT, USDC_MINT])
const QUOTE_CACHE_TTL_MS = 15_000
const QUOTE_CACHE_MAX_ENTRIES = 500
const HELIUS_CACHE_TTL_MS = 30_000
const HELIUS_CACHE_MAX_ENTRIES = 200
const HELIUS_MAX_CONCURRENT = 4
const HELIUS_MAX_RETRIES = 3
const HELIUS_RETRY_BASE_DELAY_MS = 300
const REQUEST_TIMEOUT_MS = 15_000
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_REQUESTS = 240
const RATE_LIMIT_MAX_KEYS = 12_000
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 30_000
const MAX_RAW_AMOUNT_DIGITS = 30
const MAX_SWAP_TRANSACTION_B64_LENGTH = 24_000

type JsonRecord = Record<string, unknown>

interface QuoteCacheEntry {
  payload: JsonRecord
  timestamp: number
}

const quoteCache = new Map<string, QuoteCacheEntry>()
const inFlightQuoteRequests = new Map<string, Promise<JsonRecord>>()
const rateLimitByIp = new Map<string, { count: number; resetAt: number; touchedAt: number }>()
let lastRateLimitCleanupAt = 0

interface HeliusCacheEntry {
  payload: unknown
  timestamp: number
}

const heliusCache = new Map<string, HeliusCacheEntry>()
const inFlightHeliusRequests = new Map<string, Promise<{ ok: boolean; status: number; payload: unknown }>>()

class Semaphore {
  private current = 0
  private readonly max: number
  private readonly queue: Array<() => void> = []

  constructor(max: number) {
    this.max = max
  }

  acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++
      return Promise.resolve()
    }
    return new Promise<void>(resolve => {
      this.queue.push(() => {
        this.current++
        resolve()
      })
    })
  }

  release(): void {
    this.current--
    const next = this.queue.shift()
    if (next) next()
  }
}

const heliusSemaphore = new Semaphore(HELIUS_MAX_CONCURRENT)

function getEnv(name: string): string | undefined {
  const value = process.env[name]
  if (!value) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function getConfiguredHostAllowlist(rawValue: string | undefined, defaults: Set<string>): Set<string> {
  if (!rawValue) {
    return defaults
  }

  const hosts = rawValue
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean)

  if (hosts.length === 0) {
    return defaults
  }

  return new Set(hosts)
}

function sanitizeApiBaseUrl(baseUrl: string, allowlist: Set<string>, fallback: string, label: string): string {
  try {
    const parsed = new URL(baseUrl)
    const normalizedHost = parsed.hostname.toLowerCase()
    if (parsed.protocol !== 'https:' || !allowlist.has(normalizedHost)) {
      throw new Error('API URL must be https and allowlisted')
    }

    const normalizedPath = parsed.pathname.replace(/\/+$/, '')
    return `${parsed.origin}${normalizedPath}`
  } catch {
    console.warn(`[security] Invalid ${label}; falling back to ${fallback}`)
    return fallback
  }
}

function parseMaxPriorityFeeLamports(rawValue: string | undefined): number {
  if (!rawValue) return DEFAULT_MAX_PRIORITY_FEE_LAMPORTS

  const parsed = Number(rawValue)
  if (!Number.isFinite(parsed)) {
    return DEFAULT_MAX_PRIORITY_FEE_LAMPORTS
  }

  const integerValue = Math.floor(parsed)
  if (integerValue <= 0) return 0

  return Math.min(integerValue, MAX_PRIORITY_FEE_LAMPORTS_CAP)
}

function getHeliusApiKey(): string | null {
  const explicitKey = getEnv('HELIUS_API_KEY')
  if (explicitKey) {
    return explicitKey
  }

  const rpcUrl = getEnv('SOLANA_RPC_URL')
  if (!rpcUrl) {
    return null
  }

  try {
    const parsed = new URL(rpcUrl)
    const key = parsed.searchParams.get('api-key')
    return key && key.trim().length > 0 ? key.trim() : null
  } catch {
    return null
  }
}

function getJupiterApiKey(): string | null {
  return getEnv('JUPITER_API_KEY') || null
}

function getClientIp(request: Request): string {
  return request.ip || request.socket.remoteAddress || 'unknown'
}

function parseTrustProxy(value: string | undefined): boolean | number {
  if (!value) {
    return false
  }

  const normalized = value.trim().toLowerCase()
  if (!normalized) {
    return false
  }

  if (normalized === 'true') {
    return 1
  }

  if (normalized === 'false') {
    return false
  }

  const hops = Number(normalized)
  if (Number.isFinite(hops) && hops >= 0) {
    return Math.floor(hops)
  }

  return false
}

function pruneRateLimitState(now: number) {
  if (now - lastRateLimitCleanupAt < RATE_LIMIT_CLEANUP_INTERVAL_MS && rateLimitByIp.size <= RATE_LIMIT_MAX_KEYS) {
    return
  }

  lastRateLimitCleanupAt = now

  for (const [ip, state] of rateLimitByIp.entries()) {
    if (state.resetAt <= now) {
      rateLimitByIp.delete(ip)
    }
  }

  if (rateLimitByIp.size <= RATE_LIMIT_MAX_KEYS) {
    return
  }

  const overflow = rateLimitByIp.size - RATE_LIMIT_MAX_KEYS
  const leastRecentEntries = Array.from(rateLimitByIp.entries())
    .sort((a, b) => a[1].touchedAt - b[1].touchedAt)
    .slice(0, overflow)

  for (const [ip] of leastRecentEntries) {
    rateLimitByIp.delete(ip)
  }
}

function parsePositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'string') return fallback

  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < min) return fallback

  return Math.min(Math.floor(parsed), max)
}

function getFirstString(value: unknown): string | null {
  if (typeof value === 'string') {
    return value
  }

  if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') {
    return value[0]
  }

  return null
}

function parseBooleanQuery(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

function isValidPublicKey(value: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new PublicKey(value)
    return true
  } catch {
    return false
  }
}

function normalizeErrorMessage(payload: unknown, fallback: string): string {
  if (typeof payload === 'object' && payload !== null) {
    if ('error' in payload && typeof payload.error === 'string' && payload.error.length > 0) {
      return payload.error
    }

    if ('message' in payload && typeof payload.message === 'string' && payload.message.length > 0) {
      return payload.message
    }
  }

  return fallback
}

async function fetchJsonWithTimeout(url: string, init: RequestInit): Promise<{ response: globalThis.Response; payload: unknown }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    })

    const payload = await response.json().catch(() => null)
    return { response, payload }
  } finally {
    clearTimeout(timeout)
  }
}

function pruneQuoteCache() {
  if (quoteCache.size <= QUOTE_CACHE_MAX_ENTRIES) {
    return
  }

  let oldestKey: string | null = null
  let oldestTimestamp = Number.POSITIVE_INFINITY

  for (const [cacheKey, entry] of quoteCache.entries()) {
    if (entry.timestamp < oldestTimestamp) {
      oldestTimestamp = entry.timestamp
      oldestKey = cacheKey
    }
  }

  if (oldestKey) {
    quoteCache.delete(oldestKey)
  }
}

function pruneHeliusCache() {
  const now = Date.now()

  for (const [key, entry] of heliusCache.entries()) {
    if (now - entry.timestamp >= HELIUS_CACHE_TTL_MS) {
      heliusCache.delete(key)
    }
  }

  if (heliusCache.size <= HELIUS_CACHE_MAX_ENTRIES) {
    return
  }

  let oldestKey: string | null = null
  let oldestTimestamp = Number.POSITIVE_INFINITY
  for (const [key, entry] of heliusCache.entries()) {
    if (entry.timestamp < oldestTimestamp) {
      oldestTimestamp = entry.timestamp
      oldestKey = key
    }
  }
  if (oldestKey) {
    heliusCache.delete(oldestKey)
  }
}

async function fetchHeliusWithRetry(
  url: string,
  headers: Record<string, string>
): Promise<{ ok: boolean; status: number; payload: unknown }> {
  let lastError: unknown

  for (let attempt = 0; attempt <= HELIUS_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = HELIUS_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1)
      await new Promise(resolve => setTimeout(resolve, delay))
    }

    await heliusSemaphore.acquire()
    try {
      const { response, payload } = await fetchJsonWithTimeout(url, {
        method: 'GET',
        headers,
      })

      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`Helius API returned ${response.status}`)
        if (attempt < HELIUS_MAX_RETRIES) continue
        return { ok: false, status: response.status, payload }
      }

      return { ok: response.ok, status: response.status, payload }
    } catch (err) {
      lastError = err
      if (attempt >= HELIUS_MAX_RETRIES) throw err
    } finally {
      heliusSemaphore.release()
    }
  }

  throw lastError
}

const quoteQuerySchema = z.object({
  inputMint: z.string().refine(isValidPublicKey, 'Invalid inputMint'),
  outputMint: z.string().refine(isValidPublicKey, 'Invalid outputMint'),
  amount: z.string().regex(/^\d+$/, 'amount must be an integer string').max(MAX_RAW_AMOUNT_DIGITS, 'amount is too large').refine(value => BigInt(value) > BigInt(0), 'amount must be > 0'),
  slippageBps: z.number().int().min(10).max(5000),
  restrictIntermediateTokens: z.boolean(),
})

const swapBodySchema = z.object({
  userPublicKey: z.string().refine(isValidPublicKey, 'Invalid userPublicKey'),
  quoteResponse: z.object({
    inputMint: z.string().refine(isValidPublicKey, 'Invalid quoteResponse.inputMint'),
    outputMint: z.string().refine(isValidPublicKey, 'Invalid quoteResponse.outputMint'),
    inAmount: z.string().regex(/^\d+$/, 'Invalid quoteResponse.inAmount').max(MAX_RAW_AMOUNT_DIGITS, 'quoteResponse.inAmount is too large').refine(value => BigInt(value) > BigInt(0), 'quoteResponse.inAmount must be > 0'),
  }).passthrough(),
})

const swapResponseSchema = z.object({
  swapTransaction: z.string().min(1).max(MAX_SWAP_TRANSACTION_B64_LENGTH),
  lastValidBlockHeight: z.number().int().nonnegative(),
}).passthrough()

const jupiterBaseUrl = sanitizeApiBaseUrl(
  getEnv('JUPITER_SWAP_API_URL') || DEFAULT_JUPITER_BASE_URL,
  getConfiguredHostAllowlist(
    getEnv('JUPITER_SWAP_API_ALLOWED_HOSTS'),
    DEFAULT_JUPITER_ALLOWED_HOSTS
  ),
  DEFAULT_JUPITER_BASE_URL,
  'JUPITER_SWAP_API_URL'
)

const heliusBaseUrl = sanitizeApiBaseUrl(
  getEnv('HELIUS_WALLET_API_URL') || DEFAULT_HELIUS_BASE_URL,
  getConfiguredHostAllowlist(
    getEnv('HELIUS_WALLET_API_ALLOWED_HOSTS'),
    DEFAULT_HELIUS_ALLOWED_HOSTS
  ),
  DEFAULT_HELIUS_BASE_URL,
  'HELIUS_WALLET_API_URL'
)

const heliusApiKey = getHeliusApiKey()
const jupiterApiKey = getJupiterApiKey()
const maxPriorityFeeLamports = parseMaxPriorityFeeLamports(
  getEnv('JUPITER_MAX_PRIORITY_FEE_LAMPORTS')
)

const app = express()
app.set('trust proxy', parseTrustProxy(getEnv('TRUST_PROXY')))

app.disable('x-powered-by')
app.use(helmet())
app.use(express.json({ limit: '64kb' }))

app.use('/api', (request: Request, response: Response, next: NextFunction) => {
  const now = Date.now()
  pruneRateLimitState(now)

  const key = getClientIp(request)
  const current = rateLimitByIp.get(key)
  response.setHeader('Cache-Control', 'no-store')

  if (!current || now > current.resetAt) {
    rateLimitByIp.set(key, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
      touchedAt: now,
    })
    next()
    return
  }

  if (current.count >= RATE_LIMIT_MAX_REQUESTS) {
    response.status(429).json({ error: 'Rate limit exceeded. Please retry shortly.' })
    return
  }

  current.count += 1
  current.touchedAt = now
  next()
})

app.get('/api/health', (_request: Request, response: Response) => {
  response.json({ ok: true })
})

app.get('/api/wallet/:walletAddress/balances', async (request: Request, response: Response) => {
  const walletAddress = getFirstString(request.params.walletAddress)?.trim()
  if (!walletAddress || !isValidPublicKey(walletAddress)) {
    response.status(400).json({ error: 'Invalid wallet address.' })
    return
  }

  if (!heliusApiKey) {
    response.status(503).json({ error: 'Wallet balance service is not configured.' })
    return
  }

  const page = parsePositiveInt(request.query.page, 1, 1, 50)
  const limit = parsePositiveInt(request.query.limit, 100, 1, 100)
  const cacheKey = `${walletAddress}:${page}:${limit}`

  // 1. Serve from cache if fresh
  const cached = heliusCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < HELIUS_CACHE_TTL_MS) {
    response.json(cached.payload)
    return
  }

  // 2. Coalesce in-flight requests for the same wallet+page
  const inFlight = inFlightHeliusRequests.get(cacheKey)
  if (inFlight) {
    try {
      const result = await inFlight
      if (result.ok) {
        response.json(result.payload)
      } else {
        const error = normalizeErrorMessage(result.payload, `Wallet API returned ${result.status}`)
        response.status(502).json({ error })
      }
    } catch {
      response.status(502).json({ error: 'Wallet API request failed.' })
    }
    return
  }

  // 3. Fetch from Helius with concurrency control + retry
  const params = new URLSearchParams({
    'api-key': heliusApiKey,
    page: String(page),
    limit: String(limit),
    showNative: 'false',
    showNfts: 'false',
    showZeroBalance: 'false',
  })

  const url = `${heliusBaseUrl}/v1/wallet/${encodeURIComponent(walletAddress)}/balances?${params.toString()}`
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'x-api-key': heliusApiKey,
  }

  const requestPromise = fetchHeliusWithRetry(url, headers)
  inFlightHeliusRequests.set(cacheKey, requestPromise)

  try {
    const result = await requestPromise

    if (!result.ok) {
      const error = normalizeErrorMessage(result.payload, `Wallet API returned ${result.status}`)
      if (result.status === 429) {
        response.setHeader('Retry-After', '5')
        response.status(429).json({ error: 'Upstream rate limit reached. Please retry shortly.' })
      } else {
        response.status(502).json({ error })
      }
      return
    }

    // Cache the successful response
    heliusCache.set(cacheKey, { payload: result.payload, timestamp: Date.now() })
    pruneHeliusCache()

    response.json(result.payload)
  } catch {
    response.status(502).json({ error: 'Wallet API request failed.' })
  } finally {
    inFlightHeliusRequests.delete(cacheKey)
  }
})

app.get('/api/quote', async (request: Request, response: Response) => {
  const queryCandidate = {
    inputMint: getFirstString(request.query.inputMint)?.trim() || '',
    outputMint: getFirstString(request.query.outputMint)?.trim() || '',
    amount: getFirstString(request.query.amount)?.trim() || '',
    slippageBps: parsePositiveInt(request.query.slippageBps, 100, 10, 5000),
    restrictIntermediateTokens: parseBooleanQuery(request.query.restrictIntermediateTokens, true),
  }

  const parsed = quoteQuerySchema.safeParse(queryCandidate)
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid quote request.' })
    return
  }

  const quoteQuery = parsed.data
  if (!ALLOWED_OUTPUT_MINTS.has(quoteQuery.outputMint)) {
    response.status(400).json({ error: 'outputMint is not allowed by policy.' })
    return
  }

  const cacheKey = `${quoteQuery.inputMint}:${quoteQuery.outputMint}:${quoteQuery.amount}:${quoteQuery.slippageBps}:${quoteQuery.restrictIntermediateTokens}`
  const cached = quoteCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < QUOTE_CACHE_TTL_MS) {
    response.json(cached.payload)
    return
  }

  const inFlight = inFlightQuoteRequests.get(cacheKey)
  if (inFlight) {
    try {
      response.json(await inFlight)
    } catch {
      response.status(502).json({ error: 'Quote request failed.' })
    }
    return
  }

  const requestPromise = (async () => {
    const params = new URLSearchParams({
      inputMint: quoteQuery.inputMint,
      outputMint: quoteQuery.outputMint,
      amount: quoteQuery.amount,
      slippageBps: String(quoteQuery.slippageBps),
      restrictIntermediateTokens: String(quoteQuery.restrictIntermediateTokens),
    })

    const headers: Record<string, string> = {
      Accept: 'application/json',
    }

    if (jupiterApiKey) {
      headers['x-api-key'] = jupiterApiKey
    }

    const { response: upstreamResponse, payload } = await fetchJsonWithTimeout(
      `${jupiterBaseUrl}/swap/v1/quote?${params.toString()}`,
      {
        method: 'GET',
        headers,
      }
    )

    if (!upstreamResponse.ok || (typeof payload === 'object' && payload !== null && 'error' in payload)) {
      const error = normalizeErrorMessage(payload, `Quote API returned ${upstreamResponse.status}`)
      throw new Error(error)
    }

    const safePayload = (payload && typeof payload === 'object' ? payload : {}) as JsonRecord
    quoteCache.set(cacheKey, {
      payload: safePayload,
      timestamp: Date.now(),
    })
    pruneQuoteCache()

    return safePayload
  })()

  inFlightQuoteRequests.set(cacheKey, requestPromise)

  try {
    const payload = await requestPromise
    response.json(payload)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Quote request failed.'
    response.status(502).json({ error: message })
  } finally {
    inFlightQuoteRequests.delete(cacheKey)
  }
})

app.post('/api/swap', async (request: Request, response: Response) => {
  const parsed = swapBodySchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid swap request.' })
    return
  }

  const { userPublicKey, quoteResponse } = parsed.data

  if (quoteResponse.outputMint !== SOL_MINT) {
    response.status(400).json({ error: 'Only swaps to SOL are allowed by policy.' })
    return
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }

  if (jupiterApiKey) {
    headers['x-api-key'] = jupiterApiKey
  }

  const swapBody: Record<string, unknown> = {
    quoteResponse,
    userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    dynamicSlippage: true,
  }

  if (maxPriorityFeeLamports > 0) {
    swapBody.prioritizationFeeLamports = {
      priorityLevelWithMaxLamports: {
        maxLamports: maxPriorityFeeLamports,
        priorityLevel: 'high',
      },
    }
  }

  try {
    const { response: upstreamResponse, payload } = await fetchJsonWithTimeout(
      `${jupiterBaseUrl}/swap/v1/swap`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(swapBody),
      }
    )

    if (!upstreamResponse.ok || (typeof payload === 'object' && payload !== null && 'error' in payload)) {
      const error = normalizeErrorMessage(payload, `Swap API returned ${upstreamResponse.status}`)
      response.status(502).json({ error })
      return
    }

    if (typeof payload !== 'object' || payload === null) {
      response.status(502).json({ error: 'Swap API returned invalid payload.' })
      return
    }

    const parsedSwapResponse = swapResponseSchema.safeParse(payload)
    if (!parsedSwapResponse.success) {
      response.status(502).json({ error: 'Swap API returned invalid payload.' })
      return
    }

    const swapTransaction = parsedSwapResponse.data.swapTransaction

    let transaction: VersionedTransaction
    try {
      transaction = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'))
    } catch {
      response.status(502).json({ error: 'Swap transaction policy check failed: invalid transaction.' })
      return
    }

    const feePayer = transaction.message.staticAccountKeys[0]?.toBase58?.()
    if (!feePayer || feePayer !== userPublicKey) {
      response.status(502).json({ error: 'Swap transaction policy check failed: unexpected fee payer.' })
      return
    }

    if (transaction.message.header.numRequiredSignatures !== 1) {
      response.status(502).json({ error: 'Swap transaction policy check failed: unexpected signer set.' })
      return
    }

    if (transaction.message.compiledInstructions.length > 64) {
      response.status(502).json({ error: 'Swap transaction policy check failed: too many instructions.' })
      return
    }

    if (!transaction.message.compiledInstructions.length) {
      response.status(502).json({ error: 'Swap transaction policy check failed: no instructions.' })
      return
    }
    response.json(parsedSwapResponse.data)
  } catch {
    response.status(502).json({ error: 'Swap request failed.' })
  }
})

if (process.env.NODE_ENV === 'production') {
  const distPath = path.resolve(process.cwd(), 'dist')
  app.use(express.static(distPath, { index: false, maxAge: '1h' }))

  app.get(/^(?!\/api\/).*/, (_request: Request, response: Response) => {
    response.sendFile(path.join(distPath, 'index.html'))
  })
}

app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
  const isApiRequest = request.path.startsWith('/api/')

  if (isApiRequest) {
    const message = error instanceof Error ? error.message : 'Internal server error.'
    response.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error.' : message })
    return
  }

  response.status(500).send('Internal server error.')
})

const port = parsePositiveInt(getEnv('PORT'), 8787, 1, 65535)
app.listen(port, () => {
  console.log(`[server] Sol Squeeze API listening on http://localhost:${port}`)
})
