import { useState } from 'react'
import { Check, Link2, Share2, X } from 'lucide-react'
import { copyText } from '../lib/clipboard'
import { Button, IconButton } from './ui'
import type { Size, Variant } from './ui/buttonStyles'

export function CopyButton({
  text,
  label = 'Copy link',
  variant = 'secondary',
  size = 'md',
  block,
  className,
}: {
  text: string
  label?: string
  variant?: Variant
  size?: Size
  block?: boolean
  className?: string
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  return (
    <Button
      variant={variant}
      size={size}
      block={block}
      className={className}
      icon={state === 'copied' ? Check : state === 'failed' ? X : Link2}
      onClick={async () => {
        const ok = await copyText(text)
        setState(ok ? 'copied' : 'failed')
        setTimeout(() => setState('idle'), 2000)
      }}
    >
      <span aria-live="polite">
        {state === 'copied' ? 'Copied!' : state === 'failed' ? 'Copy failed' : label}
      </span>
    </Button>
  )
}

/** Opens the phone's share sheet (WhatsApp, SMS…); copies the link where sharing isn't available. */
export function ShareButton({
  url,
  title,
  text,
  label = 'Share',
  variant = 'secondary',
  size = 'md',
  block,
  className,
  iconOnly,
}: {
  url: string
  title: string
  text?: string
  label?: string
  variant?: Variant
  size?: Size
  block?: boolean
  className?: string
  /** Square icon button; `label` becomes its accessible name. */
  iconOnly?: boolean
}) {
  const [copied, setCopied] = useState(false)
  async function onShare() {
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title, text, url })
        return
      } catch (e) {
        if ((e as Error).name === 'AbortError') return
      }
    }
    if (await copyText(url)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }
  if (iconOnly) {
    return (
      <IconButton
        variant={variant}
        size={size}
        className={className}
        icon={copied ? Check : Share2}
        label={copied ? 'Link copied' : label}
        onClick={() => void onShare()}
      />
    )
  }
  return (
    <Button
      variant={variant}
      size={size}
      block={block}
      className={className}
      icon={copied ? Check : Share2}
      onClick={() => void onShare()}
    >
      <span aria-live="polite">{copied ? 'Link copied' : label}</span>
    </Button>
  )
}
