import type { MouseEvent } from 'react'

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

export default function Footer() {
  const handleNavigate = (path: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (isModifiedClick(event)) return
    event.preventDefault()
    navigateTo(path)
  }

  return (
    <footer className="border-t border-border mt-auto">
      <div className="max-w-[1000px] mx-auto px-6 py-8">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-8">
          <div>
            <a
              href="/"
              onClick={handleNavigate('/')}
              className="font-serif text-lg italic tracking-tight hover:text-primary transition-colors"
            >
              Sol Squeeze
            </a>
            <p className="mt-2 font-mono text-[11px] text-muted-foreground leading-relaxed max-w-[280px]">
              Sweep low-value SPL tokens back to SOL in one batch.
            </p>
          </div>

          <div className="flex gap-12">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground mb-3">
                Navigate
              </div>
              <div className="flex flex-col gap-2">
                <a
                  href="/"
                  onClick={handleNavigate('/')}
                  className="font-mono text-[11px] text-foreground/70 hover:text-foreground transition-colors"
                >
                  Home
                </a>
                <a
                  href="/how-it-works"
                  onClick={handleNavigate('/how-it-works')}
                  className="font-mono text-[11px] text-foreground/70 hover:text-foreground transition-colors"
                >
                  How it works
                </a>
              </div>
            </div>

            <div>
              <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground mb-3">
                Socials
              </div>
              <div className="flex flex-col gap-2">
                <a
                  href="https://x.com/solsqueeze"
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[11px] text-foreground/70 hover:text-foreground transition-colors"
                >
                  X
                </a>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-8 pt-4 border-t border-border/50">
          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60">
            &copy; {new Date().getFullYear()} Sol Squeeze
          </span>
        </div>
      </div>
    </footer>
  )
}
