// Scan activity lists every scan of the event, searchable by attendee and filterable by result.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ listScanActivity: vi.fn(), listAdmittedScanTimes: vi.fn() }))
vi.mock('../../../lib/api', () => api)
vi.mock('../../../lib/usePolling', () => ({ usePolling: () => undefined }))
import { ActivityTab } from './ActivityTab'

const event = { id: 'ev-1', timezone: 'Asia/Dubai' } as Parameters<typeof ActivityTab>[0]['event']
const scan = (id: string, first: string | null, result = 'admitted') => ({
  id,
  registration_id: first ? `reg-${id}` : null,
  event_id: 'ev-1',
  operator_id: null,
  attempted_at: '2026-11-06T16:00:00Z',
  result,
  details: {},
  registration: first ? { first_name: first, last_name: 'Guest', email: null, phone: null } : null,
})
const flush = () =>
  act(async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0))
  })
const lastQuery = () => api.listScanActivity.mock.calls.at(-1)![0]

beforeEach(() => {
  api.listScanActivity.mockReset()
  api.listAdmittedScanTimes.mockReset().mockResolvedValue([])
})

describe('ActivityTab', () => {
  it('lists every scan with its total, not just the latest 100', async () => {
    api.listScanActivity.mockResolvedValue({
      rows: [scan('1', 'Alice'), scan('2', null, 'invalid'), scan('3', null, 'wrong_event')],
      total: 1234,
    })
    render(<ActivityTab event={event} />)
    await flush()
    expect(lastQuery()).toMatchObject({ eventId: 'ev-1', search: '', result: 'all', page: 0, pageSize: 50 })
    expect(screen.getByText('1,234 server-validated scan attempts, newest first.')).toBeInTheDocument()
    expect(screen.queryByText(/Last 100/)).toBeNull()
    expect(screen.getByText('Alice Guest')).toBeInTheDocument()
    expect(screen.getByText('Unknown pass')).toBeInTheDocument()
    expect(screen.getByText('Pass from another event')).toBeInTheDocument()
    expect(screen.getByText('Page 1 of 25')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await flush()
    expect(lastQuery()).toMatchObject({ page: 1 })
  })

  it('searches and filters by result, and Clear all resets both', async () => {
    api.listScanActivity.mockResolvedValue({ rows: [scan('1', 'Alice')], total: 1 })
    render(<ActivityTab event={event} />)
    await flush()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search scans' }), { target: { value: 'ali' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by result' }), {
      target: { value: 'already_used' },
    })
    await act(async () => new Promise((r) => setTimeout(r, 300)))
    expect(lastQuery()).toMatchObject({ search: 'ali', result: 'already_used', page: 0 })
    expect(screen.getByText('1 server-validated scan attempt match, newest first.')).toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: 'Clear all' })[0]!)
    await flush()
    expect(lastQuery()).toMatchObject({ search: '', result: 'all', page: 0 })
    expect(screen.getByRole('searchbox', { name: 'Search scans' })).toHaveValue('')
  })

  it('an empty filtered result says so and offers Clear all', async () => {
    api.listScanActivity.mockResolvedValue({ rows: [], total: 0 })
    render(<ActivityTab event={event} />)
    await flush()
    expect(screen.getByText('No scans yet.')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by result' }), {
      target: { value: 'revoked' },
    })
    await flush()
    expect(screen.getByText('No scans match these filters.')).toBeInTheDocument()
  })
})
