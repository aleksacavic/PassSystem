// Archive and restore from an event card's ⋯ menu.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getEventSummaries: vi.fn(), updateEvent: vi.fn() }))
vi.mock('../../lib/api', () => api)
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ isAdmin: true }) }))
vi.mock('../../lib/usePolling', () => ({ usePolling: () => undefined }))
import EventsPage from './EventsPage'

const summary = (status: string) => ({
  id: 'ev-1',
  name: 'Autumn Gala',
  slug: 'autumn-gala',
  status,
  starts_at: '2026-11-06T16:00:00Z',
  ends_at: null,
  location: null,
  timezone: 'Asia/Dubai',
  max_attendees: null,
  my_role: 'organizer',
  registered_count: 3,
  checked_in_count: 1,
  revoked_count: 0,
})

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })

async function openMenu() {
  render(
    <MemoryRouter>
      <EventsPage />
    </MemoryRouter>,
  )
  await flush()
}

let confirmSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  api.getEventSummaries.mockReset()
  api.updateEvent.mockReset().mockResolvedValue({})
  confirmSpy = vi.spyOn(window, 'confirm')
})
afterEach(() => confirmSpy.mockRestore())

describe('EventsPage archive and restore', () => {
  it('archives an event after confirmation and reloads the list', async () => {
    api.getEventSummaries.mockResolvedValue([summary('published')])
    confirmSpy.mockReturnValue(true)
    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Autumn Gala' }))
    fireEvent.click(screen.getByRole('button', { name: 'Archive event' }))
    await flush()
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('Archive "Autumn Gala"?'))
    expect(api.updateEvent).toHaveBeenCalledWith('ev-1', { status: 'archived' })
    expect(api.getEventSummaries).toHaveBeenCalledTimes(2)
  })

  it('does nothing when the confirmation is cancelled', async () => {
    api.getEventSummaries.mockResolvedValue([summary('published')])
    confirmSpy.mockReturnValue(false)
    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Autumn Gala' }))
    fireEvent.click(screen.getByRole('button', { name: 'Archive event' }))
    await flush()
    expect(api.updateEvent).not.toHaveBeenCalled()
  })

  it('restores an archived event as a draft', async () => {
    api.getEventSummaries.mockResolvedValue([summary('archived')])
    confirmSpy.mockReturnValue(true)
    await openMenu()
    fireEvent.click(screen.getByRole('radio', { name: 'Archived' }))
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Autumn Gala' }))
    expect(screen.queryByRole('button', { name: 'Archive event' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Restore as draft' }))
    await flush()
    expect(api.updateEvent).toHaveBeenCalledWith('ev-1', { status: 'draft' })
  })

  it('shows the error if the change is refused', async () => {
    api.getEventSummaries.mockResolvedValue([summary('published')])
    api.updateEvent.mockRejectedValue(new Error('You do not have permission to change this event.'))
    confirmSpy.mockReturnValue(true)
    await openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Autumn Gala' }))
    fireEvent.click(screen.getByRole('button', { name: 'Archive event' }))
    await flush()
    expect(screen.getByText('You do not have permission to change this event.')).toBeInTheDocument()
  })
})
