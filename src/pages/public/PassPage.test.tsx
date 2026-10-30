// A pass for an archived event is kept but shown as not active (R9-02).
import { act, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getPass: vi.fn() }))
vi.mock('../../lib/api', () => api)
vi.mock('../../components/useQrDataUrl', () => ({ useQrDataUrl: () => 'data:image/png;base64,AAAA' }))
vi.mock('../../components/GoogleWalletButton', () => ({
  GoogleWalletButton: () => <button type="button">Add to Google Wallet</button>,
}))
import PassPage from './PassPage'

const TOKEN = 'ABCDEFGHJKMNPQRSTVWXYZ01'
const event = (status: string) => ({
  name: 'Autumn Gala',
  slug: 'autumn-gala',
  description: null,
  location: 'Hall',
  timezone: 'Asia/Dubai',
  starts_at: '2026-11-06T16:00:00Z',
  ends_at: null,
  registration_opens_at: null,
  registration_closes_at: null,
  status,
})
const pass = {
  first_name: 'Ana',
  last_name: 'Test',
  status: 'registered',
  registered_at: '2026-10-29T08:00:00Z',
  checked_in_at: null,
}

async function renderPass() {
  render(
    <MemoryRouter initialEntries={[`/pass#${TOKEN}`]}>
      <Routes>
        <Route path="/pass" element={<PassPage />} />
      </Routes>
    </MemoryRouter>,
  )
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

beforeEach(() => {
  api.getPass.mockReset()
  localStorage.clear()
})

describe('PassPage', () => {
  it('shows a valid, usable pass for a published event', async () => {
    api.getPass.mockResolvedValue({ pass, event: event('published') })
    await renderPass()
    expect(screen.getByText('Valid')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Add to calendar/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add to Google Wallet' })).toBeInTheDocument()
  })

  it('shows a pass of an archived event as not active, without entry or Wallet actions', async () => {
    api.getPass.mockResolvedValue({ pass, event: event('archived') })
    await renderPass()
    expect(screen.queryByText('Valid')).toBeNull()
    expect(screen.getByText('Not active')).toBeInTheDocument()
    expect(screen.getByTestId('pass-inactive')).toHaveTextContent('no longer active')
    expect(screen.queryByRole('button', { name: /Add to calendar/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add to Google Wallet' })).toBeNull()
    expect(screen.getByTestId('pass-name')).toHaveTextContent('Ana Test') // the pass itself is kept
  })
})
