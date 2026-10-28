import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import RegisterPage from './RegisterPage'
import * as api from '../../lib/api'

vi.mock('../../lib/api', () => ({
  getPublicEvent: vi.fn(),
  registerForEvent: vi.fn(),
}))

const event = {
  name: 'Gala',
  slug: 'gala',
  description: null,
  location: 'Hall',
  timezone: 'UTC',
  starts_at: '2026-11-20T18:00:00Z',
  ends_at: null,
  registration_opens_at: null,
  registration_closes_at: null,
  status: 'published' as const,
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/e/gala']}>
      <Routes>
        <Route path="/e/:slug" element={<RegisterPage />} />
        <Route path="/pass" element={<p>pass page</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('RegisterPage', () => {
  beforeEach(() => {
    vi.mocked(api.getPublicEvent).mockResolvedValue({ event, registrationState: 'open' })
    localStorage.clear()
  })

  it('submits exactly once on rapid repeated taps', async () => {
    let resolve!: (v: Awaited<ReturnType<typeof api.registerForEvent>>) => void
    vi.mocked(api.registerForEvent).mockReturnValue(new Promise((r) => (resolve = r)))
    renderPage()
    fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'Ana' } })
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Test' } })
    const button = screen.getByRole('button', { name: 'Register' })
    for (let i = 0; i < 5; i++) fireEvent.click(button)
    expect(api.registerForEvent).toHaveBeenCalledTimes(1)
    resolve({
      token: '87J813AZE9GZXK95NP3GA5F4',
      replayed: false,
      registration: {
        first_name: 'Ana',
        last_name: 'Test',
        status: 'registered',
        registered_at: '2026-10-28T10:00:00Z',
      },
      event,
    })
    await screen.findByText('pass page')
  })

  it('reuses the idempotency key when retrying after a network failure', async () => {
    vi.mocked(api.registerForEvent).mockRejectedValueOnce(new Error('Failed to fetch'))
    vi.mocked(api.registerForEvent).mockResolvedValueOnce({
      token: '87J813AZE9GZXK95NP3GA5F4',
      replayed: true,
      registration: {
        first_name: 'Ana',
        last_name: 'Test',
        status: 'registered',
        registered_at: '2026-10-28T10:00:00Z',
      },
      event,
    })
    renderPage()
    fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'Ana' } })
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Register' }))
    await screen.findByText(/network error/i)
    fireEvent.click(screen.getByRole('button', { name: 'Register' }))
    await screen.findByText('pass page')
    const calls = vi.mocked(api.registerForEvent).mock.calls
    expect(calls.at(-1)![0].requestId).toBe(calls.at(-2)![0].requestId)
  })

  it('shows validation errors without calling the server', async () => {
    vi.mocked(api.registerForEvent).mockClear()
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Register' }))
    await waitFor(() => expect(screen.getByText('First name is required.')).toBeInTheDocument())
    expect(api.registerForEvent).not.toHaveBeenCalled()
  })

  it('shows closed state instead of the form', async () => {
    vi.mocked(api.getPublicEvent).mockResolvedValue({ event, registrationState: 'closed' })
    renderPage()
    expect(await screen.findByText('Registration is closed')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Register' })).toBeNull()
  })
})
