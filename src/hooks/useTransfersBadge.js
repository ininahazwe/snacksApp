import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { fetchBadge, onTransfersChanged } from '../lib/transfersApi'

const POLL_MS = 60000

// Pastille de la boîte « Transfers » : transferts et demandes qui attendent une
// réponse de ma part + nouvelles non lues (acceptation, refus, expiration…).
// Relue toutes les minutes, au retour au premier plan, au retour du réseau et
// après chaque action sur un transfert.
export function useTransfersBadge() {
  const { user, status } = useAuth()
  const uid = user?.id ?? null
  const [badge, setBadge] = useState(0)

  const refresh = useCallback(async () => {
    if (!uid || status !== 'ok' || !navigator.onLine) return
    try {
      const b = await fetchBadge()
      setBadge(Number(b?.total) || 0)
    } catch {
      // Silencieux : hors-ligne, ou fonctions de la phase 3a pas encore déployées.
    }
  }, [uid, status])

  useEffect(() => {
    if (!uid) { setBadge(0); return undefined }
    refresh()
    const onVisible = () => { if (document.visibilityState === 'visible') refresh() }
    const timer = setInterval(onVisible, POLL_MS)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', refresh)
    const off = onTransfersChanged(refresh)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', refresh)
      off()
    }
  }, [uid, refresh])

  return { badge, refresh }
}
