import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import RegisterPage from './RegisterPage'
import * as api from '../../lib/api'
import { ApiError } from '../../lib/errors'

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

const withTerms = {
  ...event,
  terms_required: true,
  terms_text: 'Attendance terms\n\n1. Private social event.',
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

  it('requires ticking the attendance terms when the event has them', async () => {
    vi.mocked(api.getPublicEvent).mockResolvedValue({ event: withTerms, registrationState: 'open' })
    vi.mocked(api.registerForEvent).mockClear()
    vi.mocked(api.registerForEvent).mockResolvedValue({
      token: '87J813AZE9GZXK95NP3GA5F4',
      replayed: false,
      registration: {
        first_name: 'Ana',
        last_name: 'Test',
        status: 'registered',
        registered_at: '2026-10-28T10:00:00Z',
      },
      event: withTerms,
    })
    renderPage()
    fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'Ana' } })
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Test' } })
    expect(screen.getByTestId('terms')).toHaveTextContent('Private social event')
    fireEvent.click(screen.getByRole('button', { name: 'Register' }))
    expect(await screen.findByText('Please read and accept the attendance terms.')).toBeInTheDocument()
    expect(api.registerForEvent).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('I have read and accept the attendance terms.'))
    fireEvent.click(screen.getByRole('button', { name: 'Register' }))
    await screen.findByText('pass page')
    expect(vi.mocked(api.registerForEvent).mock.calls[0]![0]).toMatchObject({ acceptTerms: true })
  })

  it('sends the version of the terms shown, and asks again when the organizer changed them', async () => {
    const v1 = { ...withTerms, terms_version: 'aaa' }
    const v2 = { ...withTerms, terms_text: 'Attendance terms\n\n1. Updated rule.', terms_version: 'bbb' }
    vi.mocked(api.getPublicEvent)
      .mockResolvedValueOnce({ event: v1, registrationState: 'open' })
      .mockResolvedValue({ event: v2, registrationState: 'open' })
    vi.mocked(api.registerForEvent).mockClear()
    vi.mocked(api.registerForEvent).mockRejectedValueOnce(
      Object.assign(new ApiError('The organizer has just updated the attendance terms.', 'terms_changed'), {
        field: 'terms',
      }),
    )
    renderPage()
    fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'Ana' } })
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Test' } })
    fireEvent.click(screen.getByLabelText('I have read and accept the attendance terms.'))
    fireEvent.click(screen.getByRole('button', { name: 'Register' }))
    expect(await screen.findByText(/just updated the attendance terms/)).toBeInTheDocument()
    expect(vi.mocked(api.registerForEvent).mock.calls[0]![0]).toMatchObject({ termsVersion: 'aaa' })
    await waitFor(() => expect(screen.getByTestId('terms')).toHaveTextContent('Updated rule'))
    expect(screen.getByLabelText('I have read and accept the attendance terms.')).not.toBeChecked()
  })

  it('validates and normalizes the optional phone number', async () => {
    vi.mocked(api.getPublicEvent).mockResolvedValue({ event, registrationState: 'open' })
    vi.mocked(api.registerForEvent).mockClear()
    vi.mocked(api.registerForEvent).mockResolvedValue({
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
    renderPage()
    fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'Ana' } })
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Test' } })
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '050 123 4567' } })
    fireEvent.click(screen.getByRole('button', { name: 'Register' }))
    expect(await screen.findByText(/with country code/i, { selector: '[role=alert]' })).toBeInTheDocument()
    expect(api.registerForEvent).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '+971 50 123 4567' } })
    fireEvent.click(screen.getByRole('button', { name: 'Register' }))
    await screen.findByText('pass page')
    expect(vi.mocked(api.registerForEvent).mock.calls[0]![0]).toMatchObject({
      phone: '+971501234567',
      acceptTerms: false,
    })
  })
})
