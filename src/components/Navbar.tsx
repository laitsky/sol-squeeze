'use client'
import dynamic from 'next/dynamic'

const WalletMultiButtonDynamic = dynamic(
  () => import('@solana/wallet-adapter-react-ui').then((mod) => mod.WalletMultiButton),
  {
    ssr: false,
    loading: () => <div className="h-8 w-28 bg-muted" style={{ animation: 'shimmer 1.5s infinite linear', backgroundSize: '200% 100%', backgroundImage: 'linear-gradient(90deg, transparent 0%, hsl(0 0% 15%) 50%, transparent 100%)' }} />
  }
)

export default function Navbar() {
  return (
    <nav className="sticky top-0 z-50 w-full bg-background/80 backdrop-blur-md border-b border-border">
      <div className="max-w-[1000px] mx-auto px-6 flex h-12 items-center justify-between">
        <span className="font-serif text-lg italic tracking-tight">Sol Vacuum</span>
        <WalletMultiButtonDynamic />
      </div>
    </nav>
  )
}
