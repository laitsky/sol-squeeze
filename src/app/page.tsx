'use client'
import { useState, useEffect } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { Connection, GetProgramAccountsFilter, PublicKey } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { Wallet, Coins, Loader2 } from 'lucide-react'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import Navbar from '../components/Navbar'
import { fetchTokenMetadata, getTokenDisplayName, fetchTokenPrices, formatPrice, isTokenVerified, getVerificationLevel } from '../lib/tokenService'

interface TokenMetadata {
  name: string;
  symbol: string;
  decimals: number;
  logoURI?: string;
  address: string;
  tags?: string[];
}

interface Token {
  mint: string
  amount: number
  metadata?: TokenMetadata | null
  price?: number | null
  isVerified?: boolean
  priceFetched?: boolean
}

export default function Home() {
  const { publicKey, connected } = useWallet()
  const [tokens, setTokens] = useState<Token[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (connected && publicKey) {
      console.log("public address: ", publicKey.toBase58())
      fetchTokens(publicKey)
    } else {
      setTokens([])
    }
  }, [connected, publicKey])

  async function fetchTokens(publicKey: PublicKey) {
    setLoading(true)
    const connection = new Connection(process.env.NEXT_PUBLIC_SOLANA_RPC_URL as string)

    const filters: GetProgramAccountsFilter[] = [
      {
        dataSize: 165,
      },
      {
        memcmp: {
          offset: 32,
          bytes: publicKey.toString()
        }
      }
    ];

    try {
      const accounts = await connection.getParsedProgramAccounts(TOKEN_PROGRAM_ID, { filters })
      console.log(`Found ${accounts.length} token account(s) for wallet ${publicKey.toBase58()}.`);

      const fetchedTokens: Token[] = accounts
        .map((account, i) => {
          // Parse the account data
          const parsedAccountInfo: any = account.account.data;
          const mintAddress: string = parsedAccountInfo["parsed"]["info"]["mint"];
          const tokenBalance: number = parsedAccountInfo["parsed"]["info"]["tokenAmount"]["uiAmount"];
          return { mint: mintAddress, amount: tokenBalance };
        })
        .filter(token => token.amount > 0);

      setTokens(fetchedTokens);

      // Fetch metadata for each token
      // FIX: Use mint address as unique identifier instead of array index to prevent
      // race condition where async metadata loading causes token data mismatch
      // after array sorting. Previously, when tokens were sorted after metadata loaded,
      // the array indices would change but async callbacks still used original indices,
      // leading to wrong metadata being applied to wrong tokens.
      fetchedTokens.forEach(async (token) => {
        const metadata = await fetchTokenMetadata(token.mint);
        const isVerified = isTokenVerified(metadata);
        setTokens(prevTokens => {
          // Find and update the specific token by mint address, not by index
          // This ensures the correct token gets updated even after sorting
          const updatedTokens = prevTokens.map((prevToken) => 
            prevToken.mint === token.mint ? { ...prevToken, metadata, isVerified } : prevToken
          );
          // Sort tokens: verification status first, then by USDC value/amount
          return updatedTokens.sort((a, b) => {
            // Get verification level for both tokens
            const aLevel = getVerificationLevel(a.metadata || null);
            const bLevel = getVerificationLevel(b.metadata || null);
            
            // Define verification priority: strict > verified > community > unverified (lower number = higher priority)
            const verificationPriority: Record<string, number> = { strict: 1, verified: 2, community: 3, unverified: 4 };
            
            // Get priority values with fallback to unverified (4) if not found
            const aPriority = verificationPriority[aLevel] ?? 4;
            const bPriority = verificationPriority[bLevel] ?? 4;
            
            // Primary sort: by verification level first
            if (aPriority !== bPriority) {
              return aPriority - bPriority;
            }
            
            // Secondary sort: within same verification level, sort by USDC value/amount
            // Calculate USDC values
            const aUsdcValue = (a.price && a.amount) ? a.price * a.amount : null;
            const bUsdcValue = (b.price && b.amount) ? b.price * b.amount : null;
            
            // If both have USDC value, sort by highest value first
            if (aUsdcValue !== null && bUsdcValue !== null) {
              return bUsdcValue - aUsdcValue;
            }
            
            // Tokens with USDC value come before those without
            if (aUsdcValue !== null && bUsdcValue === null) {
              return -1;
            }
            if (aUsdcValue === null && bUsdcValue !== null) {
              return 1;
            }
            
            // Finally, sort by token amount (highest first) for tokens without USDC value
            return (b.amount || 0) - (a.amount || 0);
          });
        });
      });

      // Fetch prices for all tokens in batch
      const mintAddresses = fetchedTokens.map(token => token.mint);
      const pricesMap = await fetchTokenPrices(mintAddresses);
      
      setTokens(prevTokens => {
        const updatedTokens = prevTokens.map(token => ({
          ...token,
          price: pricesMap.get(token.mint) || null,
          // Mark as price fetched (even if null) to stop showing "Loading..."
          priceFetched: true
        }));
        
        // Re-sort after prices are fetched to maintain verification + value ordering
        return updatedTokens.sort((a, b) => {
          // Get verification level for both tokens
          const aLevel = getVerificationLevel(a.metadata || null);
          const bLevel = getVerificationLevel(b.metadata || null);
          
          // Define verification priority: strict > verified > community > unverified (lower number = higher priority)
          const verificationPriority: Record<string, number> = { strict: 1, verified: 2, community: 3, unverified: 4 };
          
          // Get priority values with fallback to unverified (4) if not found
          const aPriority = verificationPriority[aLevel] ?? 4;
          const bPriority = verificationPriority[bLevel] ?? 4;
          
          // Primary sort: by verification level first
          if (aPriority !== bPriority) {
            return aPriority - bPriority;
          }
          
          // Secondary sort: within same verification level, sort by USDC value/amount
          // Calculate USDC values
          const aUsdcValue = (a.price && a.amount) ? a.price * a.amount : null;
          const bUsdcValue = (b.price && b.amount) ? b.price * b.amount : null;
          
          // If both have USDC value, sort by highest value first
          if (aUsdcValue !== null && bUsdcValue !== null) {
            return bUsdcValue - aUsdcValue;
          }
          
          // Tokens with USDC value come before those without
          if (aUsdcValue !== null && bUsdcValue === null) {
            return -1;
          }
          if (aUsdcValue === null && bUsdcValue !== null) {
            return 1;
          }
          
          // Finally, sort by token amount (highest first) for tokens without USDC value
          return (b.amount || 0) - (a.amount || 0);
        });
      });
    } catch (error) {
        console.error('Error fetching tokens:', error);
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <Navbar />
      <main className="min-h-screen bg-gradient-to-br from-background via-background to-slate-900">
        <div className="container max-w-6xl mx-auto px-4 py-12">
          <div className="space-y-10">
            {/* Hero Section */}
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
                Discover and manage your Solana token portfolio with style and elegance
              </p>
            </div>

            {connected ? (
              <div className="space-y-8">
                <div className="flex items-center justify-center gap-3">
                  <Coins className="h-6 w-6 text-primary" />
                  <h2 className="text-2xl font-semibold">Your Token Portfolio</h2>
                  {loading && <Loader2 className="h-5 w-5 text-primary animate-spin" />}
                </div>
                
                {loading ? (
                  <div className="flex flex-col items-center justify-center py-20 space-y-4">
                    <Loader2 className="h-12 w-12 text-primary animate-spin" />
                    <p className="text-muted-foreground">Loading your tokens...</p>
                  </div>
                ) : tokens.length > 0 ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {tokens.map((token, index) => (
                      <Card 
                        key={index} 
                        className="group hover:scale-105 transition-all duration-300 border-border/50 bg-card/50 backdrop-blur-sm hover:border-primary/30 hover:shadow-lg hover:shadow-primary/5"
                      >
                        <CardHeader className="pb-3">
                          <div className="flex justify-between items-start">
                            <div className="flex gap-2 flex-wrap">
                              <Badge variant="default" className="bg-primary/10 text-primary border-primary/20">
                                Token #{index + 1}
                              </Badge>
                              {token.metadata && (
                                <Badge 
                                  variant={
                                    getVerificationLevel(token.metadata) === 'strict' ? 'success' :
                                    getVerificationLevel(token.metadata) === 'verified' ? 'info' :
                                    getVerificationLevel(token.metadata) === 'community' ? 'warning' :
                                    'outline'
                                  }
                                  className="text-xs"
                                >
                                  {getVerificationLevel(token.metadata).toUpperCase()}
                                </Badge>
                              )}
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
                        </CardContent>
                      </Card>
                    ))}
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
                  View and manage your SPL tokens with style and elegance
                </p>
              </div>
            )}
          </div>
        </div>
      </main>
    </>
  )
}
