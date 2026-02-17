# sol-vacuum

Client-side Solana app to scan wallet SPL balances and swap selected dust tokens to SOL using Jupiter.

## Requirements

- Bun `1.3+`
- A Solana RPC URL
- A Helius API key (or RPC URL with `api-key` query parameter)

## Setup

1. Install dependencies:

```bash
bun install
```

2. Copy env file and fill values:

```bash
cp .env.example .env.local
```

## Environment Variables

- `VITE_SOLANA_RPC_URL` - Solana RPC endpoint.
- `VITE_HELIUS_API_KEY` - Helius API key (optional if embedded in `VITE_SOLANA_RPC_URL`).
- `VITE_HELIUS_WALLET_API_URL` - Wallet API base URL (default `https://api.helius.xyz`).
- `VITE_JUPITER_SWAP_API_URL` - Jupiter API base URL (default `https://api.jup.ag`).
- `VITE_JUPITER_API_KEY` - Optional Jupiter API key.
- `VITE_JUPITER_MAX_PRIORITY_FEE_LAMPORTS` - Optional per-swap max priority fee cap. Default is `0`.

## Scripts

- `bun run dev` - Start Vite dev server on port `3000`.
- `bun run lint` - Typecheck (`tsc --noEmit`).
- `bun run build` - Typecheck and production build.
- `bun run preview` - Preview production build.
