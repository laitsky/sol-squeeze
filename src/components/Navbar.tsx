'use client'
import dynamic from 'next/dynamic'
import { 
  Box, 
  Flex, 
  Heading, 
  Container,
  useColorModeValue 
} from '@chakra-ui/react'

const WalletMultiButtonDynamic = dynamic(
  () => import('@solana/wallet-adapter-react-ui').then((mod) => mod.WalletMultiButton),
  {
    ssr: false,
    loading: () => <div className="wallet-loader">Loading wallet...</div>
  }
)

export default function Navbar() {
  const bgColor = useColorModeValue('white', 'gray.800')
  const borderColor = useColorModeValue('gray.200', 'gray.600')
  
  return (
    <Box 
      bg={bgColor} 
      borderBottom="1px" 
      borderColor={borderColor}
      shadow="sm"
      position="sticky"
      top={0}
      zIndex={1000}
    >
      <Container maxW="6xl">
        <Flex h={16} align="center" justify="space-between">
          <Heading 
            size="lg" 
            bgGradient="linear(to-r, purple.600, blue.600)" 
            bgClip="text"
            fontWeight="bold"
          >
            Sol Vacuum
          </Heading>
          
          <Box>
            <WalletMultiButtonDynamic />
          </Box>
        </Flex>
      </Container>
    </Box>
  )
}