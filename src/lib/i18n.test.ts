import { describe, expect, it } from 'vitest'
import { errorMessage, translate } from './i18n'

describe('translate', () => {
  it('interpolates variables in both languages', () => {
    expect(translate('en', 'error.nameTooLong', { label: 'First name', max: 100 })).toBe(
      'First name must be at most 100 characters.',
    )
    expect(translate('ar', 'event.viewPass', { name: 'Ana' })).toBe('عرض تذكرة Ana')
  })

  it('maps API error codes to guest messages and falls back to the server text', () => {
    const t = (key: Parameters<typeof translate>[1]) => translate('ar', key)
    expect(errorMessage(t, 'event_full', 'x')).toBe('وصلت هذه الفعالية إلى الحد الأقصى من الحضور.')
    expect(errorMessage(t, 'something_new', 'Server says no')).toBe('Server says no')
    expect(errorMessage(t, null, null)).toBe(translate('ar', 'error.network'))
  })
})
