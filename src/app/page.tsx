'use client'
import dynamic from 'next/dynamic'

import { useState, useEffect } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { Connection, GetProgramAccountsFilter, PublicKey } from '@solana/web3.js'
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
      console.log("public address: ", publicKey.toBase58())
      fetchTokens(publicKey)
    } else {
      setTokens([])
    }
  }, [connected, publicKey])

  async function fetchTokens(publicKey: PublicKey) {
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

      const fetchedTokens: Token[] = accounts.map((account, i) => {
        // Parse the account data
        const parsedAccountInfo: any = account.account.data;
        const mintAddress: string = parsedAccountInfo["parsed"]["info"]["mint"];
        const tokenBalance: number = parsedAccountInfo["parsed"]["info"]["tokenAmount"]["uiAmount"];
        // Log results
        console.log(`Token Account No. ${i + 1}: ${account.pubkey.toString()}`);
        console.log(`--Token Mint: ${mintAddress}`);
        console.log(`--Token Balance: ${tokenBalance}`);
        return { mint: mintAddress, amount: tokenBalance };
      });

      setTokens(fetchedTokens);
    } catch (error) {
        console.error('Error fetching tokens:', error);
    }
  }

  const WalletMultiButtonDynamic = dynamic(
    () => import('@solana/wallet-adapter-react-ui').then((mod) => mod.WalletMultiButton),
    {
      ssr: false,
      loading: () => <div className="wallet-loader">Loading wallet...</div>
    }
  )

  return (
    <Box p={8}>
      <VStack spacing={8} align="stretch">
        <Heading>SPL Token List</Heading>
        <WalletMultiButtonDynamic />
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
