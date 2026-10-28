import type { ReactNode } from 'react'
import { LogoMark } from './Logo'

export function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <main className="mx-auto w-full max-w-md flex-1 px-4 pt-6 pb-10 sm:pt-10">{children}</main>
      <footer className="no-print flex items-center justify-center gap-2 pb-6 text-xs text-fg-faint">
        <LogoMark className="size-4" />
        <span>PassSystem</span>
      </footer>
    </div>
  )
}
