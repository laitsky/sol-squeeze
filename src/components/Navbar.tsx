import { lazy, Suspense } from 'react'

const WalletMultiButton = lazy(() =>
  import('@solana/wallet-adapter-react-ui').then((mod) => ({ default: mod.WalletMultiButton }))
)

export default function Navbar() {
  return (
    <nav className="sticky top-0 z-50 w-full bg-background/80 backdrop-blur-md border-b border-border">
      <div className="max-w-[1000px] mx-auto px-6 flex h-12 items-center justify-between">
        <span className="font-serif text-lg italic tracking-tight">Sol Vacuum</span>
        <Suspense fallback={<div className="h-8 w-28 border border-border" />}>
          <WalletMultiButton />
        </Suspense>
      </div>
    </nav>
  )
}
