// Editing an existing event needs its current version: a failed load offers a
// retry, never an editable default form that saves by ID alone (R10-01).
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  getEvent: vi.fn(),
  getDefaultEventTerms: vi.fn(),
  updateEvent: vi.fn(),
  createEvent: vi.fn(),
  deleteEvent: vi.fn(),
}))
vi.mock('../../lib/api', () => api)
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ isAdmin: true }) }))
import EventFormPage from './EventFormPage'

const ID = '0b6f3f7e-1a2b-4c3d-9e8f-001122334455'
const VERSION = '2026-10-29T08:00:00.123456+00:00'
const archived = {
  id: ID,
  name: 'Autumn Gala',
  slug: 'autumn-gala',
  description: null,
  location: 'Hall',
  timezone: 'Asia/Dubai',
  starts_at: '2026-11-06T16:00:00Z',
  ends_at: null,
  registration_opens_at: null,
  registration_closes_at: null,
  status: 'archived',
  max_attendees: null,
  terms_required: false,
  terms_text: null,
  created_at: '2026-10-01T08:00:00Z',
  updated_at: VERSION,
  created_by: null,
}

const flush = () =>
  act(async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0))
  })

async function openEditForm() {
  render(
    <MemoryRouter initialEntries={[`/admin/events/${ID}/edit`]}>
      <Routes>
        <Route path="/admin/events/:id/edit" element={<EventFormPage />} />
        <Route path="/admin/events/:id" element={<p>Event detail</p>} />
      </Routes>
    </MemoryRouter>,
  )
  await flush()
}

/** Completes whatever editable form is shown and presses Save, as an organizer would. */
async function completeAndSave() {
  const name = screen.queryByLabelText(/Event name/)
  if (name) fireEvent.change(name, { target: { value: 'Overwritten' } })
  const slug = screen.queryByLabelText(/Link name/)
  if (slug) fireEvent.change(slug, { target: { value: 'overwritten' } })
  const starts = screen.queryByLabelText(/Starts/)
  if (starts) fireEvent.change(starts, { target: { value: '2026-11-06T20:00' } })
  const terms = screen.queryByLabelText(/Terms text/)
  if (terms) fireEvent.change(terms, { target: { value: 'Entry terms.' } })
  const save = screen.queryByRole('button', { name: 'Save changes' })
  if (save) fireEvent.click(save)
  await flush()
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  api.getDefaultEventTerms.mockResolvedValue('Default terms')
  api.updateEvent.mockResolvedValue(archived)
})

describe('EventFormPage editing an existing event', () => {
  it('a failed load shows an error with a retry, and nothing can be saved', async () => {
    api.getEvent.mockRejectedValue(new Error('Network request failed.'))
    await openEditForm()
    expect(screen.getByText('This event could not be loaded')).toBeInTheDocument()
    expect(screen.getByText(/Network request failed\./)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
    expect(screen.queryByLabelText(/Event name/)).toBeNull()
    await completeAndSave()
    expect(api.updateEvent).not.toHaveBeenCalled()
  })

  it('retrying loads the event, and the save is tied to the loaded version', async () => {
    api.getEvent.mockRejectedValueOnce(new Error('Network request failed.')).mockResolvedValue(archived)
    await openEditForm()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await flush()
    expect(api.getEvent).toHaveBeenCalledTimes(2)
    expect(screen.getByLabelText(/Event name/)).toHaveValue('Autumn Gala')
    await completeAndSave()
    expect(api.updateEvent).toHaveBeenCalledTimes(1)
    expect(api.updateEvent).toHaveBeenCalledWith(ID, expect.objectContaining({ name: 'Overwritten' }), {
      updatedAt: VERSION,
    })
  })
})
