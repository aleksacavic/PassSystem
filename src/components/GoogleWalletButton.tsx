import { useState } from 'react'
import { googleWalletSaveUrl } from '../lib/api'
import { env } from '../lib/env'
import { Spinner } from './ui'

/** Google Wallet runs on Android (and the web on desktop), not on iPhone/iPad. */
function walletSupported(): boolean {
  const ua = navigator.userAgent
  const iOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  return !iOS
}

export function GoogleWalletButton({ token }: { token: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!env.googleWallet || !walletSupported()) return null

  async function onClick() {
    setBusy(true)
    setError(null)
    try {
      window.location.assign(await googleWalletSaveUrl(token))
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        aria-busy={busy || undefined}
        className="flex min-h-14 w-full items-center justify-center gap-3 rounded-full bg-black px-6 text-lg font-semibold text-white hover:bg-inverse-raised disabled:opacity-60"
        data-testid="google-wallet"
      >
        {busy ? <Spinner className="size-5" /> : <WalletGlyph />}
        Add to Google Wallet
      </button>
      {error && (
        <p className="text-center text-sm text-danger-fg" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

function WalletGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="size-6" aria-hidden="true">
      <rect x="2" y="5" width="20" height="15" rx="3" fill="#fff" />
      <path d="M2 9h20" stroke="#4285F4" strokeWidth="2.2" />
      <path d="M2 12.5h20" stroke="#EA4335" strokeWidth="2.2" />
      <path d="M2 16h20" stroke="#FBBC04" strokeWidth="2.2" />
      <circle cx="17" cy="16.5" r="1.6" fill="#34A853" />
    </svg>
  )
}
