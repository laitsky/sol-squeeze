'use client'

import { useEffect, useMemo, useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { Connection } from '@solana/web3.js'
import { Wallet, Coins, Loader2 } from 'lucide-react'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
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
  if (amount === null) return 'N/A'
  if (amount <= 0) return '0 SOL'
  if (amount < 0.000001) return '<0.000001 SOL'
  return `${amount.toLocaleString(undefined, { maximumFractionDigits: 6 })} SOL`
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
        error: quotedCount === 0 ? 'No quote available for the selected tokens.' : null,
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
      setSellSummary('Cannot sell tokens: NEXT_PUBLIC_SOLANA_RPC_URL is not configured.')
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
        updateSellResult(token.mint, { state: 'skipped', message: 'Token is not sellable.' })
        continue
      }

      const decimals = token.metadata?.decimals ?? 0
      const rawAmount = toRawAmount(token.amount, decimals)

      if (rawAmount === '0') {
        skipped += 1
        updateSellResult(token.mint, { state: 'skipped', message: 'Balance is too small to swap.' })
        continue
      }

      try {
        updateSellResult(token.mint, { state: 'building', message: 'Getting best swap route...' })
        const quoteResponse = await getJupiterQuote({
          inputMint: token.mint,
          outputMint: SOL_MINT,
          amount: rawAmount,
          slippageBps: 100,
        })

        updateSellResult(token.mint, { state: 'awaiting-signature', message: 'Approve this swap in your wallet.' })
        const { transaction, lastValidBlockHeight } = await buildJupiterSwapTransaction({
          quoteResponse,
          userPublicKey: publicKey.toBase58(),
        })

        const signature = await sendTransaction(transaction, connection, {
          skipPreflight: false,
          maxRetries: 3,
          preflightCommitment: 'confirmed',
        })

        updateSellResult(token.mint, { state: 'submitted', signature, message: 'Transaction submitted. Waiting for confirmation...' })

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
        updateSellResult(token.mint, { state: 'confirmed', signature, message: 'Swap confirmed.' })
      } catch (error) {
        failed += 1
        updateSellResult(token.mint, { state: 'failed', message: errorMessage(error) })
      }
    }

    setIsSelling(false)
    setSellSummary(`Batch complete: ${succeeded} sold, ${failed} failed, ${skipped} skipped.`)

    if (soldMints.size > 0) {
      setSelectedMints(prevSelected => {
        const nextSelected = new Set(prevSelected)
        soldMints.forEach(mint => nextSelected.delete(mint))
        return nextSelected
      })
      await fetchTokens(publicKey.toBase58())
    }
  }

  return (
    <>
      <Navbar />
      <main className="min-h-screen bg-gradient-to-br from-background via-background to-slate-900">
        <div className="container max-w-6xl mx-auto px-4 py-12">
          <div className="space-y-10">
            <div className="text-center space-y-4">
              <div className="flex justify-center mb-6">
                <div className="p-4 rounded-full bg-primary/10 border border-primary/20">
                  <Coins className="h-12 w-12 text-primary" />
                </div>
              </div>
              <h1 className="text-4xl md:text-6xl font-bold bg-gradient-to-r from-primary via-purple-300 to-blue-300 bg-clip-text text-transparent">
                SOL Token Vacuum
              </h1>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                Connect, select dust tokens, and sell them to SOL in one batch.
              </p>
            </div>

            {connected ? (
              <div className="space-y-8">
                <div className="flex items-center justify-center gap-3">
                  <Coins className="h-6 w-6 text-primary" />
                  <h2 className="text-2xl font-semibold">Your Token Portfolio</h2>
                  {(loading || isSelling) && <Loader2 className="h-5 w-5 text-primary animate-spin" />}
                </div>

                {!loading && tokens.length > 0 && (
                  <div className="space-y-3">
                    <div className="space-y-3 rounded-lg border border-border/60 bg-card/40 p-4">
                      <div className="text-sm text-muted-foreground">
                        <span className="font-semibold text-foreground">{selectedMints.size}</span> selected of{' '}
                        <span className="font-semibold text-foreground">{sellableTokens.length}</span> sellable tokens
                        {isSelling && <span className="ml-2">Approve swaps in your wallet as prompted.</span>}
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <label className="text-sm text-muted-foreground">Dust threshold (USD)</label>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={dustThresholdUsd}
                          onChange={(event) => {
                            const parsedValue = Number(event.target.value)
                            setDustThresholdUsd(Number.isFinite(parsedValue) ? parsedValue : 0)
                          }}
                          disabled={isSelling}
                          className="w-28 px-2 py-1 rounded-md border border-border/70 bg-background text-sm"
                        />
                        <button
                          type="button"
                          onClick={autoSelectDustTokens}
                          disabled={isSelling || sellableTokens.length === 0}
                          className="px-3 py-2 text-sm rounded-md border border-border/70 hover:bg-muted/40 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Auto-select Dust
                        </button>
                      </div>

                      <div className="text-sm text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1">
                        <span>
                          Estimated SOL out: <span className="font-semibold text-foreground">
                            {sellEstimate.loading ? 'Calculating...' : formatSolEstimate(sellEstimate.totalSol)}
                          </span>
                        </span>
                        <span>
                          Quotes: <span className="font-semibold text-foreground">{sellEstimate.quotedCount}</span>
                        </span>
                        <span>
                          Unquoted: <span className="font-semibold text-foreground">{sellEstimate.failedCount}</span>
                        </span>
                        <span>
                          Not estimated: <span className="font-semibold text-foreground">{sellEstimate.skippedCount}</span>
                        </span>
                        {sellEstimate.loading && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
                      </div>
                      {sellEstimate.error && (
                        <p className="text-xs text-amber-300">{sellEstimate.error}</p>
                      )}

                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={selectAllSellable}
                          disabled={isSelling || sellableTokens.length === 0}
                          className="px-3 py-2 text-sm rounded-md border border-border/70 hover:bg-muted/40 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Select All
                        </button>
                        <button
                          type="button"
                          onClick={clearSelection}
                          disabled={isSelling || selectedMints.size === 0}
                          className="px-3 py-2 text-sm rounded-md border border-border/70 hover:bg-muted/40 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Clear
                        </button>
                        <button
                          type="button"
                          onClick={sellSelectedTokens}
                          disabled={isSelling || selectedMints.size === 0}
                          className="px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
                        >
                          {isSelling && <Loader2 className="h-4 w-4 animate-spin" />}
                          Sell Selected ({selectedMints.size})
                        </button>
                      </div>
                    </div>
                    {sellSummary && (
                      <p className="text-sm text-muted-foreground">{sellSummary}</p>
                    )}
                  </div>
                )}

                {loading ? (
                  <div className="flex flex-col items-center justify-center py-20 space-y-4">
                    <Loader2 className="h-12 w-12 text-primary animate-spin" />
                    <p className="text-muted-foreground">Loading your tokens...</p>
                  </div>
                ) : tokens.length > 0 ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {tokens.map((token, index) => {
                      const execution = sellResults[token.mint]
                      const selected = selectedMints.has(token.mint)
                      const sellable = isSellableToken(token)
                      const verificationLevel = getVerificationLevel(token.metadata || null)
                      const txUrl = execution?.signature ? `https://solscan.io/tx/${execution.signature}` : null

                      return (
                        <Card
                          key={token.mint}
                          className="group hover:scale-105 transition-all duration-300 border-border/50 bg-card/50 backdrop-blur-sm hover:border-primary/30 hover:shadow-lg hover:shadow-primary/5"
                        >
                          <CardHeader className="pb-3">
                            <div className="flex justify-between items-start gap-2">
                              <div className="flex items-start gap-2">
                                <input
                                  type="checkbox"
                                  checked={selected}
                                  onChange={() => toggleMintSelection(token.mint)}
                                  disabled={isSelling || !sellable}
                                  className="h-4 w-4 mt-1 accent-primary disabled:cursor-not-allowed"
                                />
                                <div className="flex gap-2 flex-wrap">
                                  <Badge variant="default" className="bg-primary/10 text-primary border-primary/20">
                                    Token #{index + 1}
                                  </Badge>
                                  {token.metadata && (
                                    <Badge
                                      variant={
                                        verificationLevel === 'strict' ? 'success' :
                                          verificationLevel === 'verified' ? 'info' :
                                            verificationLevel === 'community' ? 'warning' :
                                              'outline'
                                      }
                                      className="text-xs"
                                    >
                                      {verificationLevel.toUpperCase()}
                                    </Badge>
                                  )}
                                  {!sellable && (
                                    <Badge variant="outline" className="text-xs">
                                      UNSUPPORTED
                                    </Badge>
                                  )}
                                  {execution && (
                                    <Badge variant={executionBadgeVariant(execution.state)} className="text-xs">
                                      {executionLabel(execution.state)}
                                    </Badge>
                                  )}
                                </div>
                              </div>
                              {token.price && (
                                <span className="text-sm font-bold text-emerald-300">
                                  {formatPrice(token.price)}
                                </span>
                              )}
                            </div>
                          </CardHeader>

                          <CardContent className="space-y-4">
                            <div className="flex items-center space-x-3">
                              <Avatar className="h-12 w-12 border-2 border-primary/20">
                                <AvatarImage src={token.metadata?.logoURI} />
                                <AvatarFallback className="bg-primary/10 text-primary font-bold">
                                  {token.metadata?.symbol?.charAt(0) || 'T'}
                                </AvatarFallback>
                              </Avatar>
                              <div className="flex-1 min-w-0">
                                <h3 className="font-semibold truncate">
                                  {token.metadata ?
                                    getTokenDisplayName(token.mint, token.metadata) :
                                    'Loading...'
                                  }
                                </h3>
                                <p className="text-xs font-mono text-muted-foreground truncate">
                                  {token.mint}
                                </p>
                              </div>
                            </div>

                            <div className="flex justify-between items-center pt-4 border-t border-border/50">
                              <div>
                                <p className="text-sm text-muted-foreground">Balance</p>
                                <p className="text-xl font-bold text-primary">
                                  {token.amount?.toLocaleString() || '0'}
                                </p>
                              </div>

                              <div className="text-right">
                                <p className="text-sm text-muted-foreground">Value (USDC)</p>
                                <p className="text-lg font-bold text-emerald-300">
                                  {(token.price && token.amount) ?
                                    formatPrice(token.price * token.amount) :
                                    token.priceFetched ? 'N/A' : 'Loading...'
                                  }
                                </p>
                              </div>
                            </div>

                            {execution && (
                              <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2">
                                <p className="text-xs text-muted-foreground break-words">{execution.message}</p>
                                {txUrl && (
                                  <a
                                    href={txUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-xs text-primary hover:underline"
                                  >
                                    View transaction
                                  </a>
                                )}
                              </div>
                            )}
                          </CardContent>
                        </Card>
                      )
                    })}
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-20 space-y-4 text-center">
                    <div className="p-4 rounded-full bg-muted/20 border border-border/50">
                      <Coins className="h-12 w-12 text-muted-foreground" />
                    </div>
                    <h3 className="text-lg font-semibold text-muted-foreground">
                      No tokens found in your wallet
                    </h3>
                    <p className="text-muted-foreground">
                      Your SPL tokens will appear here once detected
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-20 space-y-4 text-center">
                <div className="p-4 rounded-full bg-muted/20 border border-border/50">
                  <Wallet className="h-12 w-12 text-muted-foreground" />
                </div>
                <h3 className="text-lg font-semibold text-muted-foreground">
                  Connect your wallet to get started
                </h3>
                <p className="text-muted-foreground">
                  Scan wallet balances and batch-sell dust tokens in one flow
                </p>
              </div>
            )}
          </div>
        </div>
      </main>
    </>
  )
}
