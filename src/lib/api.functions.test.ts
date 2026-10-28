import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('./supabase', () => ({ supabase: { functions: { invoke } } }))
import { googleWalletSaveUrl, inviteStaff } from './api'

describe('Edge Function error handling', () => {
  beforeEach(() => invoke.mockReset())

  it('function not deployed / unreachable (no response): readable message, no internals', async () => {
    // What production returned before the invite function was deployed.
    invoke.mockResolvedValue({
      data: null,
      error: { message: 'Failed to send a request', context: new TypeError('x') },
    })
    const err = await inviteStaff('a@b.org', false).catch((e: Error) => e)
    expect(err.message).toMatch(/not available yet.*Supabase dashboard/)
    expect(err.message).not.toMatch(/json is not a function/)
  })

  it('404 from the gateway: not deployed', async () => {
    invoke.mockResolvedValue({
      data: null,
      error: { context: new Response('{"code":"NOT_FOUND"}', { status: 404 }) },
    })
    await expect(inviteStaff('a@b.org', false)).rejects.toMatchObject({ code: 'function_not_deployed' })
  })

  it("passes through the function's own error message", async () => {
    const body = JSON.stringify({
      ok: false,
      error: 'user_exists',
      message: 'This person already has an account.',
    })
    invoke.mockResolvedValue({ data: null, error: { context: new Response(body, { status: 409 }) } })
    await expect(inviteStaff('a@b.org', false)).rejects.toMatchObject({
      code: 'user_exists',
      message: 'This person already has an account.',
    })
  })

  it('non-JSON error body', async () => {
    invoke.mockResolvedValue({ data: null, error: { context: new Response('<html>', { status: 502 }) } })
    await expect(inviteStaff('a@b.org', false)).rejects.toMatchObject({ code: 'function_error' })
  })

  it('google wallet: only pay.google.com save links are accepted', async () => {
    invoke.mockResolvedValue({ data: { ok: true, url: 'https://pay.google.com/gp/v/save/abc' }, error: null })
    expect(await googleWalletSaveUrl('T')).toBe('https://pay.google.com/gp/v/save/abc')
    invoke.mockResolvedValue({ data: { ok: true, url: 'https://evil.example/' }, error: null })
    await expect(googleWalletSaveUrl('T')).rejects.toThrow(/Unexpected/)
  })
})
