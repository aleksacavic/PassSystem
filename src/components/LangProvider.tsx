import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  LangContext,
  LOCALES,
  STORAGE_KEY,
  initialLang,
  translate,
  type Lang,
  type LangState,
} from '../lib/i18n'

/** Wraps the guest pages; sets <html lang/dir> while mounted. */
export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang)
  const setLang = useCallback((next: Lang) => {
    setLangState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* storage unavailable */
    }
  }, [])
  const dir = lang === 'ar' ? 'rtl' : 'ltr'

  useEffect(() => {
    const html = document.documentElement
    html.lang = lang
    html.dir = dir
    return () => {
      html.lang = 'en'
      html.dir = 'ltr'
    }
  }, [lang, dir])

  const value = useMemo<LangState>(
    () => ({ lang, dir, locale: LOCALES[lang], setLang, t: (key, vars) => translate(lang, key, vars) }),
    [lang, dir, setLang],
  )
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>
}
