import { useEffect, useState } from 'react'
import { Providers } from './app/providers'
import { Home } from './app/page'
import { HowItWorksPage } from './app/how-it-works-page'

function normalizePath(pathname: string): string {
  if (!pathname) return '/'
  if (pathname !== '/' && pathname.endsWith('/')) return pathname.slice(0, -1)
  return pathname
}

function navigateTo(path: string) {
  if (window.location.pathname === path) return
  window.history.pushState({}, '', path)
  window.dispatchEvent(new CustomEvent('sol-squeeze:navigate'))
}

function NotFoundPage() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="text-center font-mono">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">404</p>
        <h1 className="mt-2 text-2xl">Page not found</h1>
        <button
          type="button"
          onClick={() => navigateTo('/')}
          className="mt-4 h-8 px-3 border border-border text-[11px] uppercase tracking-wider hover:bg-accent transition-colors"
        >
          Go home
        </button>
      </div>
    </main>
  )
}

export default function App() {
  const [pathname, setPathname] = useState(() =>
    normalizePath(typeof window !== 'undefined' ? window.location.pathname : '/')
  )

  useEffect(() => {
    const handleLocationChange = () => {
      setPathname(normalizePath(window.location.pathname))
    }

    window.addEventListener('popstate', handleLocationChange)
    window.addEventListener('sol-squeeze:navigate', handleLocationChange)
    return () => {
      window.removeEventListener('popstate', handleLocationChange)
      window.removeEventListener('sol-squeeze:navigate', handleLocationChange)
    }
  }, [])

  const isHome = pathname === '/'
  const isHowItWorks = pathname === '/how-it-works'
  const isNotFound = !isHome && !isHowItWorks

  return (
    <Providers>
      <Home active={isHome} />
      {isHowItWorks && <HowItWorksPage />}
      {isNotFound && <NotFoundPage />}
    </Providers>
  )
}
