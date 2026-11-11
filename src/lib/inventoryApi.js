// Inventaire (comptage et écarts), réattribution du stock et suivi par personne
// (phase 3b). Tout passe par des fonctions SQL atomiques — voir
// backup-scripts/phase3b_reattribution_inventaire.sql. En ligne uniquement.
import { rpc } from './stockApi'

// Comptage d'un produit. owner = personne dont on compte le stock (null = soi-même ;
// un manager/admin peut compter le stock de quelqu'un d'autre). S'il y a un
// écart, il est appliqué tout de suite : reason est alors obligatoire.
export const declareInventory = ({ productId, counted, reason = null, note = null, owner = null, clientRef = null }) =>
  rpc('declare_inventory', {
    p_product: productId, p_counted: counted, p_reason: reason,
    p_note: note || null, p_owner: owner, p_client_ref: clientRef,
  })

// Réattribution (manager/admin), appliquée sans acceptation.
// productId null = tout le stock de `from` ; qty null = tout le produit.
export const reassignStock = ({ from, to, productId = null, qty = null, note = null, clientRef = null }) =>
  rpc('reassign_stock', {
    p_from: from, p_to: to, p_product: productId, p_qty: qty,
    p_note: note || null, p_client_ref: clientRef,
  })

// Une ligne par personne : unités, valeur, écarts sur 30 jours (toute l'équipe
// pour un manager/admin, sa propre ligne pour un cashier).
export const fetchHoldersSummary = () => rpc('holders_summary', {})

// Détail d'une personne : { holdings, counts, movements } (null = soi-même)
export const fetchHolderDetail = (owner = null) => rpc('holder_detail', { p_owner: owner })

// Motifs d'écart (mêmes codes que la base)
export const SHORTAGE_REASONS = [
  ['damaged', 'Damaged / broken'],
  ['expired', 'Expired'],
  ['lost', 'Lost'],
  ['stolen', 'Stolen'],
  ['count_error', 'Earlier counting error'],
  ['other', 'Other (describe)'],
]
export const SURPLUS_REASONS = [
  ['found', 'Found / not recorded'],
  ['count_error', 'Earlier counting error'],
  ['other', 'Other (describe)'],
]

const REASON_LABELS = {
  damaged: 'Damaged', expired: 'Expired', lost: 'Lost', stolen: 'Stolen',
  count_error: 'Counting error', found: 'Found', other: 'Other',
}
export const reasonLabel = (code) => REASON_LABELS[code] ?? code ?? ''

// Libellé d'un mouvement de stock (stock_movements.reason)
export function movementLabel(reason) {
  if (!reason) return 'Stock movement'
  if (reason.startsWith('inventory_')) return `Count — ${reasonLabel(reason.slice('inventory_'.length)).toLowerCase()}`
  switch (reason) {
    case 'vente': return 'Sale'
    case 'vente (sync hors-ligne)': return 'Sale (offline sync)'
    case 'reception_carton': return 'Restock'
    case 'transfer_out': return 'Given to a colleague'
    case 'transfer_in': return 'Received from a colleague'
    default: return reason
  }
}
