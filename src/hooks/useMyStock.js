import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { fetchMyStock, getCachedMyStock, cacheMyStock } from '../lib/stockApi'
import { onCacheUpdated } from '../lib/offlineCache'

// Stock vendable par l'utilisateur connecté : { [productId]: quantité }.
// Lit d'abord le cache local (hors-ligne / affichage immédiat), puis la base.
export function useMyStock() {
  const { user } = useAuth()
  const uid = user?.id ?? null
  const [myStock, setMyStock] = useState(() => (uid ? getCachedMyStock(uid) : {}))
  const [loading, setLoading] = useState(!!uid && navigator.onLine)

  const refresh = useCallback(async () => {
    if (!uid) { setMyStock({}); setLoading(false); return }
    if (!navigator.onLine) { setMyStock(getCachedMyStock(uid)); setLoading(false); return }
    try {
      const map = await fetchMyStock(uid)
      cacheMyStock(uid, map)
      setMyStock(map)
    } catch {
      setMyStock(getCachedMyStock(uid))
    }
    setLoading(false)
  }, [uid])

  useEffect(() => {
    refresh()
    // Une vente vient de modifier le cache local : on le relit sans attendre le réseau.
    return onCacheUpdated(() => { if (uid) setMyStock(getCachedMyStock(uid)) })
  }, [refresh, uid])

  return { myStock, loading, refresh }
}
