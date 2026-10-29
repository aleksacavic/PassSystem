// Registration history on the Attendees tab: collapsed, loaded on first open.
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ listRegistrationTimes: vi.fn() }))
vi.mock('../../../lib/api', () => api)
import { RegistrationHistory } from './RegistrationHistory'

const event = {
  id: 'ev-1',
  name: 'Gala',
  slug: 'gala',
  description: null,
  location: null,
  timezone: 'Asia/Dubai',
  starts_at: '2026-11-06T16:00:00Z',
  ends_at: null,
  registration_opens_at: null,
  registration_closes_at: null,
  status: 'published' as const,
  max_attendees: null,
  terms_required: false,
  terms_text: null,
  created_at: '2026-10-01T08:00:00Z',
  updated_at: '2026-10-29T08:00:00Z',
  created_by: null,
}
const at = (registered_at: string) => registered_at
const flush = () =>
  act(async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0))
  })

beforeEach(() => api.listRegistrationTimes.mockReset())

describe('RegistrationHistory', () => {
  it('is collapsed and loads nothing until opened', () => {
    render(<RegistrationHistory event={event} />)
    const toggle = screen.getByRole('button', { name: /Registration history/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(api.listRegistrationTimes).not.toHaveBeenCalled()
  })

  it('opens, shows the total, the busiest hour and one bar per hour, and loads once', async () => {
    api.listRegistrationTimes.mockResolvedValue([
      at('2026-10-29T10:05:00Z'),
      at('2026-10-29T10:40:00Z'),
      at('2026-10-29T12:10:00Z'),
    ])
    render(<RegistrationHistory event={event} />)
    const toggle = screen.getByRole('button', { name: /Registration history/ })
    fireEvent.click(toggle)
    await flush()
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(api.listRegistrationTimes).toHaveBeenCalledWith('ev-1')
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('29 Oct, 14:00–15:00')).toBeInTheDocument() // busiest hour, Dubai time
    const bars = screen.getAllByTestId('history-bar')
    expect(bars.map((b) => b.getAttribute('aria-label'))).toEqual([
      '29 Oct, 14:00–15:00: 2',
      '29 Oct, 15:00–16:00: 0',
      '29 Oct, 16:00–17:00: 1',
    ])

    fireEvent.pointerEnter(bars[2]!)
    expect(screen.getByText(/registration · 29 Oct, 16:00–17:00/)).toBeInTheDocument()

    fireEvent.click(toggle) // close and reopen: no second load
    fireEvent.click(toggle)
    await flush()
    expect(api.listRegistrationTimes).toHaveBeenCalledTimes(1)
  })

  it('has a table view with the same numbers', async () => {
    api.listRegistrationTimes.mockResolvedValue([at('2026-10-29T10:05:00Z'), at('2026-10-29T12:10:00Z')])
    render(<RegistrationHistory event={event} />)
    fireEvent.click(screen.getByRole('button', { name: /Registration history/ }))
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Show as table' }))
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1)
    expect(rows.map((r) => r.textContent)).toEqual([
      '29 Oct, 14:00–15:00' + '1',
      '29 Oct, 15:00–16:00' + '0',
      '29 Oct, 16:00–17:00' + '1',
    ])
  })

  it('says so when there are no registrations, and shows a load error', async () => {
    api.listRegistrationTimes.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('Network down'))
    render(<RegistrationHistory event={event} />)
    fireEvent.click(screen.getByRole('button', { name: /Registration history/ }))
    await flush()
    expect(screen.getByText('No registrations yet.')).toBeInTheDocument()

    const { unmount } = render(<RegistrationHistory event={event} />)
    fireEvent.click(screen.getAllByRole('button', { name: /Registration history/ })[1]!)
    await flush()
    expect(screen.getByText('Network down')).toBeInTheDocument()
    unmount()
  })
})

describe('RegistrationHistory refresh (R17-02)', () => {
  it('an empty first load can be refreshed once people register', async () => {
    api.listRegistrationTimes.mockResolvedValueOnce([]).mockResolvedValueOnce([at('2026-10-29T10:05:00Z')])
    render(<RegistrationHistory event={event} />)
    fireEvent.click(screen.getByRole('button', { name: /Registration history/ }))
    await flush()
    expect(screen.getByText('No registrations yet.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await flush()
    expect(api.listRegistrationTimes).toHaveBeenCalledTimes(2)
    expect(screen.getAllByTestId('history-bar')).toHaveLength(1)
  })

  it('a failed first load can be retried', async () => {
    api.listRegistrationTimes
      .mockRejectedValueOnce(new Error('Network down'))
      .mockResolvedValueOnce([at('2026-10-29T10:05:00Z')])
    render(<RegistrationHistory event={event} />)
    fireEvent.click(screen.getByRole('button', { name: /Registration history/ }))
    await flush()
    expect(screen.getByText('Network down')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await flush()
    expect(screen.queryByText('Network down')).toBeNull()
    expect(screen.getAllByTestId('history-bar')).toHaveLength(1)
  })
})
