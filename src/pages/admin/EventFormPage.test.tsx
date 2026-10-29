// Editing an existing event needs its current version: a failed load offers a
// retry, never an editable default form that saves by ID alone (R10-01).
import { act, fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes } from 'react-router'
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
  const save = screen.queryByRole('button', { name: /^(Save changes|Create event)$/ })
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

// R11-01: the editor belongs to the event its route names.
const B = '9c1d2e3f-4a5b-4c6d-8e7f-aabbccddeeff'
// Same version string as A on purpose: timestamps are not unique, so identity must come from the ID.
const springFair = { ...archived, id: B, name: 'Spring Fair', slug: 'spring-fair', status: 'draft' }

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function editAThenGoTo(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/admin/events/new', element: <EventFormPage /> },
      { path: '/admin/events/:id/edit', element: <EventFormPage /> },
      { path: '/admin/events/:id', element: <p>Event detail</p> },
    ],
    { initialEntries: [`/admin/events/${ID}/edit`] },
  )
  render(<RouterProvider router={router} />)
  await flush()
  expect(screen.getByLabelText(/Event name/)).toHaveValue('Autumn Gala')
  await act(async () => {
    await router.navigate(path)
  })
  await flush()
}

describe('EventFormPage moving between events (R11-01)', () => {
  it('while B loads, then after B fails, nothing of A can be edited or saved', async () => {
    const b = deferred<typeof springFair>()
    api.getEvent.mockImplementation((id: string) => (id === ID ? Promise.resolve(archived) : b.promise))
    await editAThenGoTo(`/admin/events/${B}/edit`)

    // B pending: whatever is shown, completing it and saving sends nothing.
    await completeAndSave()
    expect(api.updateEvent).not.toHaveBeenCalled()
    expect(screen.queryByLabelText(/Event name/)).toBeNull()

    await act(async () => b.reject(new Error('Network request failed.')))
    await flush()
    await completeAndSave()
    expect(api.updateEvent).not.toHaveBeenCalled()
    expect(screen.getByText('This event could not be loaded')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('Autumn Gala')).toBeNull()
  })

  it("when B loads, B is shown and the save targets B with B's version", async () => {
    api.getEvent.mockImplementation(async (id: string) => (id === ID ? archived : springFair))
    await editAThenGoTo(`/admin/events/${B}/edit`)
    expect(screen.getByLabelText(/Event name/)).toHaveValue('Spring Fair')
    await completeAndSave()
    expect(api.updateEvent).toHaveBeenCalledTimes(1)
    expect(api.updateEvent).toHaveBeenCalledWith(B, expect.anything(), { updatedAt: springFair.updated_at })
  })

  it('going from editing A to creating starts an empty form that creates, never updates A', async () => {
    api.getEvent.mockResolvedValue(archived)
    api.createEvent.mockResolvedValue({ ...archived, id: 'new-id' })
    await editAThenGoTo('/admin/events/new')
    expect(screen.getByLabelText(/Event name/)).toHaveValue('')
    await completeAndSave()
    expect(api.updateEvent).not.toHaveBeenCalled()
    expect(api.createEvent).toHaveBeenCalledWith(expect.objectContaining({ name: 'Overwritten' }))
  })
})
