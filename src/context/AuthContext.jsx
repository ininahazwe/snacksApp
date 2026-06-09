import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const AuthContext = createContext(null)

// Rôles disponibles :
//   'gerant'  → accès complet (dashboard, ventes, produits, clients, stocks)
//   'vendeur' → accès limité (ventes + produits uniquement)

const extraireRole = (user) => user?.user_metadata?.role ?? 'vendeur'

export function AuthProvider({ children }) {
  const [user,    setUser]    = useState(null)
  const [role,    setRole]    = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      setRole(session?.user ? extraireRole(session.user) : null)
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
      setRole(session?.user ? extraireRole(session.user) : null)
    })

    return () => subscription.unsubscribe()
  }, [])

  const login = async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
    return data
  }

  const logout = async () => {
    await supabase.auth.signOut()
  }

  // Helpers de vérification
  const estGerant  = role === 'gerant'
  const estVendeur = role === 'vendeur' || role === 'gerant' // gérant peut tout faire

  return (
    <AuthContext.Provider value={{ user, role, loading, login, logout, estGerant, estVendeur }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth doit être utilisé dans AuthProvider')
  return ctx
}
