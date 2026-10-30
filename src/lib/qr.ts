import QRCode from 'qrcode'

export async function qrDataUrl(text: string, width = 640): Promise<string> {
  return QRCode.toDataURL(text, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width,
    color: { dark: '#000000', light: '#ffffff' },
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const test = line ? `${line} ${word}` : word
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line)
      line = word
    } else {
      line = test
    }
  }
  if (line) lines.push(line)
  return lines.slice(0, 3)
}

/** Render a shareable pass image (QR + name + event) as a PNG blob. */
export async function renderPassImage(opts: {
  qr: string
  title: string
  subtitle: string
  lines: string[]
  footer?: string
}): Promise<Blob> {
  const W = 900
  const qrSize = 680
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas not supported')
  ctx.font = 'bold 52px system-ui, -apple-system, Segoe UI, Roboto, sans-serif'
  const titleLines = wrapText(ctx, opts.title, W - 120)
  const H = 140 + titleLines.length * 64 + 60 + opts.lines.length * 44 + qrSize + 160
  canvas.width = W
  canvas.height = H
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, W, H)

  let y = 110
  ctx.fillStyle = '#18181b'
  ctx.textAlign = 'center'
  ctx.font = 'bold 52px system-ui, -apple-system, Segoe UI, Roboto, sans-serif'
  for (const l of titleLines) {
    ctx.fillText(l, W / 2, y)
    y += 64
  }
  ctx.font = '600 36px system-ui, -apple-system, Segoe UI, Roboto, sans-serif'
  ctx.fillStyle = '#3f3f46'
  ctx.fillText(opts.subtitle, W / 2, y + 4)
  y += 56
  ctx.font = '30px system-ui, -apple-system, Segoe UI, Roboto, sans-serif'
  ctx.fillStyle = '#52525b'
  for (const l of opts.lines) {
    ctx.fillText(l, W / 2, y)
    y += 44
  }
  const img = await loadImage(opts.qr)
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(img, (W - qrSize) / 2, y, qrSize, qrSize)
  y += qrSize + 60
  if (opts.footer) {
    ctx.font = '600 30px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.fillStyle = '#18181b'
    ctx.fillText(opts.footer, W / 2, y)
  }
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not create image'))), 'image/png'),
  )
}

/** Share (mobile) or download (desktop) an image file. */
export async function saveImage(blob: Blob, filename: string): Promise<'shared' | 'downloaded'> {
  const file = new File([blob], filename, { type: 'image/png' })
  const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean }
  const coarse = window.matchMedia?.('(pointer: coarse)').matches
  if (coarse && nav.canShare?.({ files: [file] }) && nav.share) {
    try {
      await nav.share({ files: [file], title: filename })
      return 'shared'
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return 'shared'
    }
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return 'downloaded'
}

export function safeFilename(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'pass'
  )
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const [meta, b64 = ''] = dataUrl.split(',')
  const mime = /data:([^;]+)/.exec(meta ?? '')?.[1] ?? 'application/octet-stream'
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}
