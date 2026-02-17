import Navbar from '../components/Navbar'

export function HowItWorksPage() {
  return (
    <>
      <Navbar />
      <main className="min-h-[calc(100vh-49px)] px-6 py-14">
        <div className="max-w-[1000px] mx-auto">
          <div className="max-w-[760px]">
            <div className="w-12 h-px bg-foreground/30 mb-10" />
            <h1 className="font-serif italic text-[clamp(2.4rem,8vw,5rem)] leading-[0.95] tracking-tight mb-6">
              How Sol Vacuum<br />
              works
            </h1>
            <p className="font-mono text-sm text-muted-foreground leading-relaxed mb-10 max-w-[620px]">
              Built for security-paranoid wallets: route through trusted liquidity, keep signing in your own wallet,
              and stay in full control from quote to confirmation.
            </p>

            <section className="border border-border/60 bg-muted/20 p-6 mb-6">
              <h2 className="font-mono text-xs uppercase tracking-[0.18em] text-foreground/80 mb-4">Execution model</h2>
              <div className="space-y-3 font-mono text-xs text-muted-foreground leading-relaxed">
                <p>
                  Swaps are routed through Jupiter, a widely trusted Solana DEX aggregator, to source liquidity across
                  major venues.
                </p>
                <p>
                  Sol Vacuum is non-custodial: your wallet signs each transaction, and funds never leave your control
                  except for the swaps you explicitly approve.
                </p>
              </div>
            </section>

            <section className="border border-border/60 p-6">
              <h2 className="font-mono text-xs uppercase tracking-[0.18em] text-foreground/80 mb-4">Flow</h2>
              <div className="space-y-3 font-mono text-xs text-muted-foreground leading-relaxed">
                <p>1. Connect wallet and scan SPL balances.</p>
                <p>2. Choose which low-value tokens to sell.</p>
                <p>3. Review quotes and approve transactions in your wallet.</p>
                <p>4. Receive SOL directly back to the same wallet.</p>
              </div>
            </section>
          </div>
        </div>
      </main>
    </>
  )
}
