/**
 * QR detector factory. Uses the native BarcodeDetector where it supports QR
 * codes (Chrome on Android, some desktop browsers) and otherwise the
 * zxing-wasm based ponyfill (iOS Safari, Firefox, desktop Chrome on Linux…).
 * The .wasm binary is self-hosted (bundled by Vite), never loaded from a CDN.
 */
export interface QrDetector {
  detect(source: CanvasImageSource): Promise<string[]>
  kind: 'native' | 'wasm'
}

interface DetectedBarcodeLike {
  rawValue: string
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource | ImageBitmapSource): Promise<DetectedBarcodeLike[]>
}

interface BarcodeDetectorCtor {
  new (opts: { formats: string[] }): BarcodeDetectorLike
  getSupportedFormats?: () => Promise<string[]>
}

let cached: Promise<QrDetector> | null = null

export function getQrDetector(): Promise<QrDetector> {
  cached ??= createDetector().catch((e) => {
    cached = null
    throw e
  })
  return cached
}

async function createDetector(): Promise<QrDetector> {
  const Native = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
  if (Native && typeof Native.getSupportedFormats === 'function') {
    try {
      const formats = await Native.getSupportedFormats()
      if (formats.includes('qr_code')) {
        const d = new Native({ formats: ['qr_code'] })
        return { kind: 'native', detect: async (s) => (await d.detect(s)).map((b) => b.rawValue) }
      }
    } catch {
      /* fall through to wasm */
    }
  }
  const [{ BarcodeDetector, prepareZXingModule }, { default: wasmUrl }] = await Promise.all([
    import('barcode-detector/ponyfill'),
    import('zxing-wasm/reader/zxing_reader.wasm?url'),
  ])
  prepareZXingModule({
    overrides: {
      locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path),
    },
    fireImmediately: true,
  })
  const d = new BarcodeDetector({ formats: ['qr_code'] })
  return {
    kind: 'wasm',
    detect: async (s) => (await d.detect(s as ImageBitmapSource)).map((b) => b.rawValue),
  }
}
