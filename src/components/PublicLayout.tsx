import type { ReactNode } from 'react'
import { Languages } from 'lucide-react'
import { useT } from '../lib/i18n'
import { cx } from './ui'
import { LogoMark } from './Logo'

/** Frame of the guest pages: brand mark, language switch, content column. */
export function PublicLayout({
  children,
  tone = 'canvas',
}: {
  children: ReactNode
  tone?: 'canvas' | 'brand'
}) {
  const { lang, setLang, t } = useT()
  const onBrand = tone === 'brand'
  return (
    <div className={cx('flex min-h-dvh flex-col', onBrand ? 'bg-primary text-on-brand' : 'bg-canvas')}>
      <header className="no-print mx-auto flex w-full max-w-md items-center justify-between px-4 pt-4">
        <span
          className={cx(
            'inline-flex items-center gap-2 text-sm font-bold',
            onBrand ? 'text-on-brand-muted' : 'text-fg-muted',
          )}
        >
          <LogoMark className="size-6" />
          PassSystem
        </span>
        <button
          type="button"
          onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}
          aria-label={t('lang.switchLabel')}
          lang={lang === 'ar' ? 'en' : 'ar'}
          className={cx(
            'inline-flex min-h-9 items-center gap-1.5 rounded-pill px-3 text-sm font-bold ring-1 ring-inset',
            onBrand
              ? 'text-on-brand ring-on-brand/30 hover:bg-on-brand/10'
              : 'bg-surface text-fg ring-line hover:bg-surface-sunk',
          )}
          data-testid="lang-switch"
        >
          <Languages className="size-4" aria-hidden="true" />
          {t('lang.switch')}
        </button>
      </header>
      <main className="mx-auto w-full max-w-md flex-1 px-4 pt-4 pb-10">{children}</main>
    </div>
  )
}
