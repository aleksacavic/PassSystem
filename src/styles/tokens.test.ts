// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// Components style through the semantic/component tokens in tokens.css. Raw
// palette utilities, arbitrary colour values and hex colours in class names
// are not allowed, except where a brand requires fixed colours.
const ALLOWED = new Set(['src/components/GoogleWalletButton.tsx'])
const PALETTES =
  'black|white|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
const RAW = new RegExp(
  `(?<![\\w-])(?:[a-z-]+:)*(?:bg|text|border|ring|fill|stroke|divide|outline|placeholder|accent|shadow|from|via|to)-` +
    `(?:(?:${PALETTES})(?:-\\d+)?(?:/\\d+)?(?![\\w-])|\\[(?:#|rgba?\\(|hsla?\\()|\\[[^\\]]*(?:#[0-9a-f]{3,8}|rgba?\\())`,
  'i',
)

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return files(path)
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : []
  })
}

describe('design tokens', () => {
  it('components use token utilities, not raw colours', () => {
    const offenders: string[] = []
    for (const file of files('src')) {
      const rel = relative(process.cwd(), file)
      if (ALLOWED.has(rel)) continue
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const m = RAW.exec(line)
          if (m) offenders.push(`${rel}:${i + 1}: ${m[0]}`)
        })
    }
    expect(offenders).toEqual([])
  })

  it('the check catches raw colours', () => {
    for (const bad of [
      'bg-black',
      'text-white',
      'border-white/85',
      'bg-red-500',
      'shadow-[0_0_0_1px_rgba(0,0,0,0.3)]',
      'bg-[#fff]',
      'hover:text-gray-700',
    ]) {
      expect(RAW.test(bad), bad).toBe(true)
    }
    for (const ok of [
      'bg-surface',
      'text-fg-muted',
      'border-camera-frame',
      'shadow-camera-mask',
      'bg-success-soft',
    ]) {
      expect(RAW.test(ok), ok).toBe(false)
    }
  })
})
