import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { Connection, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { createCloseAccountInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { Loader2, ArrowRight, Check, Copy, ExternalLink, Sparkles, Download, Share2 } from 'lucide-react'
import { useShareCardImage } from '@/lib/useShareCardImage'
import { VariableSizeList } from 'react-window'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Select } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import Navbar from '../components/Navbar'
import Footer from '../components/Footer'
import {
  displayAmountFromRaw,
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
  amountRaw: string
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
type TradabilityStatus = 'unknown' | 'checking' | 'tradable' | 'untradable' | 'error'
type UsdQuoteStatus = 'unknown' | 'checking' | 'priced' | 'unavailable' | 'error'

interface ExecutionResult {
  state: ExecutionState
  message: string
  signature?: string
}

interface BatchExecutionStatus {
  current: number
  total: number
  tokenLabel: string
  phase: 'building' | 'awaiting-signature' | 'submitted' | 'cleanup'
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
  rawAmount: string
  quoteResponse: Record<string, unknown>
  outLamportsEstimate: bigint
}

interface SignableSwap extends PreparedSwap {
  transaction: VersionedTransaction
  lastValidBlockHeight: number
}

interface CleanupTokenAccount {
  address: PublicKey
  amountRaw: bigint
  decimals: number
  lamports: bigint
  programId: PublicKey
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

const ESTIMATE_QUOTE_TTL_MS = 15_000
const RECENT_ACTIVITY_STORAGE_KEY = 'sol-squeeze-recent-activity-v1'
const DEFAULT_DUST_THRESHOLD_USD = 5
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const TRADEABILITY_PROBE_BATCH_SIZE = 30
const TRADEABILITY_PROBE_CONCURRENCY = 6
const TOKEN_ROW_HEIGHT_PX = 124
const TOKEN_ROW_EXECUTION_HEIGHT_PX = 48
const TOKEN_VIRTUALIZATION_THRESHOLD = 80
const TOKEN_VIRTUAL_MAX_HEIGHT_PX = 680
const TOKEN_VIRTUAL_OVERSCAN = 8

function normalizeRawAmount(rawAmount: string): string {
  const trimmed = rawAmount.trim()
  if (!/^\d+$/.test(trimmed)) return '0'
  const normalized = trimmed.replace(/^0+/, '')
  return normalized || '0'
}

function isSellableToken(token: Token): boolean {
  return token.mint !== SOL_MINT && normalizeRawAmount(token.amountRaw) !== '0'
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

  const lamportsPerSol = BigInt(1_000_000_000)
  const lamportsPerMilliSol = BigInt(1_000_000)
  const maxFractionDigits = lamportsEstimate < lamportsPerMilliSol
    ? 9
    : lamportsEstimate < lamportsPerSol
      ? 6
      : 3

  return `${formatLamportsAsSol(lamportsEstimate, maxFractionDigits)} SOL`
}

function formatTokenAmount(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) return '0'
  return amount.toLocaleString()
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

function isWithinDustThreshold(token: Token, dustThresholdUsd: number): boolean {
  const usdValue = tokenValueUsd(token)
  return usdValue === null || usdValue < dustThresholdUsd
}

function hasValidTokenPrice(token: Token): boolean {
  return typeof token.price === 'number' && Number.isFinite(token.price) && token.price > 0
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

function parseUnsignedBigInt(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
  return BigInt(value)
}

function parseRecentActivityItem(value: unknown, index: number): RecentActivityItem | null {
  if (typeof value !== 'object' || value === null) return null

  const item = value as Partial<RecentActivityItem>
  if (typeof item.signature !== 'string' || item.signature.length === 0) return null
  if (typeof item.mint !== 'string' || item.mint.length === 0) return null
  if (typeof item.tokenLabel !== 'string' || item.tokenLabel.length === 0) return null
  if (typeof item.tokenAmount !== 'number' || !Number.isFinite(item.tokenAmount) || item.tokenAmount < 0) return null

  const timestamp = typeof item.timestamp === 'number' && Number.isFinite(item.timestamp) && item.timestamp > 0
    ? item.timestamp
    : Date.now()
  const id = typeof item.id === 'string' && item.id.length > 0
    ? item.id
    : `${item.signature}-${timestamp}-${index}`

  return {
    id,
    signature: item.signature,
    mint: item.mint,
    tokenLabel: item.tokenLabel,
    tokenAmount: item.tokenAmount,
    timestamp,
  }
}

async function findEmptyTokenAccountForClose(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey
): Promise<CleanupTokenAccount | null> {
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(owner, { mint }, 'confirmed')

  let selected: CleanupTokenAccount | null = null
  for (const tokenAccount of tokenAccounts.value) {
    const accountData = tokenAccount.account.data
    if (typeof accountData !== 'object' || accountData === null || !('parsed' in accountData)) {
      continue
    }

    const info = (
      accountData as {
        parsed?: {
          info?: {
            tokenAmount?: {
              amount?: unknown
            }
          }
        }
      }
    ).parsed?.info

    const amountRaw = parseUnsignedBigInt(info?.tokenAmount?.amount)
    if (amountRaw === null || amountRaw !== BigInt(0)) {
      continue
    }

    const candidate: CleanupTokenAccount = {
      address: tokenAccount.pubkey,
      amountRaw,
      decimals: 0,
      lamports: BigInt(tokenAccount.account.lamports),
      programId: tokenAccount.account.owner || TOKEN_PROGRAM_ID,
    }

    if (!selected || candidate.lamports > selected.lamports) {
      selected = candidate
    }
  }

  return selected
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
    if (aValue !== null) return -1
    if (bValue !== null) return 1
    return (b.amount || 0) - (a.amount || 0)
  })
}

export function Home({ active = true }: { active?: boolean }) {
  const { publicKey, connected, sendTransaction, signTransaction, wallet } = useWallet()
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
  const [hideUnverifiedTokens, setHideUnverifiedTokens] = useState(false)
  const [tradabilityByMint, setTradabilityByMint] = useState<Record<string, TradabilityStatus>>({})
  const [usdQuoteStatusByMint, setUsdQuoteStatusByMint] = useState<Record<string, UsdQuoteStatus>>({})
  const [hideNoValueTokens, setHideNoValueTokens] = useState(true)

  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [recentActivity, setRecentActivity] = useState<RecentActivityItem[]>([])
  const [progressEvents, setProgressEvents] = useState<ProgressEvent[]>([])
  const [batchExecutionStatus, setBatchExecutionStatus] = useState<BatchExecutionStatus | null>(null)
  const [shareResultSummary, setShareResultSummary] = useState<ShareResultSummary | null>(null)
  const [shareCaptionCopied, setShareCaptionCopied] = useState(false)
  const [isSharingOnX, setIsSharingOnX] = useState(false)
  const { previewUrl, isGenerating, generatePreview, downloadImage, nativeShare, copyImageToClipboard, canNativeShare } = useShareCardImage()
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
  const toastTimeoutsRef = useRef<Map<number, number>>(new Map())
  const toastCounterRef = useRef(0)
  const progressCounterRef = useRef(0)
  const estimateForceRefreshRef = useRef(false)
  const walletConnectedRef = useRef(connected)
  const walletAddressRef = useRef(publicKey?.toBase58() || null)
  const shareCopiedResetTimerRef = useRef<number | null>(null)
  const tradabilityProbeControllerRef = useRef<AbortController | null>(null)
  const tradabilityByMintRef = useRef<Record<string, TradabilityStatus>>({})
  const usdQuoteStatusByMintRef = useRef<Record<string, UsdQuoteStatus>>({})
  const effectiveSlippageBpsRef = useRef(0)

  useEffect(() => {
    walletConnectedRef.current = connected
    walletAddressRef.current = publicKey?.toBase58() || null
  }, [connected, publicKey])

  useEffect(() => {
    tradabilityByMintRef.current = tradabilityByMint
  }, [tradabilityByMint])

  useEffect(() => {
    usdQuoteStatusByMintRef.current = usdQuoteStatusByMint
  }, [usdQuoteStatusByMint])

  useEffect(() => {
    let intervalMs = 0
    if (sellEstimate.loading || progressEvents.length > 0) {
      intervalMs = 1_000
    } else if (sellEstimate.lastUpdatedAt || recentActivity.length > 0) {
      intervalMs = 5_000
    }

    if (intervalMs === 0) {
      return
    }

    setNowMs(Date.now())
    const interval = window.setInterval(() => {
      setNowMs(Date.now())
    }, intervalMs)

    return () => {
      window.clearInterval(interval)
    }
  }, [sellEstimate.loading, sellEstimate.lastUpdatedAt, progressEvents.length, recentActivity.length])

  useEffect(() => {
    try {
      const storedActivity = localStorage.getItem(RECENT_ACTIVITY_STORAGE_KEY)
      if (storedActivity) {
        const parsed = JSON.parse(storedActivity) as unknown
        if (Array.isArray(parsed)) {
          const hydrated = parsed
            .map((item, index) => parseRecentActivityItem(item, index))
            .filter((item): item is RecentActivityItem => item !== null)
            .slice(0, 30)
          setRecentActivity(hydrated)
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
      for (const timeoutId of toastTimeoutsRef.current.values()) {
        window.clearTimeout(timeoutId)
      }
      toastTimeoutsRef.current.clear()
      if (shareCopiedResetTimerRef.current !== null) {
        window.clearTimeout(shareCopiedResetTimerRef.current)
      }
      tradabilityProbeControllerRef.current?.abort()
    }
  }, [])

  function removeToast(id: number) {
    const timeoutId = toastTimeoutsRef.current.get(id)
    if (typeof timeoutId === 'number') {
      window.clearTimeout(timeoutId)
      toastTimeoutsRef.current.delete(id)
    }
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

    const timeoutId = window.setTimeout(() => {
      toastTimeoutsRef.current.delete(id)
      removeToast(id)
    }, 7000)
    toastTimeoutsRef.current.set(id, timeoutId)
  }

  const probeTokensSignature = useMemo(
    () => tokens.map(token => `${token.mint}:${token.amountRaw}:${token.metadata?.decimals ?? 0}`).join('|'),
    [tokens]
  )

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
  effectiveSlippageBpsRef.current = effectiveSlippageBps

  useEffect(() => {
    if (connected && publicKey) {
      fetchTokens(publicKey.toBase58())
    } else {
      fetchControllerRef.current?.abort()
      tradabilityProbeControllerRef.current?.abort()
      setTokens([])
      setSelectedMints(new Set())
      setSellResults({})
      setSellSummary(null)
      setGlobalError(null)
      setIsConfirmModalOpen(false)
      setCurrentRunMints(new Set())
      setTradabilityByMint({})
      setUsdQuoteStatusByMint({})
    }
  }, [connected, publicKey])

  useEffect(() => {
    const currentMints = new Set(tokens.map(token => token.mint))

    setTradabilityByMint(prev => {
      const next: Record<string, TradabilityStatus> = {}
      let changed = false
      for (const [mint, status] of Object.entries(prev)) {
        if (currentMints.has(mint)) {
          next[mint] = status
        } else {
          changed = true
        }
      }
      return changed ? next : prev
    })

    setUsdQuoteStatusByMint(prev => {
      const next: Record<string, UsdQuoteStatus> = {}
      let changed = false
      for (const [mint, status] of Object.entries(prev)) {
        if (currentMints.has(mint)) {
          next[mint] = status
        } else {
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [tokens])



  useEffect(() => {
    tradabilityProbeControllerRef.current?.abort()
    setTradabilityByMint(prev => {
      let changed = false
      const next = { ...prev }
      for (const [mint, status] of Object.entries(next)) {
        if (status === 'checking') {
          next[mint] = 'unknown'
          changed = true
        }
      }
      return changed ? next : prev
    })
    setUsdQuoteStatusByMint(prev => {
      let changed = false
      const next = { ...prev }
      for (const [mint, status] of Object.entries(next)) {
        if (status === 'checking') {
          next[mint] = 'unknown'
          changed = true
        }
      }
      return changed ? next : prev
    })

    if (!connected || !publicKey || isSelling) {
      return
    }

    const probeTargets = tokens.filter(isSellableToken)
    const probeCandidates = probeTargets.filter(token => {
      const tradabilityStatus = tradabilityByMintRef.current[token.mint]
      const usdQuoteStatus = usdQuoteStatusByMintRef.current[token.mint]
      const needsTradability = tradabilityStatus !== 'tradable' && tradabilityStatus !== 'untradable' && tradabilityStatus !== 'checking'
      const needsImpliedUsd = !hasValidTokenPrice(token)
        && usdQuoteStatus !== 'priced'
        && usdQuoteStatus !== 'unavailable'
        && usdQuoteStatus !== 'checking'
      return needsTradability || needsImpliedUsd
    })

    if (probeCandidates.length === 0) {
      return
    }

    const controller = new AbortController()
    tradabilityProbeControllerRef.current = controller

    const run = async () => {
      for (let index = 0; index < probeCandidates.length; index += TRADEABILITY_PROBE_BATCH_SIZE) {
        if (controller.signal.aborted) return

        const batch = probeCandidates.slice(index, index + TRADEABILITY_PROBE_BATCH_SIZE)

        setTradabilityByMint(prev => {
          const next = { ...prev }
          for (const token of batch) {
            const status = next[token.mint]
            if (status !== 'tradable' && status !== 'untradable') {
              next[token.mint] = 'checking'
            }
          }
          return next
        })

        setUsdQuoteStatusByMint(prev => {
          const next = { ...prev }
          for (const token of batch) {
            if (hasValidTokenPrice(token)) continue
            const status = next[token.mint]
            if (status !== 'priced' && status !== 'unavailable') {
              next[token.mint] = 'checking'
            }
          }
          return next
        })

        const outcomes = await mapWithConcurrency(batch, TRADEABILITY_PROBE_CONCURRENCY, async token => {
          const currentTradabilityStatus = tradabilityByMintRef.current[token.mint]
          const currentUsdQuoteStatus = usdQuoteStatusByMintRef.current[token.mint]
          const decimals = token.metadata?.decimals ?? 0
          const rawAmount = normalizeRawAmount(token.amountRaw)
          if (rawAmount === '0') {
            return {
              mint: token.mint,
              tradabilityStatus: 'untradable' as TradabilityStatus,
              usdQuoteStatus: 'unavailable' as UsdQuoteStatus,
            }
          }

          let tradabilityStatus: TradabilityStatus = currentTradabilityStatus || 'unknown'
          if (tradabilityStatus !== 'tradable' && tradabilityStatus !== 'untradable') {
            try {
              await getJupiterQuote({
                inputMint: token.mint,
                outputMint: SOL_MINT,
                amount: rawAmount,
                slippageBps: effectiveSlippageBpsRef.current,
                signal: controller.signal,
                cacheTtlMs: 60_000,
              })
              tradabilityStatus = 'tradable'
            } catch (error) {
              if (controller.signal.aborted) {
                tradabilityStatus = 'unknown'
              } else {
                tradabilityStatus = hasNoRouteError(errorMessage(error)) ? 'untradable' : 'error'
              }
            }
          }

          let usdQuoteStatus: UsdQuoteStatus = currentUsdQuoteStatus || 'unknown'
          let impliedPrice: number | null = null
          if (!hasValidTokenPrice(token) && usdQuoteStatus !== 'priced' && usdQuoteStatus !== 'unavailable') {
            if (tradabilityStatus === 'untradable') {
              usdQuoteStatus = 'unavailable'
            } else {
              try {
                const usdQuote = await getJupiterQuote({
                  inputMint: token.mint,
                  outputMint: USDC_MINT,
                  amount: rawAmount,
                  slippageBps: effectiveSlippageBpsRef.current,
                  signal: controller.signal,
                  cacheTtlMs: 60_000,
                })
                const outAmountRaw = getQuoteOutAmountRaw(usdQuote)
                if (outAmountRaw) {
                  const impliedUsdTotal = Number(outAmountRaw) / 1_000_000
                  const baseTokenAmount = displayAmountFromRaw(rawAmount, decimals)
                  const impliedUnitPrice = baseTokenAmount > 0 ? impliedUsdTotal / baseTokenAmount : 0
                  if (Number.isFinite(impliedUnitPrice) && impliedUnitPrice > 0) {
                    impliedPrice = impliedUnitPrice
                    usdQuoteStatus = 'priced'
                  } else {
                    usdQuoteStatus = 'unavailable'
                  }
                } else {
                  usdQuoteStatus = 'unavailable'
                }
              } catch (error) {
                if (controller.signal.aborted) {
                  usdQuoteStatus = 'unknown'
                } else {
                  usdQuoteStatus = hasNoRouteError(errorMessage(error)) ? 'unavailable' : 'error'
                }
              }
            }
          }

          return {
            mint: token.mint,
            tradabilityStatus,
            usdQuoteStatus,
            impliedPrice,
          }
        })

        if (controller.signal.aborted) return

        setTradabilityByMint(prev => {
          const next = { ...prev }
          for (const outcome of outcomes) {
            next[outcome.mint] = outcome.tradabilityStatus
          }
          return next
        })

        setUsdQuoteStatusByMint(prev => {
          const next = { ...prev }
          for (const outcome of outcomes) {
            next[outcome.mint] = outcome.usdQuoteStatus
          }
          return next
        })

        setTokens(prevTokens => {
          let changed = false
          const byMint = new Map(outcomes.map(outcome => [outcome.mint, outcome]))
          const nextTokens = prevTokens.map(token => {
            const outcome = byMint.get(token.mint)
            if (!outcome || outcome.impliedPrice === null || hasValidTokenPrice(token)) {
              return token
            }
            changed = true
            return {
              ...token,
              price: outcome.impliedPrice,
              priceFetched: true,
            }
          })
          return changed ? nextTokens : prevTokens
        })
      }
    }

    void run()

    return () => {
      controller.abort()
    }
  }, [
    connected,
    publicKey,
    isSelling,
    probeTokensSignature,
  ])

  useEffect(() => {
    setSelectedMints(prevSelected => {
      const tokenMints = new Set(
        tokens
          .filter(token => (
            isSellableToken(token)
            && !(tradabilityByMint[token.mint] === 'untradable' && tokenValueUsd(token) === null)
            && tradabilityByMint[token.mint] !== 'untradable'
            && isWithinDustThreshold(token, dustThresholdUsd)
            && (
              verificationFilter === 'unverified'
              || !hideUnverifiedTokens
              || getVerificationLevel(token.metadata || null) !== 'unverified'
            )
          ))
          .map(token => token.mint)
      )
      const nextSelected = new Set(Array.from(prevSelected).filter(mint => tokenMints.has(mint)))
      return nextSelected
    })
  }, [tokens, hideUnverifiedTokens, tradabilityByMint, verificationFilter, dustThresholdUsd])

  const sellableTokens = useMemo(() => tokens.filter(isSellableToken), [tokens])

  const tokensWithValue = useMemo(
    () => tokens.filter(token => tokenValueUsd(token) !== null),
    [tokens]
  )

  const sellableTokensWithValue = useMemo(
    () => sellableTokens.filter(token => tokenValueUsd(token) !== null),
    [sellableTokens]
  )

  const valuesResolvedCount = useMemo(() => {
    return sellableTokens.filter(token => {
      const tradStatus = tradabilityByMint[token.mint]
      const usdStatus = usdQuoteStatusByMint[token.mint]
      const tradResolved = tradStatus === 'tradable' || tradStatus === 'untradable' || tradStatus === 'error'
      const usdResolved = hasValidTokenPrice(token) || usdStatus === 'priced' || usdStatus === 'unavailable' || usdStatus === 'error'
      return tradResolved && usdResolved
    }).length
  }, [sellableTokens, tradabilityByMint, usdQuoteStatusByMint])

  const allValuesResolved = useMemo(() => {
    if (loading || loadingMore) return false
    if (sellableTokens.length === 0) return tokens.length > 0
    return valuesResolvedCount === sellableTokens.length
  }, [loading, loadingMore, tokens, sellableTokens, valuesResolvedCount])

  const visibleTokens = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase()

    const filteredTokens = tokens.filter(token => {
      const verificationLevel = getVerificationLevel(token.metadata || null)
      const hasNoValueAndNoRoute = tradabilityByMint[token.mint] === 'untradable' && tokenValueUsd(token) === null

      if (hasNoValueAndNoRoute) {
        return false
      }

      if (tradabilityByMint[token.mint] === 'untradable') {
        return false
      }

      if (verificationFilter === 'unverified' && verificationLevel !== 'unverified') {
        return false
      }

      if (verificationFilter !== 'unverified' && hideUnverifiedTokens && verificationLevel === 'unverified') {
        return false
      }

      if (hideNoValueTokens && tokenValueUsd(token) === null) {
        return false
      }

      if (!isWithinDustThreshold(token, dustThresholdUsd)) {
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
  }, [tokens, searchQuery, verificationFilter, sortBy, hideUnverifiedTokens, hideNoValueTokens, tradabilityByMint, dustThresholdUsd])

  const visibleSellableTokens = useMemo(
    () => visibleTokens.filter(isSellableToken),
    [visibleTokens]
  )

  const shouldVirtualizeTokenRows = visibleTokens.length >= TOKEN_VIRTUALIZATION_THRESHOLD
  const getVirtualizedTokenRowHeight = (index: number) => {
    const token = visibleTokens[index]
    if (!token) return TOKEN_ROW_HEIGHT_PX
    return sellResults[token.mint] ? TOKEN_ROW_HEIGHT_PX + TOKEN_ROW_EXECUTION_HEIGHT_PX : TOKEN_ROW_HEIGHT_PX
  }

  const virtualizedTokenContentHeight = useMemo(
    () => visibleTokens.reduce(
      (height, token) => height + (sellResults[token.mint] ? TOKEN_ROW_HEIGHT_PX + TOKEN_ROW_EXECUTION_HEIGHT_PX : TOKEN_ROW_HEIGHT_PX),
      0
    ),
    [visibleTokens, sellResults]
  )

  const virtualizedTokenListHeight = useMemo(
    () => Math.min(TOKEN_VIRTUAL_MAX_HEIGHT_PX, Math.max(TOKEN_ROW_HEIGHT_PX * 4, virtualizedTokenContentHeight)),
    [virtualizedTokenContentHeight]
  )

  const tokenListVirtualizerRef = useRef<VariableSizeList | null>(null)

  useEffect(() => {
    tokenListVirtualizerRef.current?.resetAfterIndex(0)
  }, [visibleTokens.length, sellResults])

  const noValueNoRouteTokenCount = useMemo(
    () => sellableTokens.filter(token => tradabilityByMint[token.mint] === 'untradable' && tokenValueUsd(token) === null).length,
    [sellableTokens, tradabilityByMint]
  )

  const unverifiedTokenCount = useMemo(
    () => sellableTokens.filter(token => getVerificationLevel(token.metadata || null) === 'unverified').length,
    [sellableTokens]
  )

  const overDustThresholdTokenCount = useMemo(
    () => sellableTokens.filter(token => {
      const usdValue = tokenValueUsd(token)
      return usdValue !== null && usdValue >= dustThresholdUsd
    }).length,
    [sellableTokens, dustThresholdUsd]
  )

  const tradabilityChecksInFlight = useMemo(
    () => sellableTokens.filter(token => (
      tradabilityByMint[token.mint] === 'checking' || usdQuoteStatusByMint[token.mint] === 'checking'
    )).length,
    [sellableTokens, tradabilityByMint, usdQuoteStatusByMint]
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
    () => tokens.filter(token => (
      selectedMints.has(token.mint)
      && isSellableToken(token)
      && isWithinDustThreshold(token, dustThresholdUsd)
    )),
    [tokens, selectedMints, dustThresholdUsd]
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

  const activeExecutionLabel = useMemo(() => {
    if (batchExecutionStatus) {
      const phaseLabel = batchExecutionStatus.phase === 'awaiting-signature'
        ? 'awaiting signature'
        : batchExecutionStatus.phase === 'submitted'
          ? 'confirming'
          : batchExecutionStatus.phase === 'cleanup'
            ? 'closing token account'
            : 'routing'
      return `Swap ${batchExecutionStatus.current}/${batchExecutionStatus.total}: ${batchExecutionStatus.tokenLabel} — ${phaseLabel}`
    }

    if (activeExecutionEntry) {
      return `${activeExecutionEntry.tokenLabel} ${activeExecutionEntry.state === 'awaiting-signature' ? 'awaiting signature' : activeExecutionEntry.state === 'submitted' ? 'confirming' : 'routing'}`
    }

    if (isSelling && activeSellTargetCount > 0) {
      return `Approve swaps one by one in your wallet (${Math.min(completedSellCount + 1, activeSellTargetCount)}/${activeSellTargetCount} next).`
    }

    return 'Approve each swap in your wallet'
  }, [activeExecutionEntry, activeSellTargetCount, batchExecutionStatus, completedSellCount, isSelling])

  const maxPriorityFeeLamports = useMemo(() => BigInt(getMaxPriorityFeeLamports()), [])

  const estimatedFeeLamports = useMemo(() => {
    if (selectedSellableCount === 0) return null
    const baseNetworkFeeLamports = BigInt(5_000)
    return BigInt(selectedSellableCount) * (baseNetworkFeeLamports + maxPriorityFeeLamports)
  }, [selectedSellableCount, maxPriorityFeeLamports])

  const estimatedSignaturePrompts = useMemo(() => {
    if (selectedSellableCount === 0) return 0
    return selectedSellableCount
  }, [selectedSellableCount])

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
    if (shareResultSummary && shareResultSummary.soldCount > 0) {
      void generatePreview({
        reclaimedLabel: formatShareReclaimedLabel(shareResultSummary.reclaimedLamportsEstimate ?? null),
        soldCount: shareResultSummary.soldCount,
      })
    }
  }, [shareResultSummary, generatePreview])

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

          const rawAmount = normalizeRawAmount(token.amountRaw)

          if (rawAmount === '0') {
            return { outLamports: BigInt(0), quoted: false, failed: true }
          }

          try {
            const quoteResponse = await getJupiterQuote({
              inputMint: token.mint,
              outputMint: SOL_MINT,
              amount: rawAmount,
              slippageBps: effectiveSlippageBpsRef.current,
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
  }, [connected, isSelling, selectedTokensForSell, selectedSellableCount, estimateRefreshNonce])

  // Debounce slippage changes to re-trigger estimation
  useEffect(() => {
    const timer = setTimeout(() => {
      setEstimateRefreshNonce(prev => prev + 1)
    }, 600)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveSlippageBps])

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

  async function shareOnX() {
    if (!shareIntentUrl || isSharingOnX) return
    setIsSharingOnX(true)
    try {
      const shareTab = window.open(shareIntentUrl, '_blank', 'noopener,noreferrer')
      if (!shareTab) {
        pushToast('error', 'Popup blocked. Allow popups for this site to share on X in a new tab.')
        return
      }

      let imageCopiedToClipboard = false
      if (previewUrl) {
        imageCopiedToClipboard = await copyImageToClipboard()
      }

      if (imageCopiedToClipboard) {
        pushToast('info', 'Opened X in a new tab. Paste image with Cmd+V / Ctrl+V.')
      } else if (previewUrl) {
        pushToast('info', 'Opened X in a new tab. This browser blocked image copy; use Download image.')
      } else {
        pushToast('info', 'Opened X in a new tab.')
      }
    } finally {
      setIsSharingOnX(false)
    }
  }

  async function preSimulateTransaction(
    connection: Connection,
    transaction: VersionedTransaction
  ): Promise<void> {
    const result = await connection.simulateTransaction(transaction, {
      sigVerify: false,
      commitment: 'confirmed',
    })
    if (result.value.err) {
      throw new Error(
        `Simulation failed: ${JSON.stringify(result.value.err)}${
          result.value.logs ? '\nLogs: ' + result.value.logs.slice(-3).join('\n') : ''
        }`
      )
    }
  }

  async function submitVersionedTransaction(
    connection: Connection,
    transaction: VersionedTransaction
  ): Promise<string> {
    if (signTransaction) {
      const signedTransaction = await signTransaction(transaction)
      return connection.sendRawTransaction(signedTransaction.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
        preflightCommitment: 'confirmed',
      })
    }

    return sendTransaction(transaction, connection, {
      skipPreflight: false,
      maxRetries: 3,
      preflightCommitment: 'confirmed',
    })
  }

  async function executePostSwapAccountClose(
    connection: Connection,
    ownerAddress: string,
    tokenAccount: CleanupTokenAccount
  ): Promise<string> {
    const ownerPublicKey = new PublicKey(ownerAddress)
    const { blockhash } = await connection.getLatestBlockhash('confirmed')
    const message = new TransactionMessage({
      payerKey: ownerPublicKey,
      recentBlockhash: blockhash,
      instructions: [
        createCloseAccountInstruction(
          tokenAccount.address,
          ownerPublicKey,
          ownerPublicKey,
          [],
          tokenAccount.programId
        ),
      ],
    }).compileToV0Message()
    const transaction = new VersionedTransaction(message)

    await preSimulateTransaction(connection, transaction)

    return submitVersionedTransaction(connection, transaction)
  }

  async function executeSellRun(
    targetTokens: Token[],
    options: { resetResults: boolean; resetSummary: boolean }
  ) {
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
    let succeeded = 0
    let failed = 0
    let skipped = 0
    let confirmedSwaps = 0
    let confirmedPostSwapClosures = 0
    let swapOutLamportsEstimate = BigInt(0)
    let cleanupLamportsRecovered = BigInt(0)
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

    const finalizeConfirmedSwap = async (preparedSwap: PreparedSwap, signature: string) => {
      succeeded += 1
      confirmedSwaps += 1
      swapOutLamportsEstimate += preparedSwap.outLamportsEstimate
      soldMints.add(preparedSwap.token.mint)

      let finalMessage = 'Done.'

      try {
        const ownerPublicKey = new PublicKey(ownerAddress)
        const mintPublicKey = new PublicKey(preparedSwap.token.mint)
        const emptyTokenAccount = await findEmptyTokenAccountForClose(connection, ownerPublicKey, mintPublicKey)

        if (emptyTokenAccount) {
          setBatchExecutionStatus({
            current: succeeded + failed + skipped,
            total: runTargetCount,
            tokenLabel: tokenLabel(preparedSwap.token),
            phase: 'cleanup',
          })
          updateSellResult(preparedSwap.token.mint, {
            state: 'awaiting-signature',
            signature,
            message: 'Swap confirmed. Sign to close empty token account.',
          })

          const closeSignature = await executePostSwapAccountClose(connection, ownerAddress, emptyTokenAccount)
          updateSellResult(preparedSwap.token.mint, {
            state: 'submitted',
            signature: closeSignature,
            message: 'Confirming token account close...',
          })

          const closeConfirmation = await connection.confirmTransaction(closeSignature, 'confirmed')
          if (closeConfirmation.value.err) {
            throw new Error(`On-chain error: ${JSON.stringify(closeConfirmation.value.err)}`)
          }

          confirmedPostSwapClosures += 1
          cleanupLamportsRecovered += emptyTokenAccount.lamports
          finalMessage = 'Done. Closed empty token account.'
        }
      } catch (closeError) {
        finalMessage = 'Done. Swap confirmed (account close failed).'
        pushToast('error', `Swap confirmed for ${tokenLabel(preparedSwap.token)}, but account close failed: ${errorMessage(closeError)}`)
      }

      updateSellResult(preparedSwap.token.mint, {
        state: 'confirmed',
        signature,
        message: finalMessage,
      })
      addRecentActivity({
        signature,
        mint: preparedSwap.token.mint,
        tokenLabel: tokenLabel(preparedSwap.token),
        tokenAmount: preparedSwap.token.amount,
      })
    }

    const refreshPreparedSwapQuote = async (preparedSwap: PreparedSwap): Promise<Record<string, unknown>> => {
      const refreshedQuote = await getJupiterQuote({
        inputMint: preparedSwap.token.mint,
        outputMint: SOL_MINT,
        amount: preparedSwap.rawAmount,
        slippageBps: effectiveSlippageBps,
        forceRefresh: true,
      })
      const outAmountRaw = getQuoteOutAmountRaw(refreshedQuote)
      preparedSwap.quoteResponse = refreshedQuote
      preparedSwap.outLamportsEstimate = outAmountRaw ? BigInt(outAmountRaw) : BigInt(0)
      return refreshedQuote
    }

    const prepareSwapForSigning = async (preparedSwap: PreparedSwap): Promise<SignableSwap> => {
      let quoteResponse = preparedSwap.quoteResponse
      let lastError: unknown = null

      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (attempt === 1) {
          quoteResponse = await refreshPreparedSwapQuote(preparedSwap)
        }

        try {
          const { transaction, lastValidBlockHeight } = await buildJupiterSwapTransaction({
            quoteResponse,
            userPublicKey: ownerAddress,
          })
          await preSimulateTransaction(connection, transaction)
          preparedSwap.quoteResponse = quoteResponse

          return {
            ...preparedSwap,
            quoteResponse,
            transaction,
            lastValidBlockHeight,
          }
        } catch (error) {
          lastError = error
        }
      }

      throw lastError instanceof Error ? lastError : new Error(errorMessage(lastError))
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
        const progressPosition = Math.min(index + 1, runTargetCount)

        if (!isWalletSessionValid()) {
          handleWalletDisconnection(targetTokens.slice(index))
          break
        }

        if (!isSellableToken(token)) {
          skipped += 1
          updateSellResult(token.mint, { state: 'skipped', message: 'Not sellable.' })
          continue
        }

        const rawAmount = normalizeRawAmount(token.amountRaw)

        if (rawAmount === '0') {
          skipped += 1
          updateSellResult(token.mint, { state: 'skipped', message: 'Balance too small.' })
          continue
        }

        try {
          setBatchExecutionStatus({
            current: progressPosition,
            total: runTargetCount,
            tokenLabel: tokenLabel(token),
            phase: 'building',
          })
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
            if (hasNoRouteError(errorMessage(error))) {
              pushToast('error', message)
            } else {
              pushToast('error', message, {
                label: 'Retry',
                onClick: () => {
                  void retryToken(token.mint)
                },
              })
            }
            continue
          }

          const outAmountRaw = getQuoteOutAmountRaw(quoteResponse)

          preparedSwaps.push({
            token,
            rawAmount,
            quoteResponse,
            outLamportsEstimate: outAmountRaw ? BigInt(outAmountRaw) : BigInt(0),
          })
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
        for (let index = 0; index < preparedSwaps.length; index += 1) {
          const preparedSwap = preparedSwaps[index]
          const progressPosition = Math.min(completedSellCount + 1, runTargetCount)

          if (!isWalletSessionValid()) {
            const remaining = preparedSwaps.slice(index).map(item => item.token)
            handleWalletDisconnection(remaining)
            break
          }

          try {
            const signableSwap = await prepareSwapForSigning(preparedSwap)

            setBatchExecutionStatus({
              current: progressPosition,
              total: runTargetCount,
              tokenLabel: tokenLabel(signableSwap.token),
              phase: 'awaiting-signature',
            })
            updateSellResult(signableSwap.token.mint, { state: 'awaiting-signature', message: 'Sign in wallet.' })

            const signature = await submitVersionedTransaction(connection, signableSwap.transaction)

            setBatchExecutionStatus({
              current: progressPosition,
              total: runTargetCount,
              tokenLabel: tokenLabel(signableSwap.token),
              phase: 'submitted',
            })
            updateSellResult(signableSwap.token.mint, { state: 'submitted', signature, message: 'Confirming...' })

            const confirmation = await connection.confirmTransaction(
              {
                signature,
                blockhash: signableSwap.transaction.message.recentBlockhash,
                lastValidBlockHeight: signableSwap.lastValidBlockHeight,
              },
              'confirmed'
            )

            if (confirmation.value.err) {
              throw new Error(`On-chain error: ${JSON.stringify(confirmation.value.err)}`)
            }

            await finalizeConfirmedSwap(signableSwap, signature)
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

      if (options.resetSummary) {
        setSellSummary({ sold: succeeded, failed, skipped })
      }

      const postSwapCloseSummary = confirmedPostSwapClosures > 0
        ? `, ${confirmedPostSwapClosures} post-swap account close${confirmedPostSwapClosures > 1 ? 's' : ''}`
        : ''
      appendBatchProgressEvent(
        `Finished: ${succeeded} confirmed (${confirmedSwaps} swaps${postSwapCloseSummary}), ${failed} failed, ${skipped} skipped.`
      )

      if (succeeded > 0) {
        const reclaimedLamportsEstimate = swapOutLamportsEstimate + cleanupLamportsRecovered
        setShareResultSummary({
          soldCount: succeeded,
          attemptedCount: runTargetCount,
          reclaimedLamportsEstimate,
        })
        setShareCaptionCopied(false)
        const closeSuffix = confirmedPostSwapClosures > 0
          ? ` Closed ${confirmedPostSwapClosures} empty token account${confirmedPostSwapClosures > 1 ? 's' : ''} to reclaim rent.`
          : ''
        pushToast('success', `Confirmed ${confirmedSwaps} swap${confirmedSwaps > 1 ? 's' : ''}.${closeSuffix}`)
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
      setBatchExecutionStatus(null)
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

  function renderTokenRow(token: Token, index: number, rowStyle?: CSSProperties) {
    const execution = sellResults[token.mint]
    const selected = selectedMints.has(token.mint)
    const sellable = isSellableToken(token)
    const verificationLevel = getVerificationLevel(token.metadata || null)
    const tradabilityStatus = tradabilityByMint[token.mint]
    const usdQuoteStatus = usdQuoteStatusByMint[token.mint]
    const tokenStatusLabel = sellable && tradabilityStatus === 'untradable'
      ? 'no-route'
      : sellable && tradabilityStatus === 'checking'
        ? 'checking'
        : verificationLevel
    const txUrl = execution?.signature ? `https://solscan.io/tx/${execution.signature}` : null
    const usdValue = tokenValueUsd(token)
    const usdValueResolving = usdQuoteStatus === 'checking' || usdQuoteStatus === 'unknown'
    const name = token.metadata
      ? getTokenDisplayName(token.mint, token.metadata)
      : 'Unknown'

    return (
      <div
        key={rowStyle ? undefined : token.mint}
        className={cn(!sellable && 'opacity-30')}
        style={rowStyle ?? {
          animation: `fadeUp 0.25s ease-out ${Math.min(index * 0.02, 0.5)}s both`,
        }}
      >
        <div
          className={cn(
            'grid grid-cols-[32px_1fr_90px] md:grid-cols-[32px_1fr_80px_100px_90px] gap-3 items-center py-3 border-b border-border/40 transition-all duration-150',
            selected
              ? 'bg-foreground/[0.04] border-l-2 border-l-primary pl-2.5 md:pl-0.5'
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
                  ? 'border-primary bg-primary'
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
                tokenStatusLabel === 'no-route'
                  ? 'text-[hsl(var(--status-warning))]'
                  : verificationLevel === 'strict' || verificationLevel === 'verified'
                  ? 'text-foreground/40'
                  : 'text-muted-foreground/60'
              )}>
                {tokenStatusLabel}
              </span>
            </div>
          </div>

          <div className="hidden md:block">
            <span className={cn(
              'font-mono text-[10px] uppercase tracking-wider',
              tokenStatusLabel === 'no-route'
                ? 'text-[hsl(var(--status-warning))]'
                : verificationLevel === 'strict' || verificationLevel === 'verified'
                ? 'text-foreground/50'
                : 'text-muted-foreground/60'
            )}>
              {tokenStatusLabel}
            </span>
          </div>

          <div className="hidden md:block text-right">
            <span className="font-mono text-xs tabular-nums">
              {formatTokenAmount(token.amount)}
            </span>
          </div>

          <div className="text-right">
            <span className={cn(
              'font-mono text-xs tabular-nums',
              usdValue !== null && usdValue < dustThresholdUsd && 'text-muted-foreground'
            )}>
              {usdValue !== null
                ? formatPrice(usdValue)
                : usdValueResolving ? '...' : '--'}
            </span>
            <span className="block md:hidden font-mono text-[10px] text-muted-foreground/50 tabular-nums">
              {formatTokenAmount(token.amount)}
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
  }

  return (
    <div hidden={!active}>
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
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Confirm sell and burn</div>
            <div className="text-sm leading-relaxed text-foreground">
              You&apos;re selling {selectedSellableCount} token{selectedSellableCount > 1 ? 's' : ''} for
              {' '}~{formatSolEstimate(sellEstimate.totalOutLamports)} SOL.
              {' '}Any emptied token accounts are closed automatically to reclaim rent.
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
                className="h-8 px-3 bg-primary text-primary-foreground text-[11px] uppercase tracking-wider hover:bg-[hsl(var(--primary-hover))] transition-colors disabled:opacity-30"
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
                    {loading || !allValuesResolved ? (
                      <span className="inline-block w-8 h-5 bg-muted-foreground/10" style={{ animation: 'shimmer 1.5s infinite linear', backgroundSize: '200% 100%', backgroundImage: 'linear-gradient(90deg, transparent 0%, hsl(var(--muted-foreground) / 0.08) 50%, transparent 100%)' }} />
                    ) : tokensWithValue.length}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5">
                    Sellable
                  </div>
                  <div className="text-lg tabular-nums leading-none">
                    {loading || !allValuesResolved ? (
                      <span className="inline-block w-8 h-5 bg-muted-foreground/10" style={{ animation: 'shimmer 1.5s infinite linear', backgroundSize: '200% 100%', backgroundImage: 'linear-gradient(90deg, transparent 0%, hsl(var(--muted-foreground) / 0.08) 50%, transparent 100%)' }} />
                    ) : sellableTokensWithValue.length}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5">
                    Portfolio
                  </div>
                  <div className="text-lg tabular-nums leading-none">
                    {loading || !allValuesResolved ? (
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

            {!loading && allValuesResolved && tokens.length > 0 && (
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
                  <Select
                    value={verificationFilter}
                    onChange={(v) => setVerificationFilter(v as VerificationFilter)}
                    disabled={isSelling}
                    options={[
                      { value: 'all', label: 'all' },
                      { value: 'unverified', label: 'unverified' },
                    ]}
                  />
                </div>

                <button
                  type="button"
                  onClick={() => setHideUnverifiedTokens(prev => !prev)}
                  disabled={isSelling}
                  className="h-7 px-2.5 border border-border text-xs font-mono uppercase tracking-wider hover:bg-accent hover:border-foreground/20 transition-all disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:border-border"
                >
                  {hideUnverifiedTokens ? 'show unverified' : 'hide unverified'}
                </button>

                <button
                  type="button"
                  onClick={() => setHideNoValueTokens(prev => !prev)}
                  disabled={isSelling}
                  className="h-7 px-2.5 border border-border text-xs font-mono uppercase tracking-wider hover:bg-accent hover:border-foreground/20 transition-all disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:border-border"
                >
                  {hideNoValueTokens ? 'show no-value' : 'hide no-value'}
                </button>

                <div className="flex items-center gap-1.5 bg-muted/50 h-7 px-2">
                  <span className="text-muted-foreground text-[10px] uppercase tracking-wider">sort</span>
                  <Select
                    value={sortBy}
                    onChange={(v) => setSortBy(v as TokenSort)}
                    disabled={isSelling}
                    options={[
                      { value: 'verification', label: 'verification' },
                      { value: 'value', label: 'value' },
                      { value: 'name', label: 'name' },
                    ]}
                  />
                </div>

                <div className="flex items-center gap-1.5 bg-muted/50 h-7 px-2">
                  <span className="text-muted-foreground text-[10px] uppercase tracking-wider">slip</span>
                  <Select
                    value={slippagePreset}
                    onChange={(v) => setSlippagePreset(v as SlippagePreset)}
                    disabled={isSelling}
                    options={[
                      { value: '0.5', label: '0.5%' },
                      { value: '1', label: '1%' },
                      { value: '3', label: '3%' },
                      { value: 'custom', label: 'custom' },
                    ]}
                  />
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
                  onClick={selectAllSellable}
                  disabled={isSelling || visibleSellableTokens.length === 0}
                  className="h-7 px-2.5 border border-border text-xs font-mono uppercase tracking-wider hover:bg-accent hover:border-foreground/20 transition-all disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:border-border"
                >
                  select all
                </button>
                <button
                  type="button"
                  onClick={clearSelection}
                  disabled={isSelling || selectedMints.size === 0}
                  className="h-7 px-2.5 border border-border text-xs font-mono uppercase tracking-wider hover:bg-accent hover:border-foreground/20 transition-all disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:border-border"
                >
                  clear all
                </button>

                <div className="flex-1" />

                {sellEstimate.error && (
                  <span className="text-[hsl(var(--status-warning))] text-[11px]">{sellEstimate.error}</span>
                )}

                {tradabilityChecksInFlight > 0 && (
                  <span className="text-muted-foreground text-[11px] hidden sm:inline">
                    quote checks {tradabilityChecksInFlight}
                  </span>
                )}

                {noValueNoRouteTokenCount > 0 && (
                  <span className="text-muted-foreground text-[11px] hidden sm:inline">
                    {noValueNoRouteTokenCount} junk hidden
                  </span>
                )}

                {verificationFilter !== 'unverified' && hideUnverifiedTokens && unverifiedTokenCount > 0 && (
                  <span className="text-muted-foreground text-[11px] hidden sm:inline">
                    {unverifiedTokenCount} unverified hidden
                  </span>
                )}

                {overDustThresholdTokenCount > 0 && (
                  <span className="text-muted-foreground text-[11px] hidden sm:inline">
                    {overDustThresholdTokenCount} above dust hidden
                  </span>
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
                    'bg-primary text-primary-foreground',
                    selectedSellableCount > 0 && !isSelling
                      ? 'hover:bg-[hsl(var(--primary-hover))] active:scale-[0.98]'
                      : '',
                    'disabled:opacity-15'
                  )}
                >
                  {isSelling ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <ArrowRight className="h-3 w-3" />
                  )}
                  sell and burn{selectedSellableCount > 0 ? ` ${selectedSellableCount}` : ''}
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
                      <span className="inline-block h-2 w-2 bg-primary/30" />
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
                        className="h-full bg-primary transition-all duration-700 ease-out"
                        style={{ width: `${sellProgress}%` }}
                      />
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-3 text-[11px]">
                      <span className="min-w-0 truncate">{activeExecutionLabel}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {Math.min(completedSellCount + (batchExecutionStatus ? 1 : 0), activeSellTargetCount)}/{activeSellTargetCount}
                      </span>
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
                <div className="relative overflow-hidden border border-[hsl(var(--primary))]/35 bg-[linear-gradient(132deg,hsl(var(--primary)/0.24)_0%,hsl(var(--background))_58%,hsl(var(--foreground)/0.08)_100%)] p-4 sm:p-5">
                  <div className="pointer-events-none absolute -right-8 -top-10 h-24 w-24 rounded-full bg-[hsl(var(--primary))]/20 blur-2xl" />
                  <div className="pointer-events-none absolute -left-10 bottom-0 h-20 w-20 rounded-full bg-foreground/10 blur-xl" />

                  <div className="relative flex flex-wrap items-center gap-2">
                    <div className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.22em] text-foreground/85">
                      <Sparkles className="h-3 w-3" />
                      Share Your Win
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

                  {previewUrl && (
                    <div className="relative mt-4 mx-auto w-full max-w-[420px] border border-foreground/10">
                      <img
                        src={previewUrl}
                        alt="Share card preview"
                        className="w-full h-auto"
                        draggable={false}
                      />
                    </div>
                  )}
                  {isGenerating && (
                    <div className="relative mt-4 flex items-center gap-2 font-mono text-[11px] text-foreground/50">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Generating image…
                    </div>
                  )}

                  <div className="relative mt-4 border border-foreground/15 bg-background/55 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-foreground/88">
                    {shareCaption}
                  </div>

                  <div className="relative mt-3 flex flex-wrap gap-2">
                    {canNativeShare ? (
                      <button
                        type="button"
                        onClick={() => {
                          void nativeShare(shareCaption)
                        }}
                        disabled={!previewUrl}
                        className="h-8 px-3 bg-[hsl(var(--primary))] text-background text-[11px] font-mono uppercase tracking-wider inline-flex items-center gap-1.5 hover:opacity-85 transition-opacity disabled:opacity-40"
                      >
                        <Share2 className="h-3 w-3" />
                        Share
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={downloadImage}
                        disabled={!previewUrl}
                        className="h-8 px-3 bg-[hsl(var(--primary))] text-background text-[11px] font-mono uppercase tracking-wider inline-flex items-center gap-1.5 hover:opacity-85 transition-opacity disabled:opacity-40"
                      >
                        <Download className="h-3 w-3" />
                        Download image
                      </button>
                    )}
	                    {shareIntentUrl && (
	                      <button
	                        type="button"
	                        onClick={() => {
	                          void shareOnX()
	                        }}
	                        disabled={isGenerating || isSharingOnX}
	                        className="h-8 px-3 bg-foreground text-background text-[11px] font-mono uppercase tracking-wider inline-flex items-center gap-1.5 hover:opacity-85 transition-opacity disabled:opacity-40"
	                      >
	                        {isSharingOnX ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
	                        {isSharingOnX ? 'Sharing...' : 'Share on X'}
	                        <ExternalLink className="h-3 w-3" />
	                      </button>
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
                        Sold {formatTokenAmount(activity.tokenAmount)} {activity.tokenLabel}
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
                <span className="font-mono text-xs text-muted-foreground">
                  Scanning wallet{tokens.length > 0 ? `... ${tokens.length} token${tokens.length === 1 ? '' : 's'} found` : '...'}
                </span>
              </div>
            ) : !allValuesResolved && tokens.length > 0 ? (
              <div className="py-24 flex flex-col items-center gap-4">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                <span className="font-mono text-xs text-muted-foreground">
                  Fetching token values... {valuesResolvedCount}/{sellableTokens.length}
                </span>
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

                  {shouldVirtualizeTokenRows ? (
                    <VariableSizeList
                      ref={tokenListVirtualizerRef}
                      height={virtualizedTokenListHeight}
                      width="100%"
                      itemCount={visibleTokens.length}
                      itemSize={getVirtualizedTokenRowHeight}
                      overscanCount={TOKEN_VIRTUAL_OVERSCAN}
                      itemKey={(index) => visibleTokens[index]?.mint ?? index}
                    >
                      {({ index, style }) => renderTokenRow(visibleTokens[index], index, style)}
                    </VariableSizeList>
                  ) : (
                    visibleTokens.map((token, index) => renderTokenRow(token, index))
                  )}
                </div>
              ) : (
                <div className="py-20 flex flex-col items-center gap-3">
                  <span className="font-mono text-xs text-muted-foreground">
                    {noValueNoRouteTokenCount > 0 || (hideUnverifiedTokens && unverifiedTokenCount > 0) || hideNoValueTokens || overDustThresholdTokenCount > 0
                      ? 'No tokens match current filters. Try raising the dust threshold, or using "show no-value" / "show unverified".'
                      : 'No tokens match current search/filter settings.'}
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


            <div className="h-24" />
          </div>
        ) : (
          <div
            className="max-w-[1000px] mx-auto px-6 flex flex-col justify-center min-h-[calc(100vh-49px)]"
            style={{ animation: 'fadeUp 0.5s ease-out' }}
          >
            <div className="max-w-[700px]">
              <div
                className="w-12 h-px bg-primary/50 mb-10"
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

      <Footer />
    </div>
  )
}
