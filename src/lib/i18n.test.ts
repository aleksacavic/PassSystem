import { describe, expect, it } from 'vitest'
import { errorMessage, translate } from './i18n'

describe('translate', () => {
  it('interpolates variables in both languages', () => {
    expect(translate('en', 'error.nameTooLong', { label: 'First name', max: 100 })).toBe(
      'First name must be at most 100 characters.',
    )
    expect(translate('ar', 'event.viewPass', { name: 'Ana' })).toBe('عرض تذكرة Ana')
  })

  it('maps API error codes to guest messages and never shows server text (R4-04)', () => {
    const t = (key: Parameters<typeof translate>[1]) => translate('ar', key)
    expect(errorMessage(t, 'event_full')).toBe('وصلت هذه الفعالية إلى الحد الأقصى من الحضور.')
    expect(errorMessage(t, 'XX000')).toBe(translate('ar', 'error.generic'))
    expect(errorMessage(t, null)).toBe(translate('ar', 'error.generic'))
    expect(errorMessage(t, 'XX000', 'pass.loadErrorBody')).toBe(translate('ar', 'pass.loadErrorBody'))
    expect(errorMessage(t, 'network')).toBe(translate('ar', 'error.network'))
    expect(errorMessage(t, 'rate_limited_hour')).toBe(translate('ar', 'error.rate_limited_hour'))
  })
})
