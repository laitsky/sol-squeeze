'use client'
import dynamic from 'next/dynamic'

import { useState, useEffect } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import { Connection, PublicKey } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { Box, VStack, Heading, Text, List, ListItem } from '@chakra-ui/react'

interface Token {
  mint: string
  amount: number
}

export default function Home() {
  const { publicKey, connected } = useWallet()
  const [tokens, setTokens] = useState<Token[]>([])

  useEffect(() => {
    if (connected && publicKey) {
      fetchTokens()
    }
  }, [connected, publicKey])

  async function fetchTokens() {
    const connection = new Connection('https://api.mainnet-beta.solana.com')
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      publicKey as PublicKey,
      {
        programId: TOKEN_PROGRAM_ID,
      }
    )

    const tokenList = tokenAccounts.value.map((accountInfo) => ({
      mint: accountInfo.account.data.parsed.info.mint,
      amount: accountInfo.account.data.parsed.info.tokenAmount.uiAmount,
    }))

    setTokens(tokenList)
  }

  return (
    <Box p={8}>
      <VStack spacing={8} align="stretch">
        <Heading>SPL Token List</Heading>
        <WalletMultiButton />
        {connected ? (
          <List spacing={3}>
            {tokens.map((token, index) => (
              <ListItem key={index}>
                <Text>Mint: {token.mint}</Text>
                <Text>Amount: {token.amount}</Text>
              </ListItem>
            ))}
          </List>
        ) : (
          <Text>Please connect your wallet to view your SPL tokens.</Text>
        )}
      </VStack>
    </Box>
  )
}