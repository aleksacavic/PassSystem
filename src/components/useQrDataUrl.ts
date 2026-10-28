import { useEffect, useState } from 'react'
import { qrDataUrl } from '../lib/qr'

/** QR code PNG data URL for `text` (null while rendering or when text is empty). */
export function useQrDataUrl(text: string | null | undefined, width = 640): string | null {
  const [state, setState] = useState<{ key: string; url: string | null } | null>(null)
  const key = text ? `${width}:${text}` : null
  useEffect(() => {
    if (!text || !key) return
    let cancelled = false
    qrDataUrl(text, width)
      .then((url) => !cancelled && setState({ key, url }))
      .catch(() => !cancelled && setState({ key, url: null }))
    return () => {
      cancelled = true
    }
  }, [text, width, key])
  return key && state?.key === key ? state.url : null
}
