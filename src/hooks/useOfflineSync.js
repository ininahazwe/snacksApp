import { useCallback, useEffect, useState } from 'react'
import { flushPendingSales, getPendingSales } from '../lib/offlineQueue'

// Synchronise automatiquement les ventes mises en attente hors-ligne dès
// que le réseau revient, et expose un décompte + une action manuelle pour
// l'afficher dans l'UI (OfflineBanner).
export function useOfflineSync() {
  const [pendingCount, setPendingCount] = useState(() => getPendingSales().length)
  const [syncing, setSyncing] = useState(false)

  const syncNow = useCallback(async () => {
    if (!navigator.onLine || syncing) return
    setSyncing(true)
    try {
      await flushPendingSales()
    } finally {
      setPendingCount(getPendingSales().length)
      setSyncing(false)
    }
  }, [syncing])

  useEffect(() => {
    syncNow()
    const handleOnline = () => syncNow()
    window.addEventListener('online', handleOnline)
    // Recompte régulier : une vente peut être mise en file depuis SaleModal
    // sans passer par ce hook (pas d'event dédié pour l'ajout).
    const interval = setInterval(() => setPendingCount(getPendingSales().length), 4000)
    return () => {
      window.removeEventListener('online', handleOnline)
      clearInterval(interval)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { pendingCount, syncing, syncNow }
}
