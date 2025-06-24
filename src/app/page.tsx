'use client'
import { useState, useEffect } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { Connection, GetProgramAccountsFilter, PublicKey } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { 
  Box, 
  VStack, 
  Heading, 
  Text, 
  Container, 
  Card, 
  CardBody, 
  SimpleGrid, 
  Badge, 
  Flex, 
  Spinner,
  Center,
  Icon,
  Image,
  Avatar,
  HStack,
  useColorModeValue
} from '@chakra-ui/react'
import { FaWallet, FaCoins } from 'react-icons/fa'
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
  
  const bgGradient = useColorModeValue(
    'linear(to-br, blue.50, purple.50)',
    'linear(to-br, gray.900, purple.900)'
  )
  const cardBg = useColorModeValue('white', 'gray.800')
  const borderColor = useColorModeValue('gray.200', 'gray.600')

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
      fetchedTokens.forEach(async (token, index) => {
        const metadata = await fetchTokenMetadata(token.mint);
        const isVerified = isTokenVerified(metadata);
        setTokens(prevTokens => {
          const updatedTokens = prevTokens.map((prevToken, prevIndex) => 
            prevIndex === index ? { ...prevToken, metadata, isVerified } : prevToken
          );
          // Sort tokens: strict > verified > community > unverified
          return updatedTokens.sort((a, b) => {
            // Get verification level for both tokens
            const aLevel = getVerificationLevel(a.metadata || null);
            const bLevel = getVerificationLevel(b.metadata || null);
            
            // Define sort priority: strict > verified > community > unverified (lower number = higher priority)
            const priority: Record<string, number> = { strict: 1, verified: 2, community: 3, unverified: 4 };
            
            // Get priority values with fallback to unverified (4) if not found
            const aPriority = priority[aLevel] ?? 4;
            const bPriority = priority[bLevel] ?? 4;
            
            // Sort by verification level first (primary sort)
            if (aPriority !== bPriority) {
              return aPriority - bPriority;
            }
            
            // If same verification level, sort by amount (highest to lowest) as secondary sort
            return (b.amount || 0) - (a.amount || 0);
          });
        });
      });

      // Fetch prices for all tokens in batch
      const mintAddresses = fetchedTokens.map(token => token.mint);
      const pricesMap = await fetchTokenPrices(mintAddresses);
      
      setTokens(prevTokens => 
        prevTokens.map(token => ({
          ...token,
          price: pricesMap.get(token.mint) || null,
          // Mark as price fetched (even if null) to stop showing "Loading..."
          priceFetched: true
        }))
      );
    } catch (error) {
        console.error('Error fetching tokens:', error);
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <Navbar />
      <Box minH="100vh" bgGradient={bgGradient}>
        <Container maxW="6xl" py={12}>
          <VStack spacing={10} align="stretch">
            <VStack spacing={4} textAlign="center">
              <Icon as={FaCoins} boxSize={12} color="purple.500" />
              <Heading size="2xl" bgGradient="linear(to-r, purple.600, blue.600)" bgClip="text">
                SOL Token Vacuum
              </Heading>
              <Text fontSize="lg" color="gray.600" maxW="2xl">
                Insert subhero text here 
              </Text>
            </VStack>

          {connected ? (
            <VStack spacing={6}>
              <Flex align="center" gap={3}>
                <Icon as={FaCoins} color="purple.500" />
                <Heading size="lg">Your Token Portfolio</Heading>
                {loading && <Spinner color="purple.500" />}
              </Flex>
              
              {loading ? (
                <Center py={12}>
                  <VStack spacing={4}>
                    <Spinner size="xl" color="purple.500" thickness="4px" />
                    <Text color="gray.600">Loading your tokens...</Text>
                  </VStack>
                </Center>
              ) : tokens.length > 0 ? (
                <SimpleGrid columns={{ base: 1, md: 2, lg: 3 }} spacing={6} w="full">
                  {tokens.map((token, index) => (
                    <Card 
                      key={index} 
                      bg={cardBg} 
                      shadow="lg" 
                      borderRadius="xl"
                      border="1px"
                      borderColor={borderColor}
                      _hover={{ 
                        transform: 'translateY(-4px)', 
                        shadow: '2xl',
                        borderColor: 'purple.300' 
                      }}
                      transition="all 0.3s"
                    >
                      <CardBody>
                        <VStack align="start" spacing={4}>
                          <Flex justify="space-between" align="center" w="full">
                            <HStack spacing={2}>
                              <Badge colorScheme="purple" fontSize="sm" px={3} py={1} borderRadius="full">
                                Token #{index + 1}
                              </Badge>
                              {token.metadata && (
                                <Badge 
                                  colorScheme={
                                    getVerificationLevel(token.metadata) === 'strict' ? 'green' :
                                    getVerificationLevel(token.metadata) === 'verified' ? 'blue' :
                                    getVerificationLevel(token.metadata) === 'community' ? 'orange' :
                                    'gray'
                                  }
                                  fontSize="xs" 
                                  px={2} 
                                  py={1} 
                                  borderRadius="full"
                                  variant={getVerificationLevel(token.metadata) === 'unverified' ? 'outline' : 'solid'}
                                >
                                  {getVerificationLevel(token.metadata).toUpperCase()}
                                </Badge>
                              )}
                            </HStack>
                            {token.price && (
                              <Text fontSize="sm" fontWeight="bold" color="green.600">
                                {formatPrice(token.price)}
                              </Text>
                            )}
                          </Flex>
                          
                          <HStack spacing={3} w="full">
                            <Avatar
                              size="md"
                              src={token.metadata?.logoURI}
                              name={token.metadata?.symbol || 'Token'}
                              bg="purple.100"
                              color="purple.600"
                            />
                            <VStack align="start" spacing={1} flex={1}>
                              <Text fontSize="md" fontWeight="semibold" color="gray.800">
                                {token.metadata ? 
                                  getTokenDisplayName(token.mint, token.metadata) : 
                                  'Loading...'
                                }
                              </Text>
                              <Text 
                                fontSize="xs" 
                                fontFamily="mono" 
                                color="gray.500"
                                wordBreak="break-all"
                              >
                                {token.mint}
                              </Text>
                            </VStack>
                          </HStack>
                          
                          <Flex justify="space-between" align="center" w="full">
                            <VStack align="start" spacing={1}>
                              <Text fontSize="sm" color="gray.500" fontWeight="medium">
                                Balance
                              </Text>
                              <Text fontSize="xl" fontWeight="bold" color="purple.600">
                                {token.amount?.toLocaleString() || '0'}
                              </Text>
                            </VStack>
                            
                            <VStack align="end" spacing={1}>
                              <Text fontSize="sm" color="gray.500" fontWeight="medium">
                                Value (USDC)
                              </Text>
                              <Text fontSize="lg" fontWeight="bold" color="green.600">
                                {(token.price && token.amount) ? 
                                  formatPrice(token.price * token.amount) : 
                                  token.priceFetched ? 'N/A' : 'Loading...'
                                }
                              </Text>
                            </VStack>
                          </Flex>
                        </VStack>
                      </CardBody>
                    </Card>
                  ))}
                </SimpleGrid>
              ) : (
                <Center py={12}>
                  <VStack spacing={4} textAlign="center">
                    <Icon as={FaCoins} boxSize={12} color="gray.400" />
                    <Text fontSize="lg" color="gray.500">
                      No tokens found in your wallet
                    </Text>
                    <Text color="gray.400">
                      Your SPL tokens will appear here once detected
                    </Text>
                  </VStack>
                </Center>
              )}
            </VStack>
          ) : (
            <Center py={12}>
              <VStack spacing={4} textAlign="center">
                <Icon as={FaWallet} boxSize={12} color="gray.400" />
                <Text fontSize="lg" color="gray.500">
                  Connect your wallet to get started
                </Text>
                <Text color="gray.400">
                  View and manage your SPL tokens with ease
                </Text>
              </VStack>
            </Center>
          )}
        </VStack>
      </Container>
    </Box>
    </>
  )
}
