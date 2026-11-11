import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const AuthContext = createContext(null)

// Rôles (table public.profiles — source de vérité côté base) :
//   'admin'   → tous les droits du manager + gestion des comptes (écran Team)
//   'manager' → dashboard, clients, inventaire, produits, annulation de ventes,
//               historique de toutes les ventes
//   'cashier' → vente + consultation des produits ; voit uniquement SES ventes
//
// Le rôle n'est PLUS lu dans user_metadata (modifiable par l'utilisateur lui-même).
// Ici il ne sert qu'à l'affichage : la vraie protection est dans les règles RLS.

const PROFILE_CACHE_KEY = 'douceurs_profile_v1'

const readCachedProfile = (uid) => {
  try {
    const raw = localStorage.getItem(PROFILE_CACHE_KEY)
    const p = raw ? JSON.parse(raw) : null
    return p && p.id === uid ? p : null
  } catch { return null }
}
const writeCachedProfile = (p) => {
  try {
    if (p) localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(p))
    else localStorage.removeItem(PROFILE_CACHE_KEY)
  } catch { /* stockage indisponible : on ignore */ }
}

// status : 'ok' (profil actif) | 'pending' (compte non activé / sans profil) | 'error' (profil illisible)
async function fetchProfile(uid) {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, display_name, role, active')
      .eq('id', uid)
      .maybeSingle()
    if (error) throw error
    if (!data) { writeCachedProfile(null); return { profile: null, status: 'pending' } }
    writeCachedProfile(data)
    return { profile: data, status: data.active ? 'ok' : 'pending' }
  } catch {
    // Hors-ligne ou erreur réseau : on retombe sur le dernier profil connu pour
    // ce même utilisateur, afin que la caisse reste utilisable sans connexion.
    const cached = readCachedProfile(uid)
    if (cached) return { profile: cached, status: cached.active ? 'ok' : 'pending' }
    return { profile: null, status: 'error' }
  }
}

export function AuthProvider({ children }) {
  const [user,      setUser]      = useState(null)
  const [authReady, setAuthReady] = useState(false)
  // Profil chargé pour un utilisateur donné : { uid, profile, status }
  const [loaded,    setLoaded]    = useState({ uid: null, profile: null, status: null })

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      setAuthReady(true)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
    })
    return () => subscription.unsubscribe()
  }, [])

  const uid = user?.id ?? null

  const loadProfile = useCallback(async () => {
    if (!uid) { setLoaded(l => (l.uid === null ? l : { uid: null, profile: null, status: null })); return }
    const res = await fetchProfile(uid)
    setLoaded({ uid, profile: res.profile, status: res.status })
  }, [uid])

  useEffect(() => { loadProfile() }, [loadProfile])

  // Rafraîchit le profil quand l'app revient au premier plan : un changement de
  // rôle ou une désactivation décidée par l'admin est ainsi prise en compte.
  useEffect(() => {
    if (!uid) return
    const onVisible = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) loadProfile()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [uid, loadProfile])

  const login = async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
    return data
  }

  const logout = async () => {
    writeCachedProfile(null)
    await supabase.auth.signOut()
  }

  // Tant que le profil de l'utilisateur courant n'est pas chargé, on reste en "loading"
  // (jamais d'écran rendu avec un rôle encore inconnu).
  const profileForUser = loaded.uid === uid
  const profile = profileForUser ? loaded.profile : null
  const status  = profileForUser ? loaded.status  : null
  const loading = !authReady || (!!uid && !profileForUser)
  const role    = status === 'ok' ? (profile?.role ?? null) : null

  // Helpers de vérification
  const estAdmin   = role === 'admin'
  const estManager = role === 'manager'
  const estCashier = role === 'cashier'
  // « gérant » = manager OU admin (l'admin a tous les droits du manager).
  // Nom conservé pour ne pas toucher tous les appelants existants.
  const estGerant  = estAdmin || estManager
  const estVendeur = estAdmin || estManager || estCashier

  return (
    <AuthContext.Provider value={{
      user, profile, role, status, loading, login, logout, refreshProfile: loadProfile,
      estAdmin, estManager, estCashier, estGerant, estVendeur,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth doit être utilisé dans AuthProvider')
  return ctx
}
