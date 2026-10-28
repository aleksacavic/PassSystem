import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import type { Profile } from '../lib/types'

// Captured before supabase-js consumes the URL fragment of invite/recovery links.
const initialHashType =
  typeof window !== 'undefined'
    ? new URLSearchParams(window.location.hash.replace(/^#/, '')).get('type')
    : null

interface AuthState {
  loading: boolean
  session: Session | null
  profile: Profile | null
  /** False while the signed-in user's profile is still being fetched. */
  profileReady: boolean
  isAdmin: boolean
  /** True after an invite or password-recovery link: user must choose a password. */
  needsPassword: boolean
  clearNeedsPassword: () => void
  refreshProfile: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

async function fetchProfile(userId: string): Promise<Profile | null> {
  const { data } = await supabase
    .from('profiles')
    .select('id,email,display_name,is_admin,created_at,confirmed_at')
    .eq('id', userId)
    .maybeSingle()
  return (data as Profile | null) ?? null
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [profileFor, setProfileFor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [needsPassword, setNeedsPassword] = useState(
    initialHashType === 'invite' || initialHashType === 'recovery',
  )

  useEffect(() => {
    let active = true
    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return
      setSession(data.session)
      if (data.session) {
        const p = await fetchProfile(data.session.user.id)
        if (!active) return
        setProfile(p)
        setProfileFor(data.session.user.id)
      }
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      if (!active) return
      if (event === 'PASSWORD_RECOVERY') setNeedsPassword(true)
      setSession(next)
      if (!next) {
        setProfile(null)
        setProfileFor(null)
        return
      }
      if (event === 'SIGNED_IN' || event === 'USER_UPDATED' || event === 'INITIAL_SESSION') {
        // Defer: calling Supabase inside the callback can deadlock the auth lock.
        setTimeout(() => {
          fetchProfile(next.user.id).then((p) => {
            if (!active) return
            setProfile(p)
            setProfileFor(next.user.id)
          })
        }, 0)
      }
    })
    return () => {
      active = false
      sub.subscription.unsubscribe()
    }
  }, [])

  const refreshProfile = useCallback(async () => {
    if (session) {
      setProfile(await fetchProfile(session.user.id))
      setProfileFor(session.user.id)
    }
  }, [session])

  const signOut = useCallback(async () => {
    // Local scope: signing out one door phone must not sign out the same account elsewhere.
    await supabase.auth.signOut({ scope: 'local' })
    setSession(null)
    setProfile(null)
    setProfileFor(null)
  }, [])

  const value = useMemo<AuthState>(
    () => ({
      loading,
      session,
      profile,
      profileReady: !session || profileFor === session.user.id,
      isAdmin: Boolean(profile?.is_admin),
      needsPassword,
      clearNeedsPassword: () => setNeedsPassword(false),
      refreshProfile,
      signOut,
    }),
    [loading, session, profile, profileFor, needsPassword, refreshProfile, signOut],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
