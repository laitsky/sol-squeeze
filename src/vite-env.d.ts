/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SOLANA_RPC_URL: string
  readonly VITE_HELIUS_API_KEY: string
  readonly VITE_HELIUS_WALLET_API_URL: string
  readonly VITE_JUPITER_SWAP_API_URL: string
  readonly VITE_JUPITER_API_KEY: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
