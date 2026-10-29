// R13-02: a dismissed attendee dialog that finishes late refreshes the list but
// never closes or changes the dialog the organizer has opened since.
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  listRegistrations: vi.fn(),
  listAllRegistrations: vi.fn(),
  reissuePass: vi.fn(),
  restoreRegistration: vi.fn(),
  revokeRegistration: vi.fn(),
}))
vi.mock('../../../lib/api', () => api)
vi.mock('../../../lib/usePolling', () => ({ usePolling: () => undefined }))
vi.mock('../../../components/useQrDataUrl', () => ({ useQrDataUrl: () => null }))
import { AttendeesTab } from './AttendeesTab'

const event = {
  id: 'ev-1',
  name: 'Autumn Gala',
  slug: 'autumn-gala',
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
const guest = (id: string, first: string, status: 'registered' | 'revoked') => ({
  id,
  event_id: 'ev-1',
  first_name: first,
  last_name: 'Guest',
  email: null,
  phone: null,
  status,
  registered_at: '2026-10-29T08:00:00Z',
  checked_in_at: null,
  checked_in_by: null,
  revoked_at: status === 'revoked' ? '2026-10-29T09:00:00Z' : null,
  token_issued_at: '2026-10-29T08:00:00Z',
  token_version: 1,
  terms_accepted_at: null,
})

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

const flush = () =>
  act(async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0))
  })

/** Row action for one guest (each row is shown in a list and a card layout). */
function rowAction(first: string, action: string) {
  const rows = screen.getAllByText(new RegExp(`${first} Guest`))
  for (const row of rows) {
    const container = row.closest('tr, li, [data-row]') ?? row.parentElement!.parentElement!
    const button = within(container as HTMLElement).queryByRole('button', { name: action })
    if (button) return button
  }
  throw new Error(`no ${action} button for ${first}`)
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
})

describe.each([
  {
    kind: 'revoke',
    action: 'Revoke',
    confirm: 'Revoke pass',
    status: 'registered',
    call: 'revokeRegistration',
  },
  {
    kind: 'restore',
    action: 'Restore',
    confirm: 'Restore pass',
    status: 'revoked',
    call: 'restoreRegistration',
  },
  { kind: 'reissue', action: 'Reissue', confirm: 'Reissue pass', status: 'registered', call: 'reissuePass' },
] as const)('AttendeesTab $kind dialog (R13-02)', ({ action, confirm, status, call }) => {
  it("A's request finishing after its dialog was dismissed leaves B's dialog open", async () => {
    api.listRegistrations.mockResolvedValue({
      rows: [guest('reg-A', 'Alice', status), guest('reg-B', 'Bob', status)],
      total: 2,
    })
    const pending = deferred<string | undefined>()
    api[call].mockReturnValue(pending.promise)
    const onChanged = vi.fn()
    render(<AttendeesTab event={event} onChanged={onChanged} />)
    await flush()

    fireEvent.click(rowAction('Alice', action))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: confirm }))
    expect(api[call]).toHaveBeenCalledWith('reg-A')
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(rowAction('Bob', action))
    expect(within(screen.getByRole('dialog')).getByText(/Bob Guest/)).toBeInTheDocument()

    await act(async () => pending.resolve(call === 'reissuePass' ? 'NEWTOKENFORALICE00000000' : undefined))
    await flush()
    const dialog = screen.getByRole('dialog') // B's dialog is still open ...
    expect(within(dialog).getByText(/Bob Guest/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: confirm })).toBeInTheDocument() // ... unconfirmed
    expect(api[call]).toHaveBeenCalledTimes(1) // nothing was sent for B
    expect(onChanged).toHaveBeenCalled() // A's change still refreshed the list
  })
})

// Search and filters: a usable search field with its own clear button, and "Clear all".
describe('AttendeesTab search and filters', () => {
  async function renderTab() {
    api.listRegistrations.mockResolvedValue({ rows: [guest('reg-A', 'Alice', 'registered')], total: 1 })
    render(<AttendeesTab event={event} onChanged={vi.fn()} />)
    await flush()
  }
  const lastQuery = () => api.listRegistrations.mock.calls.at(-1)![0]

  it('searches, and the clear button empties the search at once', async () => {
    await renderTab()
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search attendees' }), {
      target: { value: 'ali' },
    })
    await act(async () => new Promise((r) => setTimeout(r, 300))) // debounce
    expect(lastQuery()).toMatchObject({ search: 'ali', page: 0 })

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    await flush()
    expect(screen.getByRole('searchbox', { name: 'Search attendees' })).toHaveValue('')
    expect(lastQuery()).toMatchObject({ search: '', status: 'all' })
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull()
  })

  it('"Clear all" appears only when filtered and resets search and status', async () => {
    await renderTab()
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull()
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by status' }), {
      target: { value: 'checked_in' },
    })
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search attendees' }), {
      target: { value: 'bob' },
    })
    await act(async () => new Promise((r) => setTimeout(r, 300)))
    expect(lastQuery()).toMatchObject({ search: 'bob', status: 'checked_in' })

    fireEvent.click(screen.getAllByRole('button', { name: 'Clear all' })[0]!)
    await flush()
    expect(screen.getByRole('searchbox', { name: 'Search attendees' })).toHaveValue('')
    expect(screen.getByRole('combobox', { name: 'Filter by status' })).toHaveValue('all')
    expect(lastQuery()).toMatchObject({ search: '', status: 'all', page: 0 })
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull()
  })

  it('an empty filtered result offers "Clear all"; an empty event says no attendees yet', async () => {
    api.listRegistrations.mockResolvedValue({ rows: [], total: 0 })
    render(<AttendeesTab event={event} onChanged={vi.fn()} />)
    await flush()
    expect(screen.getByText('No attendees yet.')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by status' }), {
      target: { value: 'revoked' },
    })
    await flush()
    expect(screen.getByText('No attendees match these filters.')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Clear all' })).toHaveLength(2) // toolbar and empty state
  })
})

describe('AttendeesTab request order (R16-02)', () => {
  it('a slower search response that arrives after Clear does not replace the cleared list', async () => {
    let finishAlice!: (v: unknown) => void
    api.listRegistrations.mockImplementation(({ search }: { search: string }) =>
      search === 'alice'
        ? new Promise((r) => (finishAlice = r))
        : Promise.resolve({ rows: [guest('reg-B', 'Bob', 'registered')], total: 1 }),
    )
    render(<AttendeesTab event={event} onChanged={vi.fn()} />)
    await flush()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search attendees' }), {
      target: { value: 'alice' },
    })
    await act(async () => new Promise((r) => setTimeout(r, 300))) // the Alice request is in flight

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    await flush()
    expect(screen.getAllByText(/Bob Guest/).length).toBeGreaterThan(0)

    await act(async () => finishAlice({ rows: [guest('reg-A', 'Alice', 'registered')], total: 1 }))
    await flush()
    expect(screen.queryByText(/Alice Guest/)).toBeNull() // the old response was ignored
    expect(screen.getAllByText(/Bob Guest/).length).toBeGreaterThan(0)
  })

  it('Clear search puts the cursor back in the search field', async () => {
    api.listRegistrations.mockResolvedValue({ rows: [], total: 0 })
    render(<AttendeesTab event={event} onChanged={vi.fn()} />)
    await flush()
    const box = screen.getByRole('searchbox', { name: 'Search attendees' })
    fireEvent.change(box, { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(box).toHaveFocus()
  })
})

describe('AttendeesTab dismissed action refresh (R17-01)', () => {
  it('a revoke finishing after Clear reloads the list for the filters shown now', async () => {
    api.listRegistrations.mockImplementation(async ({ search }: { search: string }) =>
      search === 'alice'
        ? { rows: [guest('reg-A', 'Alice', 'registered')], total: 1 }
        : { rows: [guest('reg-B', 'Bob', 'registered')], total: 1 },
    )
    let finishRevoke!: () => void
    api.revokeRegistration.mockReturnValue(new Promise<void>((r) => (finishRevoke = r)))
    render(<AttendeesTab event={event} onChanged={vi.fn()} />)
    await flush()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search attendees' }), {
      target: { value: 'alice' },
    })
    await act(async () => new Promise((r) => setTimeout(r, 300)))
    fireEvent.click(rowAction('Alice', 'Revoke'))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke pass' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    await flush()
    expect(screen.getAllByText(/Bob Guest/).length).toBeGreaterThan(0)

    await act(async () => finishRevoke())
    await flush()
    expect(api.revokeRegistration).toHaveBeenCalledWith('reg-A')
    expect(api.listRegistrations.mock.calls.at(-1)![0]).toMatchObject({ search: '' }) // not 'alice'
    expect(screen.queryByText(/Alice Guest/)).toBeNull()
    expect(screen.getAllByText(/Bob Guest/).length).toBeGreaterThan(0)
  })
})
