// Check-in history on the Scan activity tab: the same panel, fed by admitted scans.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ listAdmittedScanTimes: vi.fn() }))
vi.mock('../../../lib/api', () => api)
import { ScanHistory } from './ScanHistory'

const event = { id: 'ev-1', timezone: 'Asia/Dubai' } as Parameters<typeof ScanHistory>[0]['event']
const flush = () =>
  act(async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0))
  })

beforeEach(() => api.listAdmittedScanTimes.mockReset())

describe('ScanHistory', () => {
  it('loads admitted scans when opened and shows check-ins per hour', async () => {
    api.listAdmittedScanTimes.mockResolvedValue([
      '2026-11-06T15:58:00Z',
      '2026-11-06T16:02:00Z',
      '2026-11-06T16:30:00Z',
      '2026-11-06T17:10:00Z',
    ])
    render(<ScanHistory event={event} />)
    const toggle = screen.getByRole('button', { name: /Check-in history/ })
    expect(api.listAdmittedScanTimes).not.toHaveBeenCalled()
    fireEvent.click(toggle)
    await flush()
    expect(api.listAdmittedScanTimes).toHaveBeenCalledWith('ev-1')
    expect(screen.getByText('4')).toBeInTheDocument()
    expect(screen.getByText(/check-ins · busiest hour/)).toBeInTheDocument()
    expect(screen.getByText('6 Nov, 20:00–21:00')).toBeInTheDocument() // 16:00Z in Dubai, 2 check-ins
    expect(screen.getAllByTestId('history-bar').map((b) => b.getAttribute('aria-label'))).toEqual([
      '6 Nov, 19:00–20:00: 1',
      '6 Nov, 20:00–21:00: 2',
      '6 Nov, 21:00–22:00: 1',
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Show as table' }))
    expect(screen.getByRole('columnheader', { name: 'Check-ins' })).toBeInTheDocument()
  })

  it('says so when nobody has been let in yet', async () => {
    api.listAdmittedScanTimes.mockResolvedValue([])
    render(<ScanHistory event={event} />)
    fireEvent.click(screen.getByRole('button', { name: /Check-in history/ }))
    await flush()
    expect(screen.getByText('No check-ins yet.')).toBeInTheDocument()
  })
})
