import { useState } from 'react'
import { copyText } from '../lib/clipboard'
import { Button } from './ui'

export function CopyButton({
  text,
  label = 'Copy link',
  variant = 'secondary',
  size = 'md',
  block,
}: {
  text: string
  label?: string
  variant?: 'primary' | 'secondary' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
  block?: boolean
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  return (
    <Button
      variant={variant}
      size={size}
      block={block}
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
