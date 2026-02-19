import { lazy, Suspense, type MouseEvent } from 'react'
import { cn } from '@/lib/utils'

const WalletMultiButton = lazy(() =>
  import('@solana/wallet-adapter-react-ui').then((mod) => ({ default: mod.BaseWalletMultiButton }))
)

const NAVBAR_WALLET_LABELS = {
  'change-wallet': 'Change wallet',
  connecting: 'Connecting ...',
  'copy-address': 'Copy address',
  copied: 'Copied',
  disconnect: 'Disconnect',
  'has-wallet': 'Connect Wallet',
  'no-wallet': 'Connect Wallet',
} as const

function normalizePath(pathname: string): string {
  if (!pathname) return '/'
  if (pathname !== '/' && pathname.endsWith('/')) return pathname.slice(0, -1)
  return pathname
}

function navigateTo(path: string) {
  const normalizedPath = normalizePath(path)
  const currentPath = normalizePath(window.location.pathname)
  if (normalizedPath === currentPath) return

  window.history.pushState({}, '', normalizedPath)
  window.dispatchEvent(new Event('sol-squeeze:navigate'))
  window.scrollTo({ top: 0, behavior: 'auto' })
}

function isModifiedClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey
}

export default function Navbar() {
  const currentPath = normalizePath(typeof window !== 'undefined' ? window.location.pathname : '/')

  const handleNavigate = (path: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (isModifiedClick(event)) return
    event.preventDefault()
    navigateTo(path)
  }

  return (
    <nav className="sticky top-0 z-50 w-full bg-background/80 backdrop-blur-md border-b border-border">
      <div className="max-w-[1000px] mx-auto px-6 flex h-12 items-center justify-between">
        <a href="/" onClick={handleNavigate('/')} className="font-serif text-lg italic tracking-tight">
          Sol Squeeze
        </a>
        <div className="flex items-center gap-5">
          <a
            href="/"
            onClick={handleNavigate('/')}
            className={cn(
              'font-mono text-[11px] uppercase tracking-wider transition-colors',
              currentPath === '/' ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            Home
          </a>
          <a
            href="/how-it-works"
            onClick={handleNavigate('/how-it-works')}
            className={cn(
              'font-mono text-[11px] uppercase tracking-wider transition-colors',
              currentPath === '/how-it-works' ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            How it works
          </a>
          <Suspense fallback={<div className="h-8 w-28 border border-border" />}>
            <WalletMultiButton labels={NAVBAR_WALLET_LABELS} />
          </Suspense>
        </div>
      </div>
    </nav>
  )
}
