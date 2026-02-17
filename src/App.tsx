import { Providers } from './app/providers'
import { Home } from './app/page'
import { HowItWorksPage } from './app/how-it-works-page'

function normalizePath(pathname: string): string {
  if (!pathname) return '/'
  if (pathname !== '/' && pathname.endsWith('/')) return pathname.slice(0, -1)
  return pathname
}

export default function App() {
  const pathname = normalizePath(typeof window !== 'undefined' ? window.location.pathname : '/')
  const page = pathname === '/how-it-works' ? <HowItWorksPage /> : <Home />

  return (
    <Providers>
      {page}
    </Providers>
  )
}
