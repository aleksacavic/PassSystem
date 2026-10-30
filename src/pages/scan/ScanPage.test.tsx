import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ admitPass: vi.fn(), getEventSummaries: vi.fn() }))
const cam = vi.hoisted(() => ({ onDetect: null as null | ((raw: string) => void) }))
vi.mock('../../lib/api', () => api)
vi.mock('../../scanner/useCameraScanner', () => ({
  useCameraScanner: ({ onDetect }: { onDetect: (raw: string) => void }) => {
    cam.onDetect = onDetect
    return {
      videoRef: { current: null },
      status: 'running',
      error: null,
      start: vi.fn(),
      stop: vi.fn(),
      torchSupported: false,
      torchOn: false,
      toggleTorch: vi.fn(),
      cameraCount: 1,
      switchCamera: vi.fn(),
    }
  },
}))
vi.mock('../../scanner/useWakeLock', () => ({ useWakeLock: () => undefined }))
vi.mock('../../scanner/feedback', () => ({ feedback: vi.fn(), unlockAudio: vi.fn() }))
import ScanPage from './ScanPage'

const TOKEN = 'ABCDEFGHJKMNPQRSTVWXYZ01'
const summary = (id: string, name: string) => ({
  id,
  name,
  slug: id,
  status: 'published',
  starts_at: '2026-11-01T18:00:00Z',
  ends_at: null,
  location: null,
  timezone: 'Europe/Belgrade',
  max_attendees: null,
  my_role: 'operator',
  registered_count: 10,
  checked_in_count: 0,
  revoked_count: 0,
})
const resp = (result: string, extra = {}) => ({
  kind: 'response',
  response: {
    result,
    reason: 'r',
    attendee: { first_name: 'Ana', last_name: 'T' },
    checked_in_at: '2026-11-01T18:00:00Z',
    event: { id: 'A', name: 'Event A' },
    scanned_at: '2026-11-01T18:00:00Z',
    ...extra,
  },
})

const navRef: { current: (p: string) => void } = { current: () => undefined }
function Nav() {
  const navigate = useNavigate()
  useEffect(() => {
    navRef.current = (p: string) => void navigate(p)
  }, [navigate])
  return null
}
function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Nav />
      <Routes>
        <Route path="/scan/:eventId" element={<ScanPage />} />
      </Routes>
    </MemoryRouter>,
  )
}
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })

beforeEach(() => {
  api.admitPass.mockReset()
  api.getEventSummaries.mockReset()
  api.getEventSummaries.mockImplementation(async (id: string) => [summary(id, `Event ${id}`)])
})

describe('the scanner shows green only for a server-confirmed admission', () => {
  for (const [label, outcome] of [
    ['network error', { kind: 'error', message: 'Network error' }],
    ['denied', { kind: 'denied', message: 'no' }],
    ['already_used', resp('already_used')],
    ['wrong_event', resp('wrong_event')],
    ['unexpected result string', resp('ADMITTED')],
  ] as const) {
    it(`no green for ${label}`, async () => {
      api.admitPass.mockResolvedValue(outcome)
      renderAt('/scan/A')
      await flush()
      await act(async () => cam.onDetect!(TOKEN))
      await flush()
      expect(screen.queryByTestId('scan-result-ok')).toBeNull()
    })
  }

  it('non-pass QR content never reaches the server', async () => {
    renderAt('/scan/A')
    await flush()
    await act(async () => cam.onDetect!('https://evil.example/whatever'))
    await flush()
    expect(api.admitPass).not.toHaveBeenCalled()
    expect(screen.getByTestId('scan-result-bad')).toHaveTextContent('NOT A VALID PASS')
  })

  it('green for admitted', async () => {
    api.admitPass.mockResolvedValue(resp('admitted'))
    renderAt('/scan/A')
    await flush()
    await act(async () => cam.onDetect!(TOKEN))
    await flush()
    expect(screen.getByTestId('scan-result-ok')).toHaveTextContent('ADMITTED')
  })
})

describe('[F-01] retry after a timeout', () => {
  it('reuses the attempt id, and a replayed admission is shown green as confirmed', async () => {
    api.admitPass
      .mockResolvedValueOnce({ kind: 'error', message: 'The server did not respond in time.' })
      .mockResolvedValueOnce(resp('admitted', { replayed: true }))
    renderAt('/scan/A')
    await flush()
    await act(async () => cam.onDetect!(TOKEN))
    await flush()
    expect(screen.getByTestId('scan-result-warn')).toBeInTheDocument()
    await act(async () => screen.getByRole('button', { name: 'Retry' }).click())
    await flush()
    const [first, second] = api.admitPass.mock.calls
    expect(second![2]).toBe(first![2]) // same attempt id
    expect(screen.getByTestId('scan-result-ok')).toHaveTextContent('ADMITTED')
    expect(screen.getByTestId('scan-result-replayed')).toBeInTheDocument()
  })

  it('a new scan of the same pass uses a new attempt id', async () => {
    api.admitPass.mockResolvedValue(resp('already_used'))
    renderAt('/scan/A')
    await flush()
    await act(async () => cam.onDetect!(TOKEN))
    await flush()
    const input = screen.getByLabelText('Pass code')
    fireEvent.change(input, { target: { value: TOKEN } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Check' })))
    await flush()
    expect(api.admitPass).toHaveBeenCalledTimes(2)
    const [first, second] = api.admitPass.mock.calls
    expect(second![2]).not.toBe(first![2])
  })
})

describe('[F-13] switching events', () => {
  it('never shows the previous event while scans would go to the new one', async () => {
    api.getEventSummaries.mockImplementation((id: string) =>
      id === 'A' ? Promise.resolve([summary('A', 'Event A')]) : new Promise(() => undefined),
    )
    api.admitPass.mockResolvedValue(resp('admitted'))
    renderAt('/scan/A')
    await flush()
    expect(screen.getByTestId('scan-event')).toHaveTextContent('Event A')
    await act(async () => navRef.current('/scan/B'))
    await flush()
    expect(screen.queryByTestId('scan-event')).toBeNull() // B still loading: no stale header
    expect(api.admitPass).not.toHaveBeenCalledWith('B', TOKEN, expect.anything())
  })
})
