import { act, render, screen, waitFor, fireEvent } from '@testing-library/react'
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import RegisterPage from './RegisterPage'
import HomePage from './HomePage'
import { LangProvider } from '../../components/LangProvider'
import * as api from '../../lib/api'
import { ApiError } from '../../lib/errors'
import { translate } from '../../lib/i18n'
import { passesForEvent, savePass } from '../../lib/passStorage'

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
    const button = screen.getByRole('button', { name: 'Get my pass' })
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
    fireEvent.click(screen.getByRole('button', { name: 'Get my pass' }))
    await screen.findByText(/network error/i)
    fireEvent.click(screen.getByRole('button', { name: 'Get my pass' }))
    await screen.findByText('pass page')
    const calls = vi.mocked(api.registerForEvent).mock.calls
    expect(calls.at(-1)![0].requestId).toBe(calls.at(-2)![0].requestId)
  })

  it('shows validation errors without calling the server', async () => {
    vi.mocked(api.registerForEvent).mockClear()
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Get my pass' }))
    await waitFor(() => expect(screen.getByText('First name is required.')).toBeInTheDocument())
    expect(api.registerForEvent).not.toHaveBeenCalled()
  })

  it('shows closed state instead of the form', async () => {
    vi.mocked(api.getPublicEvent).mockResolvedValue({ event, registrationState: 'closed' })
    renderPage()
    expect(await screen.findByText('Registration is closed')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Get my pass' })).toBeNull()
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
    fireEvent.click(screen.getByRole('button', { name: 'Get my pass' }))
    expect(await screen.findByText('Please read and accept the attendance terms.')).toBeInTheDocument()
    expect(api.registerForEvent).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('I have read and accept the attendance terms.'))
    fireEvent.click(screen.getByRole('button', { name: 'Get my pass' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Get my pass' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Get my pass' }))
    expect(await screen.findByText(/with country code/i, { selector: '[role=alert]' })).toBeInTheDocument()
    expect(api.registerForEvent).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '+971 50 123 4567' } })
    fireEvent.click(screen.getByRole('button', { name: 'Get my pass' }))
    await screen.findByText('pass page')
    expect(vi.mocked(api.registerForEvent).mock.calls[0]![0]).toMatchObject({
      phone: '+971501234567',
      acceptTerms: false,
    })
  })

  it('shows the page in Arabic, right to left, with Arabic validation messages', async () => {
    vi.mocked(api.getPublicEvent).mockResolvedValue({ event: withTerms, registrationState: 'open' })
    localStorage.setItem('passsystem.lang', 'ar')
    const view = render(
      <MemoryRouter initialEntries={['/e/gala']}>
        <LangProvider>
          <Routes>
            <Route path="/e/:slug" element={<RegisterPage />} />
          </Routes>
        </LangProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByLabelText('الاسم الأول')).toBeInTheDocument()
    expect(document.documentElement.dir).toBe('rtl')
    expect(document.documentElement.lang).toBe('ar')
    fireEvent.click(screen.getByRole('button', { name: 'احصل على تذكرتي' }))
    expect(await screen.findByText('الاسم الأول مطلوب.')).toBeInTheDocument()
    expect(screen.getByText('يرجى قراءة شروط الحضور والموافقة عليها.')).toBeInTheDocument()

    // Switching back to English flips the page direction again.
    fireEvent.click(screen.getByTestId('lang-switch'))
    expect(await screen.findByLabelText('First name')).toBeInTheDocument()
    expect(document.documentElement.dir).toBe('ltr')
    view.unmount()
    localStorage.removeItem('passsystem.lang')
  })

  it('never shows server text for an unknown error, and translates it again on a language switch (R4-04)', async () => {
    vi.mocked(api.registerForEvent).mockRejectedValue(new ApiError('INTERNAL_REVIEW4_SENTINEL', 'XX000'))
    localStorage.setItem('passsystem.lang', 'ar')
    const view = render(
      <MemoryRouter initialEntries={['/e/gala']}>
        <LangProvider>
          <Routes>
            <Route path="/e/:slug" element={<RegisterPage />} />
          </Routes>
        </LangProvider>
      </MemoryRouter>,
    )
    fireEvent.change(await screen.findByLabelText('الاسم الأول'), { target: { value: 'Ana' } })
    fireEvent.change(screen.getByLabelText('اسم العائلة'), { target: { value: 'Test' } })
    fireEvent.click(screen.getByRole('button', { name: 'احصل على تذكرتي' }))
    expect(await screen.findByText('حدث خطأ ما. يرجى المحاولة مرة أخرى بعد قليل.')).toBeInTheDocument()
    expect(screen.queryByText(/INTERNAL_REVIEW4_SENTINEL/)).toBeNull()

    fireEvent.click(screen.getByTestId('lang-switch'))
    expect(await screen.findByText('Something went wrong. Please try again in a moment.')).toBeInTheDocument()
    view.unmount()
    localStorage.removeItem('passsystem.lang')
  })

  it('translates field and terms errors again after a language switch (R5-03)', async () => {
    vi.mocked(api.getPublicEvent).mockResolvedValue({ event: withTerms, registrationState: 'open' })
    vi.mocked(api.registerForEvent).mockRejectedValue(new ApiError('PRIVATE_DIAGNOSTIC', 'terms_changed'))
    const view = render(
      <MemoryRouter initialEntries={['/e/gala']}>
        <LangProvider>
          <Routes>
            <Route path="/e/:slug" element={<RegisterPage />} />
          </Routes>
        </LangProvider>
      </MemoryRouter>,
    )
    // A validation error, then a language switch.
    fireEvent.click(await screen.findByRole('button', { name: 'Get my pass' }))
    expect(await screen.findByText('First name is required.')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('lang-switch'))
    expect(await screen.findByText('الاسم الأول مطلوب.')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('lang-switch'))

    // A terms error from the server, then a language switch.
    fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'Ana' } })
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Test' } })
    fireEvent.click(screen.getByLabelText('I have read and accept the attendance terms.'))
    fireEvent.click(screen.getByRole('button', { name: 'Get my pass' }))
    expect(await screen.findByText(translate('en', 'error.terms_changed'))).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('lang-switch'))
    expect(await screen.findByText(translate('ar', 'error.terms_changed'))).toBeInTheDocument()
    expect(screen.queryByText(translate('en', 'error.terms_changed'))).toBeNull()
    expect(screen.queryByText(/PRIVATE_DIAGNOSTIC/)).toBeNull()
    view.unmount()
    localStorage.removeItem('passsystem.lang')
  })
})

// R13-01: a registration that finishes after the guest left the form keeps the
// pass on the device but does not redirect the page they are on now.
describe('RegisterPage late completion (R13-01)', () => {
  const result = {
    token: '87J813AZE9GZXK95NP3GA5F4',
    replayed: false,
    registration: {
      first_name: 'Ana',
      last_name: 'Test',
      status: 'registered' as const,
      registered_at: '2026-10-28T10:00:00Z',
    },
    event,
  }

  beforeEach(() => {
    vi.mocked(api.getPublicEvent).mockResolvedValue({ event, registrationState: 'open' })
    localStorage.clear()
  })

  async function submitThenLeave(leave: (router: ReturnType<typeof createMemoryRouter>) => Promise<void>) {
    let resolve!: (v: typeof result) => void
    vi.mocked(api.registerForEvent).mockReturnValue(new Promise((r) => (resolve = r)))
    const router = createMemoryRouter(
      [
        { path: '/', element: <p>home page</p> },
        { path: '/e/:slug', element: <RegisterPage /> },
        { path: '/pass', element: <p>pass page</p> },
      ],
      { initialEntries: ['/', '/e/gala'], initialIndex: 1 },
    )
    render(
      <LangProvider>
        <RouterProvider router={router} />
      </LangProvider>,
    )
    fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'Ana' } })
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Get my pass' }))
    expect(api.registerForEvent).toHaveBeenCalledTimes(1)
    await act(async () => leave(router))
    await act(async () => resolve(result))
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    return router
  }

  it('after going Back, the guest stays where they are and the pass is saved', async () => {
    const router = await submitThenLeave((r) => r.navigate(-1))
    expect(router.state.location.pathname).toBe('/')
    expect(passesForEvent('gala').map((p) => p.token)).toEqual([result.token])
  })

  it('after opening another event link, that form stays open and empty', async () => {
    const router = await submitThenLeave((r) => r.navigate('/e/spring'))
    expect(router.state.location.pathname).toBe('/e/spring')
    expect(await screen.findByLabelText('First name')).toHaveValue('')
    expect(passesForEvent('gala').map((p) => p.token)).toEqual([result.token])
  })
})

// R14-01: a pass saved after the guest left the form shows up on the page they are on,
// without a reload, and only for its own event.
describe('saved passes appear as they are saved (R14-01)', () => {
  const result = {
    token: '87J813AZE9GZXK95NP3GA5F4',
    replayed: false,
    registration: {
      first_name: 'Ana',
      last_name: 'Test',
      status: 'registered' as const,
      registered_at: '2026-10-28T10:00:00Z',
    },
    event,
  }

  beforeEach(() => {
    vi.mocked(api.getPublicEvent).mockImplementation(async (slug: string) => ({
      event: { ...event, slug, name: slug === 'gala' ? 'Gala' : 'Spring' },
      registrationState: 'open',
    }))
    localStorage.clear()
  })

  async function submitOnGala() {
    let resolve!: (v: typeof result) => void
    vi.mocked(api.registerForEvent).mockReturnValue(new Promise((r) => (resolve = r)))
    const router = createMemoryRouter(
      [
        { path: '/', element: <HomePage /> },
        { path: '/e/:slug', element: <RegisterPage /> },
        { path: '/pass', element: <p>pass page</p> },
      ],
      { initialEntries: ['/', '/e/gala'], initialIndex: 1 },
    )
    render(
      <LangProvider>
        <RouterProvider router={router} />
      </LangProvider>,
    )
    fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'Ana' } })
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Get my pass' }))
    return { router, finish: () => act(async () => resolve(result)) }
  }

  it('Back to Home, then the registration finishes: Home lists the new pass', async () => {
    const { router, finish } = await submitOnGala()
    await act(async () => router.navigate(-1))
    expect(screen.queryByRole('link', { name: /Ana Test/ })).toBeNull()

    await finish()
    expect(router.state.location.pathname).toBe('/')
    expect(passesForEvent('gala').map((p) => p.token)).toEqual([result.token])
    expect(await screen.findByRole('link', { name: /Ana Test/ })).toHaveAttribute(
      'href',
      `/pass#${result.token}`,
    )
  })

  it("Gala -> Spring -> Gala, then it finishes: Gala's form lists it, Spring's never does", async () => {
    const { router, finish } = await submitOnGala()
    await act(async () => router.navigate('/e/spring'))
    await screen.findByLabelText('First name')
    await act(async () => router.navigate('/e/gala')) // back on Gala before the response arrives
    await screen.findByLabelText('First name')
    expect(screen.queryByRole('link', { name: /Ana Test/ })).toBeNull()

    await finish()
    expect(router.state.location.pathname).toBe('/e/gala')
    expect(await screen.findByRole('link', { name: /Ana Test/ })).toHaveAttribute(
      'href',
      `/pass#${result.token}`,
    )
    expect(screen.getByLabelText('First name')).toHaveValue('') // a fresh form, not redirected

    await act(async () => router.navigate('/e/spring'))
    await screen.findByLabelText('First name')
    expect(screen.queryByRole('link', { name: /Ana Test/ })).toBeNull() // never shown as Spring's
  })

  it("while Spring's form is open, a Gala pass never appears there but a Spring pass does", async () => {
    const router = createMemoryRouter([{ path: '/e/:slug', element: <RegisterPage /> }], {
      initialEntries: ['/e/spring'],
    })
    render(
      <LangProvider>
        <RouterProvider router={router} />
      </LangProvider>,
    )
    await screen.findByLabelText('First name')
    await act(async () =>
      savePass({
        token: result.token,
        slug: 'gala',
        eventName: 'Gala',
        attendeeName: 'Ana Test',
        startsAt: event.starts_at,
        savedAt: new Date().toISOString(),
      }),
    )
    expect(screen.queryByRole('link', { name: /Ana Test/ })).toBeNull()
    await act(async () =>
      savePass({
        token: 'SPRINGTOKEN0000000000000',
        slug: 'spring',
        eventName: 'Spring',
        attendeeName: 'Bo Spring',
        startsAt: event.starts_at,
        savedAt: new Date().toISOString(),
      }),
    )
    expect(screen.getByRole('link', { name: /Bo Spring/ })).toBeInTheDocument()
  })
})
