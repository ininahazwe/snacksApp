// Transferts de stock entre utilisateurs, demandes de stock et notifications
// (phase 3a). Tout passe par des fonctions SQL atomiques — voir
// backup-scripts/phase3a_transferts_notifications.sql. Ces opérations exigent
// d'être en ligne (pas de file hors-ligne).
import { rpc, fetchMyStock, cacheMyStock } from './stockApi'
import { notifyCacheUpdated } from './offlineCache'

const CHANGED_EVENT = 'douceurs-transfers-changed'

// Prévient la pastille (et toute vue ouverte) qu'un transfert / une demande a changé
export function notifyTransfersChanged() {
  try { window.dispatchEvent(new Event(CHANGED_EVENT)) } catch { /* ignore */ }
}

export function onTransfersChanged(handler) {
  window.addEventListener(CHANGED_EVENT, handler)
  return () => window.removeEventListener(CHANGED_EVENT, handler)
}

// Envoi : la quantité est réservée chez l'expéditeur jusqu'à la réponse (72 h).
// requestId = demande de stock à laquelle ce transfert répond (facultatif) ;
// clientRef = identifiant d'idempotence (un double envoi ne réserve pas deux fois).
export const sendTransfer = ({ to, productId, qty, note = null, requestId = null, clientRef = null }) =>
  rpc('send_transfer', {
    p_to: to, p_product: productId, p_qty: qty,
    p_note: note || null, p_request: requestId, p_client_ref: clientRef,
  })

// action : 'accept' (qty facultatif = acceptation partielle) | 'refuse' (reason obligatoire)
export const respondTransfer = (transferId, action, { qty = null, reason = null } = {}) =>
  rpc('respond_transfer', { p_transfer: transferId, p_action: action, p_qty: qty, p_reason: reason })

export const cancelTransfer = (transferId) => rpc('cancel_transfer', { p_transfer: transferId })

export const requestStock = ({ target, productId, qty, note = null, clientRef = null }) =>
  rpc('request_stock', {
    p_target: target, p_product: productId, p_qty: qty,
    p_note: note || null, p_client_ref: clientRef,
  })

export const declineRequest = (requestId, reason) =>
  rpc('decline_request', { p_request: requestId, p_reason: reason })

export const cancelRequest = (requestId) => rpc('cancel_request', { p_request: requestId })

// Boîte « Transfers » : { incoming, outgoing, requests_in, requests_out,
// history_transfers, history_requests, notifications }.
// all = true : un manager/admin voit l'historique de toute l'équipe.
export const fetchInbox = (all = false) => rpc('transfers_inbox', { p_all: all })

// Pastille : { incoming, requests, unread, total }
export const fetchBadge = () => rpc('transfers_badge', {})

export const markNotificationsRead = () => rpc('mark_notifications_read', {})

// Collègues actifs : [{ id, name, role }]
export const listColleagues = () => rpc('list_colleagues', {})

// Un transfert change le stock vendable (réservation, réception, retour) :
// on relit le stock détenu et on met à jour le cache utilisé par la vente.
export async function refreshMyStockCache(userId) {
  if (!userId || !navigator.onLine) return
  try {
    const map = await fetchMyStock(userId)
    cacheMyStock(userId, map)
    notifyCacheUpdated()
  } catch { /* le cache sera rafraîchi au prochain affichage */ }
}
