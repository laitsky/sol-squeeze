'use client'
import dynamic from 'next/dynamic'
import { cn } from '@/lib/utils'

const WalletMultiButtonDynamic = dynamic(
  () => import('@solana/wallet-adapter-react-ui').then((mod) => mod.WalletMultiButton),
  {
    ssr: false,
    loading: () => <div className="text-sm text-muted-foreground">Loading wallet...</div>
  }
)

export default function Navbar() {
  return (
    <nav className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-16 items-center justify-between max-w-6xl">
        <div className="flex items-center space-x-2">
          <h1 className="text-2xl font-bold bg-gradient-to-r from-primary to-purple-400 bg-clip-text text-transparent">
            Sol Vacuum
          </h1>
        </div>
        
        <div className="flex items-center space-x-4">
          <WalletMultiButtonDynamic />
        </div>
      </div>
    </nav>
  )
}