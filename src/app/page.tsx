'use client'

import { useEffect, useMemo, useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { Connection } from '@solana/web3.js'
import { Loader2, ArrowRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'
import Navbar from '../components/Navbar'
import { fetchWalletTokenBalances, getTokenDisplayName, formatPrice, isTokenVerified, getVerificationLevel } from '../lib/tokenService'
import { buildJupiterSwapTransaction, getJupiterQuote, SOL_MINT, toRawAmount } from '../lib/swapService'

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

interface ExecutionResult {
  state: ExecutionState
  message: string
  signature?: string
}

interface SellEstimate {
  totalSol: number | null
  quotedCount: number
  failedCount: number
  skippedCount: number
  loading: boolean
  error: string | null
}

function sortTokensByVerificationAndValue(tokens: Token[]): Token[] {
  return tokens.sort((a, b) => {
    const aLevel = getVerificationLevel(a.metadata || null)
    const bLevel = getVerificationLevel(b.metadata || null)
    const verificationPriority: Record<string, number> = { strict: 1, verified: 2, community: 3, unverified: 4 }
    const aPriority = verificationPriority[aLevel] ?? 4
    const bPriority = verificationPriority[bLevel] ?? 4

    if (aPriority !== bPriority) {
      return aPriority - bPriority
    }

    const aUsdcValue = (a.price && a.amount) ? a.price * a.amount : null
    const bUsdcValue = (b.price && b.amount) ? b.price * b.amount : null

    if (aUsdcValue !== null && bUsdcValue !== null) {
      return bUsdcValue - aUsdcValue
    }
    if (aUsdcValue !== null && bUsdcValue === null) {
      return -1
    }
    if (aUsdcValue === null && bUsdcValue !== null) {
      return 1
    }

    return (b.amount || 0) - (a.amount || 0)
  })
}

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

function formatSolEstimate(amount: number | null): string {
  if (amount === null) return '--'
  if (amount <= 0) return '0'
  if (amount < 0.000001) return '<0.000001'
  return amount.toLocaleString(undefined, { maximumFractionDigits: 6 })
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

export default function Home() {
  const { publicKey, connected, sendTransaction } = useWallet()
  const [tokens, setTokens] = useState<Token[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedMints, setSelectedMints] = useState<Set<string>>(new Set())
  const [isSelling, setIsSelling] = useState(false)
  const [sellResults, setSellResults] = useState<Record<string, ExecutionResult>>({})
  const [sellSummary, setSellSummary] = useState<string | null>(null)
  const [dustThresholdUsd, setDustThresholdUsd] = useState(5)
  const [sellEstimate, setSellEstimate] = useState<SellEstimate>({
    totalSol: null,
    quotedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    loading: false,
    error: null,
  })

  useEffect(() => {
    if (connected && publicKey) {
      fetchTokens(publicKey.toBase58())
    } else {
      setTokens([])
      setSelectedMints(new Set())
      setSellResults({})
      setSellSummary(null)
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

  const totalPortfolioValue = useMemo(() => {
    return tokens.reduce((total, token) => {
      if (token.price && token.amount) {
        return total + token.price * token.amount
      }
      return total
    }, 0)
  }, [tokens])

  const sellProgress = useMemo(() => {
    if (!isSelling || selectedMints.size === 0) return 0
    return (Object.keys(sellResults).length / selectedMints.size) * 100
  }, [isSelling, sellResults, selectedMints])

  useEffect(() => {
    if (!connected || isSelling || selectedMints.size === 0) {
      setSellEstimate({
        totalSol: null,
        quotedCount: 0,
        failedCount: 0,
        skippedCount: 0,
        loading: false,
        error: null,
      })
      return
    }

    const selectedTokens = tokens.filter(token => selectedMints.has(token.mint) && isSellableToken(token))
    if (selectedTokens.length === 0) {
      setSellEstimate({
        totalSol: null,
        quotedCount: 0,
        failedCount: 0,
        skippedCount: 0,
        loading: false,
        error: null,
      })
      return
    }

    const ESTIMATE_MAX_TOKENS = 25
    const ESTIMATE_CONCURRENCY = 4
    const estimateTokens = selectedTokens.slice(0, ESTIMATE_MAX_TOKENS)
    const skippedCount = Math.max(0, selectedTokens.length - estimateTokens.length)

    let cancelled = false
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
              slippageBps: 100,
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

      let totalOutLamports = BigInt(0)
      let quotedCount = 0
      let failedCount = 0
      for (const result of estimateResults) {
        totalOutLamports += result.outLamports
        if (result.quoted) quotedCount += 1
        if (result.failed) failedCount += 1
      }

      if (cancelled) {
        return
      }

      const numericOut = Number(totalOutLamports)
      setSellEstimate({
        totalSol: Number.isFinite(numericOut) ? numericOut / 1_000_000_000 : null,
        quotedCount,
        failedCount,
        skippedCount,
        loading: false,
        error: quotedCount === 0 ? 'No quotes available.' : null,
      })
    }, 400)

    return () => {
      cancelled = true
      clearTimeout(timeoutId)
    }
  }, [connected, isSelling, selectedMints, tokens])

  async function fetchTokens(walletAddress: string) {
    setLoading(true)

    try {
      const fetchedTokens: Token[] = await fetchWalletTokenBalances(walletAddress)
      const walletTokens = fetchedTokens.map(token => ({
        ...token,
        isVerified: isTokenVerified(token.metadata || null),
      }))
      setTokens(sortTokensByVerificationAndValue(walletTokens))
    } catch (error) {
      console.error('Error fetching tokens:', error)
    } finally {
      setLoading(false)
    }
  }

  function updateSellResult(mint: string, result: ExecutionResult) {
    setSellResults(prev => ({
      ...prev,
      [mint]: result,
    }))
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
    setSelectedMints(new Set(sellableTokens.map(token => token.mint)))
  }

  function clearSelection() {
    setSelectedMints(new Set())
  }

  function autoSelectDustTokens() {
    const threshold = Math.max(0, dustThresholdUsd)
    const dustMints = sellableTokens
      .filter(token => {
        const usdValue = token.price && token.amount ? token.price * token.amount : null
        return usdValue !== null && usdValue <= threshold
      })
      .map(token => token.mint)

    setSelectedMints(new Set(dustMints))
  }

  async function sellSelectedTokens() {
    if (!connected || !publicKey || selectedMints.size === 0 || isSelling) {
      return
    }

    const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL
    if (!rpcUrl) {
      setSellSummary('RPC URL not configured.')
      return
    }

    const selectedTokens = tokens.filter(token => selectedMints.has(token.mint))
    if (selectedTokens.length === 0) {
      return
    }

    const connection = new Connection(rpcUrl, 'confirmed')
    const soldMints = new Set<string>()
    let succeeded = 0
    let failed = 0
    let skipped = 0

    setIsSelling(true)
    setSellSummary(null)
    setSellResults({})

    for (const token of selectedTokens) {
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
        const quoteResponse = await getJupiterQuote({
          inputMint: token.mint,
          outputMint: SOL_MINT,
          amount: rawAmount,
          slippageBps: 100,
        })

        updateSellResult(token.mint, { state: 'awaiting-signature', message: 'Sign in wallet.' })
        const { transaction, lastValidBlockHeight } = await buildJupiterSwapTransaction({
          quoteResponse,
          userPublicKey: publicKey.toBase58(),
        })

        const signature = await sendTransaction(transaction, connection, {
          skipPreflight: false,
          maxRetries: 3,
          preflightCommitment: 'confirmed',
        })

        updateSellResult(token.mint, { state: 'submitted', signature, message: 'Confirming...' })

        const confirmation = await connection.confirmTransaction(
          {
            signature,
            blockhash: transaction.message.recentBlockhash,
            lastValidBlockHeight,
          },
          'confirmed'
        )

        if (confirmation.value.err) {
          throw new Error(`On-chain error: ${JSON.stringify(confirmation.value.err)}`)
        }

        succeeded += 1
        soldMints.add(token.mint)
        updateSellResult(token.mint, { state: 'confirmed', signature, message: 'Done.' })
      } catch (error) {
        failed += 1
        updateSellResult(token.mint, { state: 'failed', message: errorMessage(error) })
      }
    }

    setIsSelling(false)
    setSellSummary(`${succeeded} sold, ${failed} failed, ${skipped} skipped.`)

    if (soldMints.size > 0) {
      setSelectedMints(prevSelected => {
        const nextSelected = new Set(prevSelected)
        soldMints.forEach(mint => nextSelected.delete(mint))
        return nextSelected
      })
      await fetchTokens(publicKey.toBase58())
    }
  }

  // ─── Derived: sell summary parsed ──────────────────────
  const parsedSummary = useMemo(() => {
    if (!sellSummary) return null
    const match = sellSummary.match(/(\d+) sold, (\d+) failed, (\d+) skipped/)
    if (!match) return null
    return { sold: Number(match[1]), failed: Number(match[2]), skipped: Number(match[3]) }
  }, [sellSummary])

  // ─── Render ──────────────────────────────────────────────

  return (
    <>
      <Navbar />
      <main className="min-h-screen">
        {connected ? (
          <div
            className="max-w-[1000px] mx-auto px-6"
            style={{ animation: 'fadeIn 0.3s ease-out' }}
          >

            {/* ── Summary metrics ─────────────────────────────── */}
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
                    {selectedMints.size > 0 ? 'Est. Output' : 'Selected'}
                  </div>
                  <div className="text-lg tabular-nums leading-none">
                    {selectedMints.size > 0 ? (
                      sellEstimate.loading ? (
                        <span className="text-muted-foreground flex items-center gap-2">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        </span>
                      ) : (
                        <span>{formatSolEstimate(sellEstimate.totalSol)} <span className="text-sm text-muted-foreground">SOL</span></span>
                      )
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* ── Controls toolbar ─────────────────────────────── */}
            {!loading && tokens.length > 0 && (
              <div className="py-4 border-b border-border flex flex-wrap items-center gap-2.5 font-mono text-xs">
                {/* Dust threshold group */}
                <div className="flex items-center gap-1.5 bg-muted/50 h-7 px-2">
                  <span className="text-muted-foreground text-[10px] uppercase tracking-wider">dust</span>
                  <span className="text-muted-foreground">&lt;</span>
                  <span className="text-muted-foreground">$</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={dustThresholdUsd}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      setDustThresholdUsd(Number.isFinite(v) ? v : 0)
                    }}
                    disabled={isSelling}
                    className="w-12 bg-transparent text-xs font-mono text-foreground focus:outline-none disabled:opacity-40 tabular-nums"
                  />
                </div>

                <button
                  type="button"
                  onClick={autoSelectDustTokens}
                  disabled={isSelling || sellableTokens.length === 0}
                  className="h-7 px-2.5 border border-border text-xs font-mono uppercase tracking-wider hover:bg-accent hover:border-foreground/20 transition-all disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:border-border"
                >
                  auto-select
                </button>

                <div className="w-px h-4 bg-border mx-0.5" />

                <button
                  type="button"
                  onClick={selectAllSellable}
                  disabled={isSelling || sellableTokens.length === 0}
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

                {selectedMints.size > 0 && !sellEstimate.loading && sellEstimate.quotedCount > 0 && (
                  <span className="text-muted-foreground text-[11px] hidden sm:inline">
                    {sellEstimate.quotedCount} quoted
                  </span>
                )}

                <button
                  type="button"
                  onClick={sellSelectedTokens}
                  disabled={isSelling || selectedMints.size === 0}
                  className={cn(
                    "h-8 px-4 text-xs font-mono uppercase tracking-wider transition-all inline-flex items-center gap-2",
                    "bg-foreground text-background",
                    selectedMints.size > 0 && !isSelling
                      ? "hover:opacity-80 active:scale-[0.98]"
                      : "",
                    "disabled:opacity-15"
                  )}
                >
                  {isSelling ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <ArrowRight className="h-3 w-3" />
                  )}
                  sell{selectedMints.size > 0 ? ` ${selectedMints.size}` : ''}
                </button>
              </div>
            )}

            {/* ── Sell progress ─────────────────────────────────── */}
            {isSelling && (
              <div className="py-4 border-b border-border font-mono text-xs text-muted-foreground">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2.5">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-foreground" />
                    <span>Approve each swap in your wallet</span>
                  </div>
                  <span className="tabular-nums text-foreground">
                    {Object.keys(sellResults).length}/{selectedMints.size}
                  </span>
                </div>
                <div className="h-1 bg-border relative overflow-hidden">
                  <div
                    className="h-full bg-foreground transition-all duration-700 ease-out"
                    style={{ width: `${sellProgress}%` }}
                  />
                </div>
              </div>
            )}

            {/* ── Sell summary ──────────────────────────────────── */}
            {parsedSummary && (
              <div
                className="py-3.5 border-b border-border font-mono text-xs flex items-center gap-4"
                style={{ animation: 'fadeUp 0.3s ease-out' }}
              >
                {parsedSummary.sold > 0 && (
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block w-1.5 h-1.5 bg-[hsl(var(--status-success))]" />
                    <span>{parsedSummary.sold} sold</span>
                  </span>
                )}
                {parsedSummary.failed > 0 && (
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block w-1.5 h-1.5 bg-[hsl(var(--status-error))]" />
                    <span>{parsedSummary.failed} failed</span>
                  </span>
                )}
                {parsedSummary.skipped > 0 && (
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block w-1.5 h-1.5 bg-muted-foreground/40" />
                    <span className="text-muted-foreground">{parsedSummary.skipped} skipped</span>
                  </span>
                )}
              </div>
            )}

            {/* ── Token table ──────────────────────────────────── */}
            {loading ? (
              <div className="py-24 flex flex-col items-center gap-4">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                <span className="font-mono text-xs text-muted-foreground">Scanning wallet...</span>
              </div>
            ) : tokens.length > 0 ? (
              <div>
                {/* Header */}
                <div className="hidden md:grid grid-cols-[32px_1fr_80px_100px_90px] gap-3 items-center px-1 py-2.5 border-b border-border text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                  <div />
                  <div>Token</div>
                  <div>Status</div>
                  <div className="text-right">Balance</div>
                  <div className="text-right">Value</div>
                </div>

                {/* Rows */}
                {tokens.map((token, index) => {
                  const execution = sellResults[token.mint]
                  const selected = selectedMints.has(token.mint)
                  const sellable = isSellableToken(token)
                  const verificationLevel = getVerificationLevel(token.metadata || null)
                  const txUrl = execution?.signature ? `https://solscan.io/tx/${execution.signature}` : null
                  const usdValue = (token.price && token.amount) ? token.price * token.amount : null
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
                      {/* Main row */}
                      <div
                        className={cn(
                          "grid grid-cols-[32px_1fr_90px] md:grid-cols-[32px_1fr_80px_100px_90px] gap-3 items-center py-3 border-b border-border/40 transition-all duration-150",
                          selected
                            ? "bg-foreground/[0.04] border-l-2 border-l-foreground pl-2.5 md:pl-0.5"
                            : "border-l-2 border-l-transparent pl-2.5 md:pl-0.5",
                          sellable && !isSelling && "hover:bg-foreground/[0.025] cursor-pointer"
                        )}
                        onClick={() => sellable && !isSelling && toggleMintSelection(token.mint)}
                      >
                        {/* Checkbox */}
                        <div className="flex justify-center">
                          <div
                            className={cn(
                              "w-4 h-4 border flex items-center justify-center transition-all duration-150",
                              selected
                                ? "border-foreground bg-foreground"
                                : "border-muted-foreground/25 hover:border-muted-foreground/50",
                              isSelling && "opacity-40"
                            )}
                          >
                            {selected && (
                              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                                <path d="M2 5L4 7L8 3" stroke="hsl(var(--background))" strokeWidth="1.5" strokeLinecap="square" />
                              </svg>
                            )}
                          </div>
                        </div>

                        {/* Token info */}
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
                            {/* Mobile: verification inline */}
                            <span className={cn(
                              "font-mono text-[9px] uppercase tracking-wider md:hidden",
                              verificationLevel === 'strict' || verificationLevel === 'verified'
                                ? "text-foreground/40"
                                : "text-muted-foreground/30"
                            )}>
                              {verificationLevel}
                            </span>
                          </div>
                        </div>

                        {/* Verification - desktop */}
                        <div className="hidden md:block">
                          <span className={cn(
                            "font-mono text-[10px] uppercase tracking-wider",
                            verificationLevel === 'strict' || verificationLevel === 'verified'
                              ? "text-foreground/50"
                              : "text-muted-foreground/30"
                          )}>
                            {verificationLevel}
                          </span>
                        </div>

                        {/* Balance - desktop */}
                        <div className="hidden md:block text-right">
                          <span className="font-mono text-xs tabular-nums">
                            {token.amount?.toLocaleString() || '0'}
                          </span>
                        </div>

                        {/* Value */}
                        <div className="text-right">
                          <span className={cn(
                            "font-mono text-xs tabular-nums",
                            usdValue !== null && usdValue < dustThresholdUsd && "text-muted-foreground"
                          )}>
                            {usdValue !== null
                              ? formatPrice(usdValue)
                              : token.priceFetched ? '--' : '...'}
                          </span>
                          {/* Mobile: balance underneath */}
                          <span className="block md:hidden font-mono text-[10px] text-muted-foreground/50 tabular-nums">
                            {token.amount?.toLocaleString() || '0'}
                          </span>
                        </div>
                      </div>

                      {/* Execution detail row */}
                      {execution && (
                        <div
                          className="py-2.5 pl-[44px] pr-1 border-b border-border/20 font-mono text-[11px] text-muted-foreground flex items-center gap-2.5 bg-muted/30"
                          style={{ animation: 'fadeIn 0.2s ease-out' }}
                        >
                          <Badge variant={executionBadgeVariant(execution.state)}>
                            {executionLabel(execution.state)}
                          </Badge>
                          <span className="truncate">{execution.message}</span>
                          {txUrl && (
                            <a
                              href={txUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="shrink-0 underline underline-offset-2 hover:text-foreground transition-colors"
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
              <div className="py-32 flex flex-col items-center gap-3">
                <span className="font-mono text-xs text-muted-foreground">No tokens found in this wallet.</span>
              </div>
            )}

            {/* Bottom padding */}
            <div className="h-24" />
          </div>
        ) : (
          /* ─── Disconnected: Swiss poster ───────────────────── */
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
              <div className="flex items-center gap-3 font-mono text-[11px] text-muted-foreground/60">
                <ArrowRight className="h-3 w-3" />
                <span>Connect wallet to begin</span>
              </div>
            </div>
          </div>
        )}
      </main>
    </>
  )
}
