import QRCode from 'qrcode'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Write a Y4M video (what Chromium's fake camera plays) showing a QR code for
 * `text`, slightly offset from centre on a grey background like a phone screen.
 */
export function writeQrVideo(text: string, file: string, frames = 10): string {
  const W = 640
  const H = 480
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' })
  const n = qr.modules.size
  const quiet = 4
  const scale = Math.floor(340 / (n + quiet * 2))
  const size = scale * (n + quiet * 2)
  const ox = Math.floor((W - size) / 2) + 12
  const oy = Math.floor((H - size) / 2) - 6
  const Y = Buffer.alloc(W * H, 110) // grey surroundings
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const mx = Math.floor(x / scale) - quiet
      const my = Math.floor(y / scale) - quiet
      const dark = mx >= 0 && my >= 0 && mx < n && my < n && qr.modules.get(my, mx)
      Y[(oy + y) * W + (ox + x)] = dark ? 20 : 235
    }
  }
  const UV = Buffer.alloc((W / 2) * (H / 2), 128)
  const header = Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`)
  const frame = Buffer.concat([Buffer.from('FRAME\n'), Y, UV, UV])
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, Buffer.concat([header, ...Array.from({ length: frames }, () => frame)]))
  return file
}

/** A blank grey video, for "camera on, nothing to scan". */
export function writeBlankVideo(file: string): string {
  const W = 640
  const H = 480
  const frame = Buffer.concat([
    Buffer.from('FRAME\n'),
    Buffer.alloc(W * H, 110),
    Buffer.alloc((W * H) / 2, 128),
  ])
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(
    file,
    Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), frame, frame]),
  )
  return file
}
