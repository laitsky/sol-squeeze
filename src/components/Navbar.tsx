import { lazy, Suspense } from 'react'
import { cn } from '@/lib/utils'

const WalletMultiButton = lazy(() =>
  import('@solana/wallet-adapter-react-ui').then((mod) => ({ default: mod.WalletMultiButton }))
)

function normalizePath(pathname: string): string {
  if (!pathname) return '/'
  if (pathname !== '/' && pathname.endsWith('/')) return pathname.slice(0, -1)
  return pathname
}

export default function Navbar() {
  const currentPath = normalizePath(typeof window !== 'undefined' ? window.location.pathname : '/')

  return (
    <nav className="sticky top-0 z-50 w-full bg-background/80 backdrop-blur-md border-b border-border">
      <div className="max-w-[1000px] mx-auto px-6 flex h-12 items-center justify-between">
        <a href="/" className="font-serif text-lg italic tracking-tight">
          Sol Vacuum
        </a>
        <div className="flex items-center gap-5">
          <a
            href="/"
            className={cn(
              'font-mono text-[11px] uppercase tracking-wider transition-colors',
              currentPath === '/' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            Home
          </a>
          <a
            href="/how-it-works"
            className={cn(
              'font-mono text-[11px] uppercase tracking-wider transition-colors',
              currentPath === '/how-it-works' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            How it works
          </a>
          <Suspense fallback={<div className="h-8 w-28 border border-border" />}>
            <WalletMultiButton />
          </Suspense>
        </div>
      </div>
    </nav>
  )
}
