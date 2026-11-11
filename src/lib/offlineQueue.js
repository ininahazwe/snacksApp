// File d'attente des ventes créées hors-ligne, et synchronisation vers
// Supabase au retour du réseau.
//
// Phase 2 : une entrée = UNE vente complète (1 ou plusieurs lignes), rejouée
// par la fonction SQL atomique record_sale — la même que la vente en ligne —
// avec offline:true. Règles côté base :
//   • la vente n'est jamais rejetée pour stock insuffisant : elle est
//     enregistrée et marquée « à vérifier » si le stock du vendeur a changé ;
//   • request_id garantit qu'un rejeu (réponse perdue, nouvel essai) ne
//     duplique jamais la vente.
// Les anciennes entrées (format « une ligne = une entrée », d'avant la
// phase 2) sont converties à la volée.
import { supabase } from './supabase'
import { round2 } from './format'
import { notifyCacheUpdated } from './offlineCache'
import { recordSale, newRequestId } from './stockApi'

const QUEUE_KEY = 'douceurs_pending_sales'

export function getPendingSales() {
  try {
    const raw = localStorage.getItem(QUEUE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function setPendingSales(list) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(list))
  } catch (err) {
    console.error('Impossible de sauvegarder la file de ventes hors-ligne :', err)
  }
}

// Ajoute une vente à la file d'attente locale. Retourne l'entrée créée
// (avec son localId) pour affichage immédiat (reçu, toast…).
// Format v2 : { v: 2, user_id, payload: <payload record_sale>, summary: { amount, lines } }
export function enqueueSale(entry) {
  const list = getPendingSales()
  const withId = {
    ...entry,
    localId: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    queuedAt: new Date().toISOString(),
  }
  list.push(withId)
  setPendingSales(list)
  return withId
}

export function removePendingSale(localId) {
  setPendingSales(getPendingSales().filter(p => p.localId !== localId))
}

// Convertit une ancienne entrée (une ligne de vente) vers le payload record_sale.
function legacyToPayload(e) {
  const credit  = e.appliedCredit || 0
  const created = e.newCreditFromChange || 0
  const due     = e.amountDue ?? e.amount
  // Ancien panier : amount = total de la ligne − part d'avoir ; ancienne vente simple : amount = total.
  const lineTotal = e.group_id ? round2((e.amount ?? 0) + credit) : (e.amount ?? 0)
  return {
    group_id: e.group_id ?? null,
    offline: true,
    client_id: e.client_id ?? null,
    payment_type: e.type,
    credit_applied: credit,
    cash_received: created > 0 ? round2(due + created) : null,
    save_change_as_credit: created > 0,
    lines: [{
      product_id: e.product_id,
      qty: e.qty,
      unit_price: e.original_amount != null && e.qty > 0 ? round2(lineTotal / e.qty) : null,
      discount_reason: e.discount_reason ?? null,
    }],
  }
}

// Garantit qu'une entrée porte un request_id STABLE (persisté avant l'envoi) :
// si la réponse du serveur se perd, le rejeu retombe sur la même requête.
function ensureRequestId(entry) {
  if (entry.v === 2) {
    if (!entry.payload.request_id) entry.payload.request_id = newRequestId()
  } else {
    if (!entry.request_id) entry.request_id = newRequestId()
  }
  const queue = getPendingSales().map(p => p.localId === entry.localId ? entry : p)
  setPendingSales(queue)
}

export async function syncOneSale(entry) {
  ensureRequestId(entry)
  const payload = entry.v === 2
    ? { ...entry.payload, offline: true }
    : { ...legacyToPayload(entry), request_id: entry.request_id, offline: true }
  await recordSale(payload)
}

// Rejoue toutes les ventes en attente, dans l'ordre où elles ont été créées.
// Une entrée qui échoue reste en file (retentée à la prochaine synchro)
// plutôt que d'être perdue.
export async function flushPendingSales() {
  const queue = getPendingSales()
  if (!queue.length) return { synced: 0, failed: 0, remaining: 0 }

  // Session absente (déconnexion) : on ne tente rien, on garde la file.
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return { synced: 0, failed: queue.length, remaining: queue.length }

  let synced = 0
  const failedIds = new Set()
  for (const entry of queue) {
    // Une vente hors-ligne consomme le stock de la personne qui la synchronise :
    // on ne rejoue donc que les entrées saisies par l'utilisateur connecté
    // (les autres restent en file, pour leur auteur).
    const author = entry.user_id ?? entry.summary?.user_id ?? null
    if (author && author !== session.user.id) { failedIds.add(entry.localId); continue }
    try {
      await syncOneSale(entry)
      removePendingSale(entry.localId)
      synced++
    } catch (err) {
      console.error('Échec de synchronisation pour', entry.localId, err)
      failedIds.add(entry.localId)
    }
  }
  if (synced > 0) notifyCacheUpdated()
  return { synced, failed: failedIds.size, remaining: getPendingSales().length }
}
