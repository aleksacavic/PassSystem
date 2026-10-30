// The event detail screen and its tabs belong to the event the route names:
// moving from A to B never leaves A's record, rows or dialogs actionable (R12-01).
import { act, fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  getEvent: vi.fn(),
  getEventSummaries: vi.fn(),
  updateEvent: vi.fn(),
  listRegistrations: vi.fn(),
  listAllRegistrations: vi.fn(),
  reissuePass: vi.fn(),
  restoreRegistration: vi.fn(),
  revokeRegistration: vi.fn(),
  listEventStaff: vi.fn(),
  addEventStaff: vi.fn(),
  removeEventStaff: vi.fn(),
  listAdmissionLogs: vi.fn(),
  registrationNames: vi.fn(),
}))
vi.mock('../../lib/api', () => api)
vi.mock('../../lib/usePolling', () => ({ usePolling: () => undefined }))
vi.mock('../../components/useQrDataUrl', () => ({ useQrDataUrl: () => null }))
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ session: { user: { id: 'me' } } }) }))
import EventDetailPage from './EventDetailPage'

const A = '0b6f3f7e-1a2b-4c3d-9e8f-001122334455'
const B = '9c1d2e3f-4a5b-4c6d-8e7f-aabbccddeeff'
const event = (id: string, name: string) => ({
  id,
  name,
  slug: name.toLowerCase().replace(/ /g, '-'),
  description: null,
  location: null,
  timezone: 'Asia/Dubai',
  starts_at: '2026-11-06T16:00:00Z',
  ends_at: null,
  registration_opens_at: null,
  registration_closes_at: null,
  status: 'draft',
  max_attendees: null,
  terms_required: false,
  terms_text: null,
  created_at: '2026-10-01T08:00:00Z',
  updated_at: '2026-10-29T08:00:00.123456+00:00',
  created_by: null,
})
const eventA = event(A, 'Event A')
const eventB = event(B, 'Event B')
const summary = (id: string) => [
  { id, my_role: 'organizer', registered_count: 1, checked_in_count: 0, revoked_count: 0 },
]
const registration = (id: string, eventId: string, first: string) => ({
  id,
  event_id: eventId,
  first_name: first,
  last_name: 'Guest',
  email: null,
  phone: null,
  status: 'registered',
  registered_at: '2026-10-29T08:00:00Z',
  checked_in_at: null,
  checked_in_by: null,
  revoked_at: null,
  token_issued_at: '2026-10-29T08:00:00Z',
  token_version: 1,
  terms_accepted_at: null,
})
const staffA = [
  {
    id: 'assignment-A',
    user_id: 'u-a',
    email: 'door@a.test',
    display_name: null,
    role: 'operator',
    created_at: '2026-10-29T08:00:00Z',
  },
]

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const flush = () =>
  act(async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0))
  })

async function openAt(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/admin/events/:id', element: <EventDetailPage /> },
      { path: '/admin', element: <p>Events list</p> },
    ],
    { initialEntries: [path] },
  )
  render(<RouterProvider router={router} />)
  await flush()
  return async (to: string) => {
    await act(async () => {
      await router.navigate(to)
    })
    await flush()
  }
}

let confirmSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  api.getEventSummaries.mockImplementation(async (id: string) => summary(id))
  api.updateEvent.mockImplementation(async (id: string) => ({ ...eventA, id, status: 'published' }))
  api.listAdmissionLogs.mockResolvedValue([])
  api.registrationNames.mockResolvedValue({})
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
})
afterEach(() => confirmSpy.mockRestore())

describe('EventDetailPage moving between events (R12-01)', () => {
  it("while B loads, A's Publish is gone and nothing is published", async () => {
    const b = deferred<typeof eventB>()
    api.getEvent.mockImplementation((id: string) => (id === A ? Promise.resolve(eventA) : b.promise))
    const go = await openAt(`/admin/events/${A}`)
    expect(screen.getByRole('heading', { name: 'Event A' })).toBeInTheDocument()

    await go(`/admin/events/${B}`)
    const publish = screen.queryByRole('button', { name: /Publish/ })
    if (publish) fireEvent.click(publish)
    await flush()
    expect(api.updateEvent).not.toHaveBeenCalled()
    expect(screen.queryByRole('heading', { name: 'Event A' })).toBeNull()

    await act(async () => b.resolve(eventB))
    await flush()
    expect(screen.getByRole('heading', { name: 'Event B' })).toBeInTheDocument()
  })

  it("A's open Revoke dialog does not survive into B's attendees", async () => {
    api.getEvent.mockImplementation(async (id: string) => (id === A ? eventA : eventB))
    api.listRegistrations.mockImplementation(async ({ eventId }: { eventId: string }) => ({
      rows: [eventId === A ? registration('reg-A', A, 'Alice') : registration('reg-B', B, 'Bob')],
      total: 1,
    }))
    const go = await openAt(`/admin/events/${A}?tab=attendees`)
    fireEvent.click(screen.getAllByRole('button', { name: /^Revoke$/ })[0]!) // row action (list and card layouts)
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    await go(`/admin/events/${B}?tab=attendees`)
    const confirm =
      screen.queryByRole('dialog') && screen.queryAllByRole('button', { name: 'Revoke pass' })[0]
    if (confirm) fireEvent.click(confirm)
    await flush()
    expect(api.revokeRegistration).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Event B' })).toBeInTheDocument()
    expect(screen.getAllByText(/Bob/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Alice/)).toBeNull()
  })

  it("a late response for A does not replace B's loaded page", async () => {
    const a = deferred<typeof eventA>()
    api.getEvent.mockImplementation((id: string) => (id === A ? a.promise : Promise.resolve(eventB)))
    const go = await openAt(`/admin/events/${A}`)
    await go(`/admin/events/${B}`)
    expect(screen.getByRole('heading', { name: 'Event B' })).toBeInTheDocument()

    await act(async () => a.resolve(eventA))
    await flush()
    expect(screen.getByRole('heading', { name: 'Event B' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Event A' })).toBeNull()
  })

  it("while B's staff list loads, A's staff cannot be removed", async () => {
    api.getEvent.mockImplementation(async (id: string) => (id === A ? eventA : eventB))
    api.listEventStaff.mockImplementation((id: string) =>
      id === A ? Promise.resolve(staffA) : new Promise(() => {}),
    )
    const go = await openAt(`/admin/events/${A}?tab=staff`)
    expect(screen.getByText('door@a.test')).toBeInTheDocument()

    await go(`/admin/events/${B}?tab=staff`)
    const remove = screen.queryByRole('button', { name: /Remove/ })
    if (remove) fireEvent.click(remove)
    await flush()
    expect(api.removeEventStaff).not.toHaveBeenCalled()
    expect(screen.queryByText('door@a.test')).toBeNull()
  })

  it('a Publish that finishes after moving to B does not change B (R12-02)', async () => {
    const published = deferred<typeof eventA>()
    api.getEvent.mockImplementation(async (id: string) => (id === A ? eventA : eventB))
    api.updateEvent.mockReturnValue(published.promise)
    const go = await openAt(`/admin/events/${A}`)
    fireEvent.click(screen.getByRole('button', { name: /Publish/ }))
    await go(`/admin/events/${B}`)

    await act(async () => published.resolve({ ...eventA, status: 'published' }))
    await flush()
    expect(api.updateEvent).toHaveBeenCalledWith(A, { status: 'published' }, { status: 'draft' })
    expect(screen.getByRole('heading', { name: 'Event B' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Event A' })).toBeNull()
  })
})
