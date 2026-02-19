/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SOLANA_RPC_URL: string
  readonly VITE_BACKEND_API_URL?: string
  readonly VITE_JUPITER_MAX_PRIORITY_FEE_LAMPORTS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
