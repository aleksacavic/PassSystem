import { cx } from './ui'

export function QrImage({
  dataUrl,
  alt,
  className,
}: {
  dataUrl: string | null
  alt: string
  className?: string
}) {
  return (
    <div className={cx('aspect-square w-full overflow-hidden rounded-card bg-surface', className)}>
      {dataUrl ? (
        <img src={dataUrl} alt={alt} className="size-full [image-rendering:pixelated]" draggable={false} />
      ) : (
        <div className="size-full animate-pulse bg-surface-muted" />
      )}
    </div>
  )
}
