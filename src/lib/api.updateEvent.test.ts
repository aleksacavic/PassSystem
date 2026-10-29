// R9-01: an event update states what it expects to overwrite, and a stale one is refused.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  filters: [] as [string, unknown][],
  result: { data: null as unknown, error: null },
}))
vi.mock('./supabase', () => {
  const query = {
    update: () => query,
    eq: (column: string, value: unknown) => {
      db.filters.push([column, value])
      return query
    },
    select: () => query,
    maybeSingle: async () => db.result,
  }
  return { supabase: { from: () => query } }
})
import { updateEvent } from './api'

beforeEach(() => {
  db.filters = []
  db.result = { data: { id: 'ev-1', status: 'archived' }, error: null }
})

describe('updateEvent', () => {
  it('only updates the version the edit form loaded', async () => {
    await updateEvent('ev-1', { name: 'Renamed' }, { updatedAt: '2026-10-29T08:00:00.123456+00:00' })
    expect(db.filters).toEqual([
      ['id', 'ev-1'],
      ['updated_at', '2026-10-29T08:00:00.123456+00:00'],
    ])
  })

  it('only archives or restores from the status the card showed', async () => {
    await updateEvent('ev-1', { status: 'archived' }, { status: 'published' })
    expect(db.filters).toEqual([
      ['id', 'ev-1'],
      ['status', 'published'],
    ])
  })

  it('reports a conflict when someone else changed the event meanwhile', async () => {
    db.result = { data: null, error: null } // no row matched the expectation
    await expect(updateEvent('ev-1', { name: 'Renamed' }, { updatedAt: 'old' })).rejects.toMatchObject({
      code: 'edit_conflict',
      message: expect.stringContaining('changed by someone else'),
    })
  })

  it('without an expectation, no matching row means no permission', async () => {
    db.result = { data: null, error: null }
    await expect(updateEvent('ev-1', { name: 'Renamed' })).rejects.toMatchObject({ code: 'not_authorized' })
  })
})
