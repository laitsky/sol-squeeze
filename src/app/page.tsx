import { useEffect, useMemo, useRef, useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { Connection, VersionedTransaction } from '@solana/web3.js'
import { Loader2, ArrowRight, Check, Copy, ExternalLink, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'
import Navbar from '../components/Navbar'
import {
  fetchWalletTokenBalances,
  getTokenDisplayName,
  formatPrice,
  isTokenVerified,
  getVerificationLevel,
  TokenServiceError,
} from '../lib/tokenService'
import {
  buildJupiterSwapTransaction,
  getJupiterQuote,
  getMaxPriorityFeeLamports,
  SOL_MINT,
  toRawAmount,
} from '../lib/swapService'

interface TokenMetadata {
  name: string
  symbol: string
  decimals: number
  logoURI?: string
  address: string
  tags?: string[]
}

interface Token {
  mint: string
  amount: number
  metadata?: TokenMetadata | null
  price?: number | null
  isVerified?: boolean
  priceFetched?: boolean
}

type ExecutionState = 'building' | 'awaiting-signature' | 'submitted' | 'confirmed' | 'failed' | 'skipped'
type SlippagePreset = '0.5' | '1' | '3' | 'custom'
type TokenSort = 'value' | 'name' | 'verification'
type VerificationFilter = 'all' | 'unverified'
type ToastType = 'error' | 'info' | 'success'

interface ExecutionResult {
  state: ExecutionState
  message: string
  signature?: string
}

interface SellEstimate {
  totalOutLamports: bigint | null
  quotedCount: number
  failedCount: number
  skippedCount: number
  loading: boolean
  error: string | null
  lastUpdatedAt: number | null
}

interface SellSummary {
  sold: number
  failed: number
  skipped: number
}

interface ShareResultSummary {
  soldCount: number
  attemptedCount: number
  reclaimedLamportsEstimate: bigint | null
}

interface PreparedSwap {
  token: Token
  transaction: VersionedTransaction
  lastValidBlockHeight: number
}

interface ToastItem {
  id: number
  type: ToastType
  message: string
  actionLabel?: string
  onAction?: () => void
}

interface RecentActivityItem {
  id: string
  signature: string
  mint: string
  tokenLabel: string
  tokenAmount: number
  timestamp: number
}

interface ProgressEvent {
  id: number
  mint: string
  tokenLabel: string
  state: ExecutionState
  message: string
  timestamp: number
}

const VERIFICATION_PRIORITY: Record<string, number> = {
  strict: 1,
  verified: 2,
  community: 3,
  unverified: 4,
}

const SIGNING_BATCH_SIZE = 6
const ESTIMATE_QUOTE_TTL_MS = 15_000
const RECENT_ACTIVITY_STORAGE_KEY = 'sol-squeeze-recent-activity-v1'
const DEFAULT_DUST_THRESHOLD_USD = 5

function isSellableToken(token: Token): boolean {
  return token.amount > 0 && token.mint !== SOL_MINT
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function executionBadgeVariant(state: ExecutionState): 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning' | 'info' {
  if (state === 'confirmed') return 'success'
  if (state === 'failed') return 'destructive'
  if (state === 'skipped') return 'outline'
  if (state === 'submitted') return 'info'
  return 'warning'
}

function executionLabel(state: ExecutionState): string {
  if (state === 'awaiting-signature') return 'SIGN'
  return state.toUpperCase()
}

function getQuoteOutAmountRaw(quoteResponse: Record<string, unknown>): string | null {
  const outAmount = quoteResponse.outAmount
  if (typeof outAmount === 'string' && /^[0-9]+$/.test(outAmount)) {
    return outAmount
  }
  return null
}

function formatWithThousandsSeparators(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function formatLamportsAsSol(lamports: bigint, maxFractionDigits = 6): string {
  const lamportsPerSol = BigInt(1_000_000_000)
  const wholePart = lamports / lamportsPerSol
  const wholePartFormatted = formatWithThousandsSeparators(wholePart.toString())
  if (maxFractionDigits <= 0) {
    return wholePartFormatted
  }

  const fractionDigits = (lamports % lamportsPerSol)
    .toString()
    .padStart(9, '0')
    .slice(0, maxFractionDigits)
    .replace(/0+$/, '')

  return fractionDigits ? `${wholePartFormatted}.${fractionDigits}` : wholePartFormatted
}

function formatSolEstimate(totalOutLamports: bigint | null): string {
  if (totalOutLamports === null) return '--'
  if (totalOutLamports <= BigInt(0)) return '0'
  if (totalOutLamports < BigInt(1_000)) return '<0.000001'
  return formatLamportsAsSol(totalOutLamports, 6)
}

function formatQuoteAgeLabel(lastUpdatedAt: number | null, nowMs: number): string {
  if (!lastUpdatedAt) return 'quote not ready'
  const ageSec = Math.max(0, Math.floor((nowMs - lastUpdatedAt) / 1000))
  const ttlLeftSec = Math.max(0, Math.ceil((ESTIMATE_QUOTE_TTL_MS - (nowMs - lastUpdatedAt)) / 1000))
  return `age ${ageSec}s • cache ${ttlLeftSec}s`
}

function formatTimeAgo(timestamp: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - timestamp) / 1000))
  if (seconds < 60) {
    return `${seconds}s ago`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h ago`
  }
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatShareReclaimedLabel(lamportsEstimate: bigint | null): string {
  if (lamportsEstimate === null || lamportsEstimate <= BigInt(0)) return 'extra SOL'
  if (lamportsEstimate < BigInt(1_000)) return '<0.000001 SOL'
  return `${formatLamportsAsSol(lamportsEstimate, 3)} SOL`
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return []

  const results = new Array<R>(items.length)
  let currentIndex = 0
  const workerCount = Math.max(1, Math.min(concurrency, items.length))

  const workers = Array.from({ length: workerCount }, async () => {
    while (currentIndex < items.length) {
      const index = currentIndex
      currentIndex += 1
      results[index] = await mapper(items[index])
    }
  })

  await Promise.all(workers)
  return results
}

function truncateAddress(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`
}

function tokenValueUsd(token: Token): number | null {
  if (typeof token.price === 'number' && Number.isFinite(token.price) && token.amount > 0) {
    return token.price * token.amount
  }
  return null
}

function tokenLabel(token: Token): string {
  const symbol = token.metadata?.symbol?.trim()
  if (symbol) return symbol

  const name = token.metadata?.name?.trim()
  if (name) return name

  return truncateAddress(token.mint)
}

function hasNoRouteError(message: string): boolean {
  return /no route|not enough liquidity|could not find any route|token not tradable|route not found/i.test(message)
}

function quoteFailureMessage(token: Token, error: unknown): string {
  const label = tokenLabel(token)
  const message = errorMessage(error)
  if (hasNoRouteError(message)) {
    return `No route found for ${label} - low liquidity.`
  }
  return `Quote failed for ${label}: ${message}`
}

function swapFailureMessage(token: Token, error: unknown): string {
  return `Swap failed for ${tokenLabel(token)}: ${errorMessage(error)}`
}

function slippagePresetBps(preset: Exclude<SlippagePreset, 'custom'>): number {
  if (preset === '0.5') return 50
  if (preset === '3') return 300
  return 100
}

function parseSlippageBps(customSlippage: string): number {
  const parsed = Number(customSlippage)
  if (!Number.isFinite(parsed)) return 100
  const boundedPercent = Math.max(0.1, Math.min(parsed, 50))
  return Math.round(boundedPercent * 100)
}

function formatSlippageBps(slippageBps: number): string {
  const percent = slippageBps / 100
  const hasOneDecimal = Number.isInteger(percent * 10)
  if (Number.isInteger(percent)) {
    return `${percent.toFixed(0)}%`
  }
  if (hasOneDecimal) {
    return `${percent.toFixed(1)}%`
  }
  return `${percent.toFixed(2)}%`
}

function sortTokens(tokens: Token[], sortBy: TokenSort): Token[] {
  return [...tokens].sort((a, b) => {
    const aLevel = getVerificationLevel(a.metadata || null)
    const bLevel = getVerificationLevel(b.metadata || null)
    const aPriority = VERIFICATION_PRIORITY[aLevel] ?? 4
    const bPriority = VERIFICATION_PRIORITY[bLevel] ?? 4

    if (aPriority !== bPriority) {
      return aPriority - bPriority
    }

    if (sortBy === 'name') {
      const aName = (a.metadata?.symbol || a.metadata?.name || a.mint).toLowerCase()
      const bName = (b.metadata?.symbol || b.metadata?.name || b.mint).toLowerCase()
      return aName.localeCompare(bName)
    }

    if (sortBy === 'value') {
      const aValue = tokenValueUsd(a)
      const bValue = tokenValueUsd(b)

      if (aValue !== null && bValue !== null) {
        return bValue - aValue
      }
      if (aValue !== null) return -1
      if (bValue !== null) return 1
      return (b.amount || 0) - (a.amount || 0)
    }

    const aValue = tokenValueUsd(a)
    const bValue = tokenValueUsd(b)
    if (aValue !== null && bValue !== null) {
      return bValue - aValue
    }

    const aName = (a.metadata?.symbol || a.metadata?.name || a.mint).toLowerCase()
    const bName = (b.metadata?.symbol || b.metadata?.name || b.mint).toLowerCase()
    return aName.localeCompare(bName)
  })
}

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  if (items.length === 0) return []

  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize))
  }
  return chunks
}

export function Home() {
  const { publicKey, connected, sendTransaction, signAllTransactions, wallet } = useWallet()
  const { setVisible: setWalletModalVisible } = useWalletModal()

  const [tokens, setTokens] = useState<Token[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [selectedMints, setSelectedMints] = useState<Set<string>>(new Set())
  const [isSelling, setIsSelling] = useState(false)
  const [isConfirmModalOpen, setIsConfirmModalOpen] = useState(false)
  const [sellResults, setSellResults] = useState<Record<string, ExecutionResult>>({})
  const [sellSummary, setSellSummary] = useState<SellSummary | null>(null)
  const [globalError, setGlobalError] = useState<string | null>(null)
  const [dustThresholdUsdInput, setDustThresholdUsdInput] = useState(String(DEFAULT_DUST_THRESHOLD_USD))
  const [activeSellTargetCount, setActiveSellTargetCount] = useState(0)
  const [currentRunMints, setCurrentRunMints] = useState<Set<string>>(new Set())
  const [estimateRefreshNonce, setEstimateRefreshNonce] = useState(0)
  const [nowMs, setNowMs] = useState(Date.now())

  const [slippagePreset, setSlippagePreset] = useState<SlippagePreset>('1')
  const [customSlippagePercent, setCustomSlippagePercent] = useState('1')

  const [searchQuery, setSearchQuery] = useState('')
  const [verificationFilter, setVerificationFilter] = useState<VerificationFilter>('all')
  const [sortBy, setSortBy] = useState<TokenSort>('verification')

  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [recentActivity, setRecentActivity] = useState<RecentActivityItem[]>([])
  const [progressEvents, setProgressEvents] = useState<ProgressEvent[]>([])
  const [shareResultSummary, setShareResultSummary] = useState<ShareResultSummary | null>(null)
  const [shareCaptionCopied, setShareCaptionCopied] = useState(false)
  const [hasHydratedStorage, setHasHydratedStorage] = useState(false)

  const dustThresholdUsd = useMemo(() => {
    const parsed = Number(dustThresholdUsdInput)
    if (!Number.isFinite(parsed)) return 0
    return Math.max(0, parsed)
  }, [dustThresholdUsdInput])

  const [sellEstimate, setSellEstimate] = useState<SellEstimate>({
    totalOutLamports: null,
    quotedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    loading: false,
    error: null,
    lastUpdatedAt: null,
  })

  const fetchControllerRef = useRef<AbortController | null>(null)
  const toastCounterRef = useRef(0)
  const progressCounterRef = useRef(0)
  const estimateForceRefreshRef = useRef(false)
  const walletConnectedRef = useRef(connected)
  const walletAddressRef = useRef(publicKey?.toBase58() || null)
  const shareCopiedResetTimerRef = useRef<number | null>(null)

  useEffect(() => {
    walletConnectedRef.current = connected
    walletAddressRef.current = publicKey?.toBase58() || null
  }, [connected, publicKey])

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNowMs(Date.now())
    }, 1000)

    return () => {
      window.clearInterval(interval)
    }
  }, [])

  useEffect(() => {
    try {
      const storedActivity = localStorage.getItem(RECENT_ACTIVITY_STORAGE_KEY)
      if (storedActivity) {
        const parsed = JSON.parse(storedActivity) as RecentActivityItem[]
        if (Array.isArray(parsed)) {
          setRecentActivity(parsed.filter(item => item && typeof item.signature === 'string').slice(0, 30))
        }
      }
    } catch {
      setRecentActivity([])
    }

    setHasHydratedStorage(true)
  }, [])

  useEffect(() => {
    if (!hasHydratedStorage) return
    localStorage.setItem(RECENT_ACTIVITY_STORAGE_KEY, JSON.stringify(recentActivity))
  }, [recentActivity, hasHydratedStorage])

  useEffect(() => {
    return () => {
      if (shareCopiedResetTimerRef.current !== null) {
        window.clearTimeout(shareCopiedResetTimerRef.current)
      }
    }
  }, [])

  function removeToast(id: number) {
    setToasts(prev => prev.filter(toast => toast.id !== id))
  }

  function pushToast(type: ToastType, message: string, action?: { label: string; onClick: () => void }) {
    const id = toastCounterRef.current
    toastCounterRef.current += 1

    setToasts(prev => [
      ...prev,
      {
        id,
        type,
        message,
        actionLabel: action?.label,
        onAction: action?.onClick,
      },
    ])

    setTimeout(() => {
      removeToast(id)
    }, 7000)
  }

  function appendProgressEvent(mint: string, state: ExecutionState, message: string) {
    const token = tokens.find(item => item.mint === mint)
    const entry: ProgressEvent = {
      id: progressCounterRef.current,
      mint,
      tokenLabel: token ? tokenLabel(token) : truncateAddress(mint),
      state,
      message,
      timestamp: Date.now(),
    }

    progressCounterRef.current += 1
    setProgressEvents(prev => [...prev, entry].slice(-40))
  }

  function appendBatchProgressEvent(message: string) {
    const entry: ProgressEvent = {
      id: progressCounterRef.current,
      mint: 'batch',
      tokenLabel: 'Batch',
      state: 'building',
      message,
      timestamp: Date.now(),
    }

    progressCounterRef.current += 1
    setProgressEvents(prev => [...prev, entry].slice(-40))
  }

  function addRecentActivity(entry: Omit<RecentActivityItem, 'id' | 'timestamp'>) {
    setRecentActivity(prev => {
      const next: RecentActivityItem[] = [
        {
          ...entry,
          id: `${entry.signature}-${Date.now()}`,
          timestamp: Date.now(),
        },
        ...prev.filter(item => item.signature !== entry.signature),
      ]

      return next.slice(0, 20)
    })
  }

  const effectiveSlippageBps = useMemo(
    () => (slippagePreset === 'custom' ? parseSlippageBps(customSlippagePercent) : slippagePresetBps(slippagePreset)),
    [slippagePreset, customSlippagePercent]
  )

  useEffect(() => {
    if (connected && publicKey) {
      fetchTokens(publicKey.toBase58())
    } else {
      fetchControllerRef.current?.abort()
      setTokens([])
      setSelectedMints(new Set())
      setSellResults({})
      setSellSummary(null)
      setGlobalError(null)
      setIsConfirmModalOpen(false)
      setCurrentRunMints(new Set())
    }
  }, [connected, publicKey])

  useEffect(() => {
    setSelectedMints(prevSelected => {
      const tokenMints = new Set(tokens.filter(isSellableToken).map(token => token.mint))
      const nextSelected = new Set(Array.from(prevSelected).filter(mint => tokenMints.has(mint)))
      return nextSelected
    })
  }, [tokens])

  const sellableTokens = useMemo(() => tokens.filter(isSellableToken), [tokens])

  const visibleTokens = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase()

    const filteredTokens = tokens.filter(token => {
      if (verificationFilter === 'unverified' && getVerificationLevel(token.metadata || null) !== 'unverified') {
        return false
      }

      if (!normalizedQuery) {
        return true
      }

      const searchParts = [
        token.metadata?.name || '',
        token.metadata?.symbol || '',
        token.mint,
      ]

      return searchParts.some(part => part.toLowerCase().includes(normalizedQuery))
    })

    return sortTokens(filteredTokens, sortBy)
  }, [tokens, searchQuery, verificationFilter, sortBy])

  const visibleSellableTokens = useMemo(
    () => visibleTokens.filter(isSellableToken),
    [visibleTokens]
  )

  const totalPortfolioValue = useMemo(() => {
    return tokens.reduce((total, token) => {
      if (token.price && token.amount) {
        return total + token.price * token.amount
      }
      return total
    }, 0)
  }, [tokens])

  const selectedTokensForSell = useMemo(
    () => tokens.filter(token => selectedMints.has(token.mint) && isSellableToken(token)),
    [tokens, selectedMints]
  )

  const selectedSellableCount = selectedTokensForSell.length

  const currentRunResultCount = useMemo(
    () => Object.entries(sellResults).filter(([mint]) => currentRunMints.has(mint)).length,
    [sellResults, currentRunMints]
  )

  const sellProgress = useMemo(() => {
    if (!isSelling || activeSellTargetCount === 0) return 0
    return (currentRunResultCount / activeSellTargetCount) * 100
  }, [isSelling, currentRunResultCount, activeSellTargetCount])

  const completedSellCount = useMemo(() => {
    return Object.entries(sellResults).filter(([mint, result]) => (
      currentRunMints.has(mint) && (result.state === 'confirmed' || result.state === 'failed' || result.state === 'skipped')
    )).length
  }, [sellResults, currentRunMints])

  const activeExecutionEntry = useMemo(() => {
    const entries = Object.entries(sellResults).filter(([mint]) => currentRunMints.has(mint))
    for (const [mint, result] of entries) {
      if (result.state === 'awaiting-signature') {
        const token = tokens.find(item => item.mint === mint)
        return {
          tokenLabel: token ? tokenLabel(token) : truncateAddress(mint),
          state: result.state,
        }
      }
    }
    for (const [mint, result] of entries) {
      if (result.state === 'building' || result.state === 'submitted') {
        const token = tokens.find(item => item.mint === mint)
        return {
          tokenLabel: token ? tokenLabel(token) : truncateAddress(mint),
          state: result.state,
        }
      }
    }
    return null
  }, [sellResults, tokens, currentRunMints])

  const maxPriorityFeeLamports = useMemo(() => BigInt(getMaxPriorityFeeLamports()), [])

  const estimatedFeeLamports = useMemo(() => {
    if (selectedSellableCount === 0) return null
    const baseNetworkFeeLamports = BigInt(5_000)
    return BigInt(selectedSellableCount) * (baseNetworkFeeLamports + maxPriorityFeeLamports)
  }, [selectedSellableCount, maxPriorityFeeLamports])

  const isBatchSigningSupported = typeof signAllTransactions === 'function'

  const estimatedSignaturePrompts = useMemo(() => {
    if (selectedSellableCount === 0) return 0
    if (!isBatchSigningSupported) return selectedSellableCount
    return Math.ceil(selectedSellableCount / SIGNING_BATCH_SIZE)
  }, [isBatchSigningSupported, selectedSellableCount])

  const quoteAgeLabel = useMemo(
    () => formatQuoteAgeLabel(sellEstimate.lastUpdatedAt, nowMs),
    [sellEstimate.lastUpdatedAt, nowMs]
  )

  const recentProgressEvents = useMemo(
    () => [...progressEvents].reverse().slice(0, 8),
    [progressEvents]
  )

  const shareReclaimedLabel = useMemo(
    () => formatShareReclaimedLabel(shareResultSummary?.reclaimedLamportsEstimate ?? null),
    [shareResultSummary]
  )

  const shareCaption = useMemo(() => {
    if (!shareResultSummary) return ''
    const tokenLabel = shareResultSummary.soldCount === 1 ? 'dust token' : 'dust tokens'
    return `I just reclaimed ${shareReclaimedLabel} from ${shareResultSummary.soldCount} ${tokenLabel} with Sol Squeeze.`
  }, [shareResultSummary, shareReclaimedLabel])

  const shareIntentUrl = useMemo(() => {
    if (!shareCaption) return null
    const appUrl = typeof window !== 'undefined' ? window.location.origin : 'https://solsqueeze.app'
    const text = encodeURIComponent(shareCaption)
    const url = encodeURIComponent(appUrl)
    return `https://twitter.com/intent/tweet?text=${text}&url=${url}`
  }, [shareCaption])

  useEffect(() => {
    if (!connected || isSelling || selectedSellableCount === 0) {
      setSellEstimate({
        totalOutLamports: null,
        quotedCount: 0,
        failedCount: 0,
        skippedCount: 0,
        loading: false,
        error: null,
        lastUpdatedAt: null,
      })
      return
    }

    const selectedTokens = selectedTokensForSell
    if (selectedTokens.length === 0) {
      setSellEstimate({
        totalOutLamports: null,
        quotedCount: 0,
        failedCount: 0,
        skippedCount: 0,
        loading: false,
        error: null,
        lastUpdatedAt: null,
      })
      return
    }

    const ESTIMATE_MAX_TOKENS = 25
    const ESTIMATE_CONCURRENCY = 6
    const estimateTokens = selectedTokens.slice(0, ESTIMATE_MAX_TOKENS)
    const skippedCount = Math.max(0, selectedTokens.length - estimateTokens.length)
    const forceRefresh = estimateForceRefreshRef.current
    estimateForceRefreshRef.current = false

    const controller = new AbortController()
    const timeoutId = setTimeout(async () => {
      setSellEstimate(prev => ({
        ...prev,
        loading: true,
        error: null,
      }))

      const estimateResults = await mapWithConcurrency(
        estimateTokens,
        ESTIMATE_CONCURRENCY,
        async (token) => {
          if (controller.signal.aborted) {
            return { outLamports: BigInt(0), quoted: false, failed: true }
          }

          const decimals = token.metadata?.decimals ?? 0
          const rawAmount = toRawAmount(token.amount, decimals)

          if (rawAmount === '0') {
            return { outLamports: BigInt(0), quoted: false, failed: true }
          }

          try {
            const quoteResponse = await getJupiterQuote({
              inputMint: token.mint,
              outputMint: SOL_MINT,
              amount: rawAmount,
              slippageBps: effectiveSlippageBps,
              forceRefresh,
              signal: controller.signal,
            })

            const outAmountRaw = getQuoteOutAmountRaw(quoteResponse)
            if (!outAmountRaw) {
              return { outLamports: BigInt(0), quoted: false, failed: true }
            }

            return { outLamports: BigInt(outAmountRaw), quoted: true, failed: false }
          } catch {
            return { outLamports: BigInt(0), quoted: false, failed: true }
          }
        }
      )

      if (controller.signal.aborted) return

      let totalOutLamports = BigInt(0)
      let quotedCount = 0
      let failedCount = 0
      for (const result of estimateResults) {
        totalOutLamports += result.outLamports
        if (result.quoted) quotedCount += 1
        if (result.failed) failedCount += 1
      }

      setSellEstimate({
        totalOutLamports,
        quotedCount,
        failedCount,
        skippedCount,
        loading: false,
        error: quotedCount === 0 ? 'No quotes available.' : null,
        lastUpdatedAt: Date.now(),
      })
    }, 400)

    return () => {
      controller.abort()
      clearTimeout(timeoutId)
    }
  }, [connected, isSelling, selectedTokensForSell, selectedSellableCount, effectiveSlippageBps, estimateRefreshNonce])

  async function fetchTokens(walletAddress: string) {
    fetchControllerRef.current?.abort()
    const controller = new AbortController()
    fetchControllerRef.current = controller

    setGlobalError(null)
    setLoading(true)
    setLoadingMore(false)

    try {
      const fetchedTokens: Token[] = await fetchWalletTokenBalances(walletAddress, {
        signal: controller.signal,
        onFirstPage: (firstPageTokens) => {
          if (controller.signal.aborted) return
          const walletTokens = firstPageTokens.map(token => ({
            ...token,
            isVerified: isTokenVerified(token.metadata || null),
          }))
          setTokens(sortTokens(walletTokens, 'verification'))
          setLoading(false)
          setLoadingMore(true)
        },
      })

      if (controller.signal.aborted) return

      const walletTokens = fetchedTokens.map(token => ({
        ...token,
        isVerified: isTokenVerified(token.metadata || null),
      }))

      setTokens(sortTokens(walletTokens, 'verification'))
      setGlobalError(null)
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof TokenServiceError) {
          setGlobalError(error.message)
        } else {
          setGlobalError('Unable to fetch wallet tokens right now. Please retry.')
        }
        setTokens([])
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }

  function updateSellResult(mint: string, result: ExecutionResult, logProgress = true) {
    setSellResults(prev => ({
      ...prev,
      [mint]: result,
    }))
    if (logProgress) {
      appendProgressEvent(mint, result.state, result.message)
    }
  }

  function toggleMintSelection(mint: string) {
    setSelectedMints(prevSelected => {
      const nextSelected = new Set(prevSelected)
      if (nextSelected.has(mint)) {
        nextSelected.delete(mint)
      } else {
        nextSelected.add(mint)
      }
      return nextSelected
    })
  }

  function selectAllSellable() {
    const visibleMints = visibleSellableTokens.map(token => token.mint)
    setSelectedMints(new Set(visibleMints))
  }

  function clearSelection() {
    setSelectedMints(new Set())
  }

  function autoSelectDustTokens() {
    const threshold = Math.max(0, dustThresholdUsd)
    const dustMints = visibleSellableTokens
      .filter(token => {
        const usdValue = tokenValueUsd(token)
        return usdValue !== null && usdValue <= threshold
      })
      .map(token => token.mint)

    setSelectedMints(new Set(dustMints))
  }

  function refreshEstimate() {
    if (selectedSellableCount === 0 || sellEstimate.loading || isSelling) return
    estimateForceRefreshRef.current = true
    setEstimateRefreshNonce(prev => prev + 1)
  }

  async function copyShareCaption() {
    if (!shareCaption) return
    try {
      await navigator.clipboard.writeText(shareCaption)
      setShareCaptionCopied(true)
      if (shareCopiedResetTimerRef.current !== null) {
        window.clearTimeout(shareCopiedResetTimerRef.current)
      }
      shareCopiedResetTimerRef.current = window.setTimeout(() => {
        setShareCaptionCopied(false)
      }, 2200)
      pushToast('success', 'Share caption copied.')
    } catch {
      pushToast('error', 'Unable to copy caption. Copy manually.')
    }
  }

  async function executeSellRun(targetTokens: Token[], options: { resetResults: boolean; resetSummary: boolean }) {
    if (!connected || !publicKey || isSelling) {
      return
    }

    const rpcUrl = import.meta.env.VITE_SOLANA_RPC_URL
    if (!rpcUrl) {
      setSellSummary(null)
      setGlobalError('RPC URL not configured. Set VITE_SOLANA_RPC_URL and reconnect your wallet.')
      pushToast('error', 'RPC URL not configured. Set VITE_SOLANA_RPC_URL and reconnect your wallet.')
      return
    }

    if (targetTokens.length === 0) {
      return
    }

    const ownerAddress = publicKey.toBase58()
    const connection = new Connection(rpcUrl, 'confirmed')
    const soldMints = new Set<string>()
    const runTargetCount = targetTokens.filter(isSellableToken).length
    const runEstimateSnapshot = options.resetSummary ? sellEstimate.totalOutLamports : null
    let succeeded = 0
    let failed = 0
    let skipped = 0
    let disconnectionHandled = false

    const isWalletSessionValid = () => {
      return Boolean(walletConnectedRef.current) && walletAddressRef.current === ownerAddress
    }

    const markFailedForTokens = (tokensToMark: Token[], message: string) => {
      for (const token of tokensToMark) {
        updateSellResult(token.mint, { state: 'failed', message })
      }
      failed += tokensToMark.length
    }

    const handleWalletDisconnection = (remainingTokens: Token[]) => {
      if (disconnectionHandled) return
      disconnectionHandled = true
      const message = 'Wallet disconnected mid-batch. Reconnect wallet and retry failed tokens.'
      markFailedForTokens(remainingTokens, message)
      pushToast('error', `Wallet disconnected during batch on ${wallet?.adapter.name || 'wallet'}.`)
    }

    setIsSelling(true)
    setActiveSellTargetCount(targetTokens.filter(isSellableToken).length)
    setCurrentRunMints(new Set(targetTokens.map(token => token.mint)))
    setGlobalError(null)
    if (options.resetSummary) {
      setSellSummary(null)
      setShareResultSummary(null)
      setShareCaptionCopied(false)
    }
    if (options.resetResults) {
      setSellResults({})
      setProgressEvents([])
      progressCounterRef.current = 0
    }
    appendBatchProgressEvent(`Started batch for ${targetTokens.length} token${targetTokens.length > 1 ? 's' : ''}.`)

    try {
      const preparedSwaps: PreparedSwap[] = []

      for (let index = 0; index < targetTokens.length; index += 1) {
        const token = targetTokens[index]

        if (!isWalletSessionValid()) {
          handleWalletDisconnection(targetTokens.slice(index))
          break
        }

        if (!isSellableToken(token)) {
          skipped += 1
          updateSellResult(token.mint, { state: 'skipped', message: 'Not sellable.' })
          continue
        }

        const decimals = token.metadata?.decimals ?? 0
        const rawAmount = toRawAmount(token.amount, decimals)

        if (rawAmount === '0') {
          skipped += 1
          updateSellResult(token.mint, { state: 'skipped', message: 'Balance too small.' })
          continue
        }

        try {
          updateSellResult(token.mint, { state: 'building', message: 'Routing...' })

          let quoteResponse: Record<string, unknown>
          try {
            quoteResponse = await getJupiterQuote({
              inputMint: token.mint,
              outputMint: SOL_MINT,
              amount: rawAmount,
              slippageBps: effectiveSlippageBps,
            })
          } catch (error) {
            const message = quoteFailureMessage(token, error)
            failed += 1
            updateSellResult(token.mint, { state: 'failed', message })
            pushToast('error', message, {
              label: 'Retry',
              onClick: () => {
                void retryToken(token.mint)
              },
            })
            continue
          }

          try {
            const { transaction, lastValidBlockHeight } = await buildJupiterSwapTransaction({
              quoteResponse,
              userPublicKey: ownerAddress,
            })

            preparedSwaps.push({
              token,
              transaction,
              lastValidBlockHeight,
            })
          } catch (error) {
            const message = `Swap build failed for ${tokenLabel(token)}: ${errorMessage(error)}`
            failed += 1
            updateSellResult(token.mint, { state: 'failed', message })
            pushToast('error', message, {
              label: 'Retry',
              onClick: () => {
                void retryToken(token.mint)
              },
            })
          }
        } catch (error) {
          const message = swapFailureMessage(token, error)
          failed += 1
          updateSellResult(token.mint, { state: 'failed', message })
          pushToast('error', message, {
            label: 'Retry',
            onClick: () => {
              void retryToken(token.mint)
            },
          })
        }
      }

      if (!disconnectionHandled && preparedSwaps.length > 0) {
        if (isBatchSigningSupported && signAllTransactions && preparedSwaps.length > 1) {
          const batches = chunkArray(preparedSwaps, SIGNING_BATCH_SIZE)

          for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
            const batch = batches[batchIndex]
            if (!isWalletSessionValid()) {
              const remaining = batches.slice(batchIndex).flat().map(item => item.token)
              handleWalletDisconnection(remaining)
              break
            }

            for (const preparedSwap of batch) {
              updateSellResult(preparedSwap.token.mint, {
                state: 'awaiting-signature',
                message: `Signature batch ${batchIndex + 1}/${batches.length}.`,
              })
            }

            let signedTransactions: VersionedTransaction[]
            try {
              const signed = await signAllTransactions(batch.map(item => item.transaction))
              signedTransactions = signed as VersionedTransaction[]
            } catch (error) {
              const message = `Signature request rejected for batch ${batchIndex + 1}.`
              markFailedForTokens(batch.map(item => item.token), message)
              pushToast('error', message)
              continue
            }

            for (let txIndex = 0; txIndex < batch.length; txIndex += 1) {
              const preparedSwap = batch[txIndex]
              const signedTransaction = signedTransactions[txIndex]

              if (!signedTransaction) {
                failed += 1
                updateSellResult(preparedSwap.token.mint, {
                  state: 'failed',
                  message: 'Wallet returned an invalid signed transaction.',
                })
                pushToast('error', `Swap failed for ${tokenLabel(preparedSwap.token)}: invalid signed transaction.`)
                continue
              }

              try {
                const signature = await connection.sendRawTransaction(signedTransaction.serialize(), {
                  skipPreflight: false,
                  maxRetries: 3,
                  preflightCommitment: 'confirmed',
                })

                updateSellResult(preparedSwap.token.mint, {
                  state: 'submitted',
                  signature,
                  message: 'Confirming...',
                })

                const confirmation = await connection.confirmTransaction(
                  {
                    signature,
                    blockhash: preparedSwap.transaction.message.recentBlockhash,
                    lastValidBlockHeight: preparedSwap.lastValidBlockHeight,
                  },
                  'confirmed'
                )

                if (confirmation.value.err) {
                  throw new Error(`On-chain error: ${JSON.stringify(confirmation.value.err)}`)
                }

                succeeded += 1
                soldMints.add(preparedSwap.token.mint)
                updateSellResult(preparedSwap.token.mint, {
                  state: 'confirmed',
                  signature,
                  message: 'Done.',
                })
                addRecentActivity({
                  signature,
                  mint: preparedSwap.token.mint,
                  tokenLabel: tokenLabel(preparedSwap.token),
                  tokenAmount: preparedSwap.token.amount,
                })
              } catch (error) {
                failed += 1
                const message = swapFailureMessage(preparedSwap.token, error)
                updateSellResult(preparedSwap.token.mint, { state: 'failed', message })
                pushToast('error', message, {
                  label: 'Retry',
                  onClick: () => {
                    void retryToken(preparedSwap.token.mint)
                  },
                })
              }
            }
          }
        } else {
          for (let index = 0; index < preparedSwaps.length; index += 1) {
            const preparedSwap = preparedSwaps[index]

            if (!isWalletSessionValid()) {
              const remaining = preparedSwaps.slice(index).map(item => item.token)
              handleWalletDisconnection(remaining)
              break
            }

            try {
              updateSellResult(preparedSwap.token.mint, { state: 'awaiting-signature', message: 'Sign in wallet.' })

              const signature = await sendTransaction(preparedSwap.transaction, connection, {
                skipPreflight: false,
                maxRetries: 3,
                preflightCommitment: 'confirmed',
              })

              updateSellResult(preparedSwap.token.mint, { state: 'submitted', signature, message: 'Confirming...' })

              const confirmation = await connection.confirmTransaction(
                {
                  signature,
                  blockhash: preparedSwap.transaction.message.recentBlockhash,
                  lastValidBlockHeight: preparedSwap.lastValidBlockHeight,
                },
                'confirmed'
              )

              if (confirmation.value.err) {
                throw new Error(`On-chain error: ${JSON.stringify(confirmation.value.err)}`)
              }

              succeeded += 1
              soldMints.add(preparedSwap.token.mint)
              updateSellResult(preparedSwap.token.mint, { state: 'confirmed', signature, message: 'Done.' })
              addRecentActivity({
                signature,
                mint: preparedSwap.token.mint,
                tokenLabel: tokenLabel(preparedSwap.token),
                tokenAmount: preparedSwap.token.amount,
              })
            } catch (error) {
              failed += 1
              const message = swapFailureMessage(preparedSwap.token, error)
              updateSellResult(preparedSwap.token.mint, { state: 'failed', message })
              pushToast('error', message, {
                label: 'Retry',
                onClick: () => {
                  void retryToken(preparedSwap.token.mint)
                },
              })
            }
          }
        }
      }

      if (options.resetSummary) {
        setSellSummary({ sold: succeeded, failed, skipped })
      }

      appendBatchProgressEvent(`Finished: ${succeeded} confirmed, ${failed} failed, ${skipped} skipped.`)

      if (succeeded > 0) {
        const reclaimedLamportsEstimate = runEstimateSnapshot !== null && runTargetCount > 0
          ? (runEstimateSnapshot * BigInt(succeeded)) / BigInt(runTargetCount)
          : null
        setShareResultSummary({
          soldCount: succeeded,
          attemptedCount: runTargetCount,
          reclaimedLamportsEstimate,
        })
        setShareCaptionCopied(false)
        pushToast('success', `Confirmed ${succeeded} swap${succeeded > 1 ? 's' : ''}.`)
      }

      if (soldMints.size > 0) {
        setSelectedMints(prevSelected => {
          const nextSelected = new Set(prevSelected)
          soldMints.forEach(mint => nextSelected.delete(mint))
          return nextSelected
        })

        await fetchTokens(ownerAddress)
      }
    } finally {
      setIsSelling(false)
      setActiveSellTargetCount(0)
      setCurrentRunMints(new Set())
    }
  }

  async function sellSelectedTokens() {
    if (selectedSellableCount === 0) {
      return
    }

    setIsConfirmModalOpen(true)
  }

  async function confirmSellSelectedTokens() {
    setIsConfirmModalOpen(false)
    await executeSellRun(selectedTokensForSell, {
      resetResults: true,
      resetSummary: true,
    })
  }

  async function retryToken(mint: string) {
    if (isSelling) {
      return
    }

    const token = tokens.find(item => item.mint === mint)
    if (!token) {
      pushToast('error', 'Token was not found in current wallet state. Refresh and retry.')
      return
    }

    updateSellResult(mint, { state: 'building', message: 'Retrying...' })

    await executeSellRun([token], {
      resetResults: false,
      resetSummary: false,
    })
  }

  return (
    <>
      <Navbar />

      <div className="fixed right-4 top-14 z-[120] flex w-[min(92vw,420px)] flex-col gap-2">
        {toasts.map(toast => (
          <div
            key={toast.id}
            className={cn(
              'border px-3 py-2.5 bg-card/95 backdrop-blur-sm flex items-start gap-2.5',
              toast.type === 'error' && 'border-[hsl(var(--status-error))]/60',
              toast.type === 'success' && 'border-[hsl(var(--status-success))]/50',
              toast.type === 'info' && 'border-border'
            )}
          >
            <div className="min-w-0 flex-1 font-mono text-[11px] leading-relaxed text-foreground/90">
              {toast.message}
            </div>
            <div className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider">
              {toast.actionLabel && toast.onAction && (
                <button
                  type="button"
                  onClick={() => {
                    toast.onAction?.()
                    removeToast(toast.id)
                  }}
                  className="px-1.5 py-1 border border-border hover:bg-accent transition-colors"
                >
                  {toast.actionLabel}
                </button>
              )}
              <button
                type="button"
                onClick={() => removeToast(toast.id)}
                className="px-1.5 py-1 border border-border hover:bg-accent transition-colors"
              >
                dismiss
              </button>
            </div>
          </div>
        ))}
      </div>

      {isConfirmModalOpen && (
        <div
          className="fixed inset-0 z-[140] bg-black/55 backdrop-blur-[2px] flex items-center justify-center p-4"
          onClick={() => setIsConfirmModalOpen(false)}
        >
          <div className="w-full max-w-md border border-border bg-background p-4 font-mono" onClick={(e) => e.stopPropagation()}>
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Confirm sell</div>
            <div className="text-sm leading-relaxed text-foreground">
              You&apos;re selling {selectedSellableCount} token{selectedSellableCount > 1 ? 's' : ''} for
              {' '}~{formatSolEstimate(sellEstimate.totalOutLamports)} SOL.
              {' '}Priority fees: ~{estimatedFeeLamports ? formatLamportsAsSol(estimatedFeeLamports, 6) : '--'} SOL.
              {' '}Proceed?
            </div>
            <div className="mt-4 text-[11px] text-muted-foreground">
              Slippage: {formatSlippageBps(effectiveSlippageBps)}. Quotes: {quoteAgeLabel}.
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsConfirmModalOpen(false)}
                disabled={isSelling}
                className="h-8 px-3 border border-border text-[11px] uppercase tracking-wider hover:bg-accent transition-colors disabled:opacity-40"
              >
                cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void confirmSellSelectedTokens()
                }}
                disabled={isSelling || selectedSellableCount === 0}
                className="h-8 px-3 bg-foreground text-background text-[11px] uppercase tracking-wider hover:opacity-85 transition-opacity disabled:opacity-30"
              >
                proceed
              </button>
            </div>
          </div>
        </div>
      )}

      <main className="min-h-screen">
        {connected ? (
          <div
            className="max-w-[1000px] mx-auto px-6"
            style={{ animation: 'fadeIn 0.3s ease-out' }}
          >

            <div className="py-6 border-b border-border">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 font-mono">
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5">
                    Tokens
                  </div>
                  <div className="text-lg tabular-nums leading-none">
                    {loading ? (
                      <span className="inline-block w-8 h-5 bg-muted-foreground/10" style={{ animation: 'shimmer 1.5s infinite linear', backgroundSize: '200% 100%', backgroundImage: 'linear-gradient(90deg, transparent 0%, hsl(var(--muted-foreground) / 0.08) 50%, transparent 100%)' }} />
                    ) : tokens.length}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5">
                    Sellable
                  </div>
                  <div className="text-lg tabular-nums leading-none">
                    {loading ? (
                      <span className="inline-block w-8 h-5 bg-muted-foreground/10" style={{ animation: 'shimmer 1.5s infinite linear', backgroundSize: '200% 100%', backgroundImage: 'linear-gradient(90deg, transparent 0%, hsl(var(--muted-foreground) / 0.08) 50%, transparent 100%)' }} />
                    ) : sellableTokens.length}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5">
                    Portfolio
                  </div>
                  <div className="text-lg tabular-nums leading-none">
                    {loading ? (
                      <span className="inline-block w-16 h-5 bg-muted-foreground/10" style={{ animation: 'shimmer 1.5s infinite linear', backgroundSize: '200% 100%', backgroundImage: 'linear-gradient(90deg, transparent 0%, hsl(var(--muted-foreground) / 0.08) 50%, transparent 100%)' }} />
                    ) : totalPortfolioValue > 0 ? formatPrice(totalPortfolioValue) : '$0.00'}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5">
                    {selectedSellableCount > 0 ? 'Est. Output' : 'Selected'}
                  </div>
                  <div className="text-lg tabular-nums leading-none">
                    {selectedSellableCount > 0 ? (
                      sellEstimate.loading ? (
                        <span className="text-muted-foreground flex items-center gap-2">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        </span>
                      ) : (
                        <span>{formatSolEstimate(sellEstimate.totalOutLamports)} <span className="text-sm text-muted-foreground">SOL</span></span>
                      )
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {!loading && tokens.length > 0 && (
              <div className="py-4 border-b border-border flex flex-wrap items-center gap-2.5 font-mono text-xs">
                <div className="flex items-center gap-1.5 bg-muted/50 h-7 px-2 min-w-[190px]">
                  <span className="text-muted-foreground text-[10px] uppercase tracking-wider">search</span>
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="name / symbol"
                    disabled={isSelling}
                    className="w-32 bg-transparent text-xs font-mono text-foreground placeholder:text-muted-foreground/60 focus:outline-none disabled:opacity-40"
                  />
                </div>

                <div className="flex items-center gap-1.5 bg-muted/50 h-7 px-2">
                  <span className="text-muted-foreground text-[10px] uppercase tracking-wider">filter</span>
                  <select
                    value={verificationFilter}
                    onChange={(e) => setVerificationFilter(e.target.value as VerificationFilter)}
                    disabled={isSelling}
                    className="bg-transparent text-xs font-mono text-foreground focus:outline-none disabled:opacity-40"
                  >
                    <option value="all">all</option>
                    <option value="unverified">unverified</option>
                  </select>
                </div>

                <div className="flex items-center gap-1.5 bg-muted/50 h-7 px-2">
                  <span className="text-muted-foreground text-[10px] uppercase tracking-wider">sort</span>
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as TokenSort)}
                    disabled={isSelling}
                    className="bg-transparent text-xs font-mono text-foreground focus:outline-none disabled:opacity-40"
                  >
                    <option value="verification">verification</option>
                    <option value="value">value</option>
                    <option value="name">name</option>
                  </select>
                </div>

                <div className="flex items-center gap-1.5 bg-muted/50 h-7 px-2">
                  <span className="text-muted-foreground text-[10px] uppercase tracking-wider">slip</span>
                  <select
                    value={slippagePreset}
                    onChange={(e) => setSlippagePreset(e.target.value as SlippagePreset)}
                    disabled={isSelling}
                    className="bg-transparent text-xs font-mono text-foreground focus:outline-none disabled:opacity-40"
                  >
                    <option value="0.5">0.5%</option>
                    <option value="1">1%</option>
                    <option value="3">3%</option>
                    <option value="custom">custom</option>
                  </select>
                  {slippagePreset === 'custom' && (
                    <>
                      <input
                        type="number"
                        min="0.1"
                        max="50"
                        step="0.1"
                        value={customSlippagePercent}
                        onChange={(e) => setCustomSlippagePercent(e.target.value)}
                        disabled={isSelling}
                        className="w-12 bg-transparent text-xs font-mono text-foreground focus:outline-none disabled:opacity-40 tabular-nums"
                      />
                      <span className="text-muted-foreground">%</span>
                    </>
                  )}
                </div>

                <div className="flex items-center gap-1.5 bg-muted/50 h-7 px-2">
                  <span className="text-muted-foreground text-[10px] uppercase tracking-wider">dust</span>
                  <span className="text-muted-foreground">&lt;</span>
                  <span className="text-muted-foreground">$</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={dustThresholdUsdInput}
                    onChange={(e) => setDustThresholdUsdInput(e.target.value)}
                    onBlur={() => {
                      const parsed = Number(dustThresholdUsdInput)
                      if (!Number.isFinite(parsed)) {
                        setDustThresholdUsdInput(String(DEFAULT_DUST_THRESHOLD_USD))
                        return
                      }
                      setDustThresholdUsdInput(String(Math.max(0, parsed)))
                    }}
                    disabled={isSelling}
                    className="w-12 bg-transparent text-xs font-mono text-foreground focus:outline-none disabled:opacity-40 tabular-nums"
                  />
                </div>

                <button
                  type="button"
                  onClick={autoSelectDustTokens}
                  disabled={isSelling || visibleSellableTokens.length === 0}
                  className="h-7 px-2.5 border border-border text-xs font-mono uppercase tracking-wider hover:bg-accent hover:border-foreground/20 transition-all disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:border-border"
                >
                  auto-select
                </button>

                <div className="w-px h-4 bg-border mx-0.5" />

                <button
                  type="button"
                  onClick={selectAllSellable}
                  disabled={isSelling || visibleSellableTokens.length === 0}
                  className="h-7 px-2.5 border border-border text-xs font-mono uppercase tracking-wider hover:bg-accent hover:border-foreground/20 transition-all disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:border-border"
                >
                  all
                </button>
                <button
                  type="button"
                  onClick={clearSelection}
                  disabled={isSelling || selectedMints.size === 0}
                  className="h-7 px-2.5 border border-border text-xs font-mono uppercase tracking-wider hover:bg-accent hover:border-foreground/20 transition-all disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:border-border"
                >
                  clear
                </button>

                <div className="flex-1" />

                {sellEstimate.error && (
                  <span className="text-[hsl(var(--status-warning))] text-[11px]">{sellEstimate.error}</span>
                )}

                {selectedSellableCount > 0 && !sellEstimate.loading && sellEstimate.quotedCount > 0 && (
                  <span className="text-muted-foreground text-[11px] hidden sm:inline">
                    {sellEstimate.quotedCount} quoted
                  </span>
                )}

                {selectedSellableCount > 0 && (
                  <span className="text-muted-foreground text-[11px] hidden sm:inline">
                    {quoteAgeLabel}
                  </span>
                )}

                <span className="text-muted-foreground text-[11px] hidden sm:inline">
                  slip {formatSlippageBps(effectiveSlippageBps)}
                </span>

                {selectedSellableCount > 0 && (
                  <span className="text-muted-foreground text-[11px] hidden sm:inline">
                    sign prompts ~ {estimatedSignaturePrompts}
                  </span>
                )}

                {estimatedFeeLamports !== null && (
                  <span className="text-muted-foreground text-[11px] hidden sm:inline">
                    est. fees ~ {formatLamportsAsSol(estimatedFeeLamports, 6)} SOL
                  </span>
                )}

                <button
                  type="button"
                  onClick={refreshEstimate}
                  disabled={isSelling || selectedSellableCount === 0 || sellEstimate.loading}
                  className="h-8 px-3 border border-border text-[11px] font-mono uppercase tracking-wider hover:bg-accent hover:border-foreground/20 transition-all disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:border-border"
                >
                  {sellEstimate.loading ? 'refreshing...' : 'refresh estimate'}
                </button>

                <button
                  type="button"
                  onClick={sellSelectedTokens}
                  disabled={isSelling || selectedSellableCount === 0}
                  className={cn(
                    'h-8 px-4 text-xs font-mono uppercase tracking-wider transition-all inline-flex items-center gap-2',
                    'bg-foreground text-background',
                    selectedSellableCount > 0 && !isSelling
                      ? 'hover:opacity-80 active:scale-[0.98]'
                      : '',
                    'disabled:opacity-15'
                  )}
                >
                  {isSelling ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <ArrowRight className="h-3 w-3" />
                  )}
                  sell{selectedSellableCount > 0 ? ` ${selectedSellableCount}` : ''}
                </button>
              </div>
            )}

            {(isSelling || progressEvents.length > 0) && (
              <div className="py-4 border-b border-border font-mono text-xs text-muted-foreground">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    {isSelling ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-foreground" />
                    ) : (
                      <span className="inline-block h-2 w-2 bg-foreground/30" />
                    )}
                    <span>
                      {isSelling
                        ? `Selling ${completedSellCount}/${activeSellTargetCount}`
                        : 'Recent execution activity'}
                    </span>
                  </div>
                  {isSelling && (
                    <span className="tabular-nums text-foreground">
                      {currentRunResultCount}/{activeSellTargetCount}
                    </span>
                  )}
                </div>

                {isSelling && (
                  <>
                    <div className="mt-3 h-1 bg-border relative overflow-hidden">
                      <div
                        className="h-full bg-foreground transition-all duration-700 ease-out"
                        style={{ width: `${sellProgress}%` }}
                      />
                    </div>
                    <div className="mt-2 text-[11px]">
                      {activeExecutionEntry
                        ? `${activeExecutionEntry.tokenLabel} ${activeExecutionEntry.state === 'awaiting-signature' ? 'awaiting signature' : activeExecutionEntry.state === 'submitted' ? 'confirming' : 'routing'}`
                        : isBatchSigningSupported && activeSellTargetCount > 1
                          ? 'Approve signature batches in your wallet'
                          : 'Approve each swap in your wallet'}
                    </div>
                  </>
                )}

                <div className="mt-3 border border-border/60 bg-muted/30 max-h-44 overflow-auto">
                  {recentProgressEvents.length > 0 ? (
                    recentProgressEvents.map(event => (
                      <div key={event.id} className="flex items-center gap-2.5 px-2.5 py-2 border-b border-border/30 last:border-b-0">
                        <Badge variant={executionBadgeVariant(event.state)}>
                          {event.mint === 'batch' ? 'BATCH' : executionLabel(event.state)}
                        </Badge>
                        <span className="truncate min-w-0">
                          {event.mint === 'batch'
                            ? event.message
                            : `${event.tokenLabel}: ${event.message}`}
                        </span>
                        <span className="ml-auto text-[10px] text-muted-foreground/70 tabular-nums">
                          {formatTimeAgo(event.timestamp, nowMs)}
                        </span>
                      </div>
                    ))
                  ) : (
                    <div className="px-2.5 py-2 text-[11px] text-muted-foreground">No activity yet.</div>
                  )}
                </div>
              </div>
            )}

            {globalError && (
              <div className="py-3.5 border-b border-border font-mono text-xs text-[hsl(var(--status-error))]">
                {globalError}
              </div>
            )}

            {sellSummary && (
              <div
                className="py-3.5 border-b border-border font-mono text-xs flex items-center gap-4"
                style={{ animation: 'fadeUp 0.3s ease-out' }}
              >
                {sellSummary.sold > 0 && (
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block w-1.5 h-1.5 bg-[hsl(var(--status-success))]" />
                    <span>{sellSummary.sold} sold</span>
                  </span>
                )}
                {sellSummary.failed > 0 && (
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block w-1.5 h-1.5 bg-[hsl(var(--status-error))]" />
                    <span>{sellSummary.failed} failed</span>
                  </span>
                )}
                {sellSummary.skipped > 0 && (
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block w-1.5 h-1.5 bg-muted-foreground/40" />
                    <span className="text-muted-foreground">{sellSummary.skipped} skipped</span>
                  </span>
                )}
              </div>
            )}

            {shareResultSummary && shareResultSummary.soldCount > 0 && (
              <div
                className="py-5 border-b border-border"
                style={{ animation: 'fadeUp 0.35s ease-out' }}
              >
                <div className="relative overflow-hidden border border-[hsl(var(--status-success))]/35 bg-[linear-gradient(132deg,hsl(var(--status-success)/0.24)_0%,hsl(var(--background))_58%,hsl(var(--foreground)/0.08)_100%)] p-4 sm:p-5">
                  <div className="pointer-events-none absolute -right-8 -top-10 h-24 w-24 rounded-full bg-[hsl(var(--status-success))]/20 blur-2xl" />
                  <div className="pointer-events-none absolute -left-10 bottom-0 h-20 w-20 rounded-full bg-foreground/10 blur-xl" />

                  <div className="relative flex flex-wrap items-center justify-between gap-2">
                    <div className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.22em] text-foreground/85">
                      <Sparkles className="h-3 w-3" />
                      Share Your Win
                    </div>
                    <div className="font-mono text-[10px] uppercase tracking-widest text-foreground/75">
                      built for X + Solana feeds
                    </div>
                  </div>

                  <div className="relative mt-4">
                    <div className="font-serif italic text-[clamp(1.8rem,6vw,2.9rem)] leading-none tracking-tight text-foreground">
                      {shareReclaimedLabel}
                    </div>
                    <p className="mt-2 font-mono text-xs text-foreground/80">
                      reclaimed from {shareResultSummary.soldCount.toLocaleString()} dust token{shareResultSummary.soldCount === 1 ? '' : 's'}
                    </p>
                    {shareResultSummary.attemptedCount > shareResultSummary.soldCount && (
                      <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                        {shareResultSummary.soldCount}/{shareResultSummary.attemptedCount} confirmed this run.
                      </p>
                    )}
                  </div>

                  <div className="relative mt-4 border border-foreground/15 bg-background/55 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-foreground/88">
                    {shareCaption}
                  </div>

                  <div className="relative mt-3 flex flex-wrap gap-2">
                    {shareIntentUrl && (
                      <a
                        href={shareIntentUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="h-8 px-3 bg-foreground text-background text-[11px] font-mono uppercase tracking-wider inline-flex items-center gap-1.5 hover:opacity-85 transition-opacity"
                      >
                        Share on X
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        void copyShareCaption()
                      }}
                      className="h-8 px-3 border border-border text-[11px] font-mono uppercase tracking-wider inline-flex items-center gap-1.5 hover:bg-background/70 transition-colors"
                    >
                      {shareCaptionCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                      {shareCaptionCopied ? 'Copied' : 'Copy caption'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {recentActivity.length > 0 && (
              <div className="py-4 border-b border-border font-mono text-xs">
                <div className="mb-2 text-[10px] uppercase tracking-widest text-muted-foreground">Recent activity</div>
                <div className="border border-border/60 bg-muted/30">
                  {recentActivity.slice(0, 8).map(activity => (
                    <div key={activity.id} className="flex items-center gap-2.5 px-2.5 py-2 border-b border-border/30 last:border-b-0">
                      <span className="min-w-0 truncate">
                        Sold {activity.tokenAmount.toLocaleString()} {activity.tokenLabel}
                      </span>
                      <span className="ml-auto text-[10px] text-muted-foreground/70 tabular-nums">
                        {formatTimeAgo(activity.timestamp, nowMs)}
                      </span>
                      <a
                        href={`https://solscan.io/tx/${activity.signature}`}
                        target="_blank"
                        rel="noreferrer"
                        className="underline underline-offset-2 hover:text-foreground transition-colors"
                      >
                        solscan
                      </a>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {loading ? (
              <div className="py-24 flex flex-col items-center gap-4">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                <span className="font-mono text-xs text-muted-foreground">Scanning wallet...</span>
              </div>
            ) : tokens.length > 0 ? (
              visibleTokens.length > 0 ? (
                <div>
                  <div className="hidden md:grid grid-cols-[32px_1fr_80px_100px_90px] gap-3 items-center px-1 py-2.5 border-b border-border text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                    <div />
                    <div>Token</div>
                    <div>Status</div>
                    <div className="text-right">Balance</div>
                    <div className="text-right">Value</div>
                  </div>

                  {visibleTokens.map((token, index) => {
                    const execution = sellResults[token.mint]
                    const selected = selectedMints.has(token.mint)
                    const sellable = isSellableToken(token)
                    const verificationLevel = getVerificationLevel(token.metadata || null)
                    const txUrl = execution?.signature ? `https://solscan.io/tx/${execution.signature}` : null
                    const usdValue = tokenValueUsd(token)
                    const name = token.metadata
                      ? getTokenDisplayName(token.mint, token.metadata)
                      : 'Unknown'

                    return (
                      <div
                        key={token.mint}
                        className={cn(!sellable && 'opacity-30')}
                        style={{
                          animation: `fadeUp 0.25s ease-out ${Math.min(index * 0.02, 0.5)}s both`,
                        }}
                      >
                        <div
                          className={cn(
                            'grid grid-cols-[32px_1fr_90px] md:grid-cols-[32px_1fr_80px_100px_90px] gap-3 items-center py-3 border-b border-border/40 transition-all duration-150',
                            selected
                              ? 'bg-foreground/[0.04] border-l-2 border-l-foreground pl-2.5 md:pl-0.5'
                              : 'border-l-2 border-l-transparent pl-2.5 md:pl-0.5',
                            sellable && !isSelling && 'hover:bg-foreground/[0.025] cursor-pointer'
                          )}
                          onClick={() => sellable && !isSelling && toggleMintSelection(token.mint)}
                        >
                          <div className="flex justify-center">
                            <div
                              className={cn(
                                'w-4 h-4 border flex items-center justify-center transition-all duration-150',
                                selected
                                  ? 'border-foreground bg-foreground'
                                  : 'border-muted-foreground/25 hover:border-muted-foreground/50',
                                isSelling && 'opacity-40'
                              )}
                            >
                              {selected && (
                                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                                  <path d="M2 5L4 7L8 3" stroke="hsl(var(--background))" strokeWidth="1.5" strokeLinecap="square" />
                                </svg>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-3 min-w-0">
                            <Avatar className="h-7 w-7 shrink-0 rounded-none border border-border/50">
                              <AvatarImage src={token.metadata?.logoURI} />
                              <AvatarFallback className="rounded-none bg-muted text-muted-foreground text-[9px] font-mono">
                                {token.metadata?.symbol?.charAt(0) || '?'}
                              </AvatarFallback>
                            </Avatar>
                            <div className="min-w-0">
                              <div className="flex items-baseline gap-2">
                                <span className="font-mono text-sm truncate">{name}</span>
                                <span className="font-mono text-[10px] text-muted-foreground/50 hidden sm:inline">
                                  {truncateAddress(token.mint)}
                                </span>
                              </div>
                              <span className={cn(
                                'mt-1 block font-mono text-[9px] uppercase tracking-wider md:hidden',
                                verificationLevel === 'strict' || verificationLevel === 'verified'
                                  ? 'text-foreground/40'
                                  : 'text-muted-foreground/60'
                              )}>
                                {verificationLevel}
                              </span>
                            </div>
                          </div>

                          <div className="hidden md:block">
                            <span className={cn(
                              'font-mono text-[10px] uppercase tracking-wider',
                              verificationLevel === 'strict' || verificationLevel === 'verified'
                                ? 'text-foreground/50'
                                : 'text-muted-foreground/60'
                            )}>
                              {verificationLevel}
                            </span>
                          </div>

                          <div className="hidden md:block text-right">
                            <span className="font-mono text-xs tabular-nums">
                              {token.amount?.toLocaleString() || '0'}
                            </span>
                          </div>

                          <div className="text-right">
                            <span className={cn(
                              'font-mono text-xs tabular-nums',
                              usdValue !== null && usdValue < dustThresholdUsd && 'text-muted-foreground'
                            )}>
                              {usdValue !== null
                                ? formatPrice(usdValue)
                                : token.priceFetched ? '--' : '...'}
                            </span>
                            <span className="block md:hidden font-mono text-[10px] text-muted-foreground/50 tabular-nums">
                              {token.amount?.toLocaleString() || '0'}
                            </span>
                          </div>
                        </div>

                        {execution && (
                          <div
                            className="py-2.5 pl-[44px] pr-1 border-b border-border/20 font-mono text-[11px] text-muted-foreground flex items-center gap-2.5 bg-muted/30"
                            style={{ animation: 'fadeIn 0.2s ease-out' }}
                          >
                            <Badge variant={executionBadgeVariant(execution.state)}>
                              {executionLabel(execution.state)}
                            </Badge>
                            <span className="truncate">{execution.message}</span>
                            {execution.state === 'failed' && !isSelling && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  void retryToken(token.mint)
                                }}
                                className="shrink-0 px-1.5 py-0.5 border border-border hover:bg-accent transition-colors text-[10px] uppercase tracking-wider"
                              >
                                retry
                              </button>
                            )}
                            {txUrl && (
                              <a
                                href={txUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="shrink-0 underline underline-offset-2 hover:text-foreground transition-colors"
                                onClick={(e) => e.stopPropagation()}
                              >
                                view tx
                              </a>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="py-20 flex flex-col items-center gap-3">
                  <span className="font-mono text-xs text-muted-foreground">
                    No tokens match current search/filter settings.
                  </span>
                </div>
              )
            ) : (
              <div className="py-32 flex flex-col items-center gap-3">
                <span className="font-mono text-xs text-muted-foreground">
                  {globalError ? 'Unable to load tokens for this wallet.' : 'No tokens found in this wallet.'}
                </span>
              </div>
            )}

            {loadingMore && (
              <div className="py-4 flex items-center justify-center gap-2 font-mono text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                <span>Loading more tokens...</span>
              </div>
            )}

            <div className="h-24" />
          </div>
        ) : (
          <div
            className="max-w-[1000px] mx-auto px-6 flex flex-col justify-center min-h-[calc(100vh-49px)]"
            style={{ animation: 'fadeUp 0.5s ease-out' }}
          >
            <div className="max-w-[700px]">
              <div
                className="w-12 h-px bg-foreground/30 mb-10"
                style={{ animation: 'slideRight 0.6s ease-out 0.2s both' }}
              />
              <h1 className="font-serif italic text-[clamp(3rem,10vw,7rem)] leading-[0.9] tracking-tight mb-8">
                Sweep your<br />
                dust to SOL
              </h1>
              <p className="font-mono text-sm text-muted-foreground max-w-[380px] leading-relaxed mb-12">
                Connect your wallet. Select the tokens worth less than you
                care about. Sell them all to SOL in one batch.
              </p>
              <div className="flex items-center gap-3">
                <ArrowRight className="h-3 w-3 text-muted-foreground/60" />
                <button
                  type="button"
                  onClick={() => setWalletModalVisible(true)}
                  className="wallet-adapter-button wallet-adapter-button-trigger"
                >
                  Connect wallet to begin
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </>
  )
}
