import Navbar from '../components/Navbar'
import Footer from '../components/Footer'

export function HowItWorksPage() {
  return (
    <>
      <Navbar />
      <main className="min-h-[calc(100vh-49px)] px-6 py-14">
        <div className="max-w-[1000px] mx-auto">
          <div className="max-w-[760px]">
            <div className="w-12 h-px bg-primary/50 mb-10" />
            <h1 className="font-serif italic text-[clamp(2.4rem,8vw,5rem)] leading-[0.95] tracking-tight mb-6">
              How Sol Squeeze<br />
              works
            </h1>
            <p className="font-mono text-sm text-muted-foreground leading-relaxed mb-10 max-w-[620px]">
              Swaps route through trusted liquidity, every transaction is signed in your wallet, and you stay in
              control from quote to final confirmation.
            </p>

            <section className="border border-border/60 bg-muted/20 p-6 mb-6">
              <h2 className="font-mono text-xs uppercase tracking-[0.18em] text-foreground/80 mb-4">Execution model</h2>
              <div className="space-y-3 font-mono text-xs text-muted-foreground leading-relaxed">
                <p>
                  Swaps are routed through Jupiter, a widely trusted Solana DEX aggregator, to source liquidity across
                  major venues.
                </p>
                <p>
                  Sol Squeeze is non-custodial: your wallet signs each transaction, and funds never leave your control
                  except for swaps and post-swap account closes that you explicitly approve.
                </p>
              </div>
            </section>

            <section className="border border-border/60 p-6">
              <h2 className="font-mono text-xs uppercase tracking-[0.18em] text-foreground/80 mb-4">Flow</h2>
              <div className="space-y-3 font-mono text-xs text-muted-foreground leading-relaxed">
                <p>1. Connect wallet and scan SPL balances.</p>
                <p>2. Choose which low-value tokens to sell and burn.</p>
                <p>3. Approve each swap in your wallet.</p>
                <p>4. After each successful swap, Sol Squeeze closes emptied token accounts to reclaim rent.</p>
                <p>5. Receive reclaimed SOL directly back to the same wallet.</p>
              </div>
            </section>

            <section className="border border-border/60 bg-muted/20 p-6 mt-6">
              <h2 className="font-mono text-xs uppercase tracking-[0.18em] text-foreground/80 mb-4">Fees</h2>
              <div className="space-y-2 font-mono text-xs text-muted-foreground leading-relaxed">
                <p>Platform fee: 0.3% (30 bps) per swap.</p>
                <p>The fee is included in swap routing and reflected in your quote.</p>
              </div>
            </section>
          </div>
        </div>
      </main>

      <Footer />
    </>
  )
}
