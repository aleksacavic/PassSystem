// Shared by the administrator-only Edge Functions (invite-staff, remove-staff):
// service-role requests and "is the caller a PassSystem administrator?".

export interface Supa {
  url: string
  serviceKey: string
}

export function serviceHeaders(s: Supa): Record<string, string> {
  return { apikey: s.serviceKey, Authorization: `Bearer ${s.serviceKey}`, 'Content-Type': 'application/json' }
}

/** The signed-in caller, from their access token (null if invalid). */
export async function getCaller(s: Supa, jwt: string): Promise<{ id: string } | null> {
  const res = await fetch(`${s.url}/auth/v1/user`, {
    headers: { apikey: s.serviceKey, Authorization: `Bearer ${jwt}` },
  })
  if (!res.ok) return null
  const user = (await res.json()) as { id?: string }
  return user.id ? { id: user.id } : null
}

export interface ProfileRow {
  id: string
  email: string
  is_admin: boolean
}

export async function getProfile(s: Supa, userId: string): Promise<ProfileRow | null> {
  const res = await fetch(
    `${s.url}/rest/v1/profiles?select=id,email,is_admin&id=eq.${encodeURIComponent(userId)}`,
    { headers: serviceHeaders(s) },
  )
  if (!res.ok) return null
  const rows = (await res.json()) as ProfileRow[]
  return rows[0] ?? null
}

export async function isAdmin(s: Supa, userId: string): Promise<boolean> {
  return (await getProfile(s, userId))?.is_admin === true
}
