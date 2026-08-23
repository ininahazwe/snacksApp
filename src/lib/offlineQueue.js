// File d'attente des ventes créées hors-ligne, et logique de synchronisation
// vers Supabase au retour du réseau. `syncOneSale` rejoue exactement les
// mêmes étapes que le chemin en ligne de SaleModal, pour n'avoir qu'une
// seule logique métier à maintenir.
import { supabase } from './supabase'
import { round2 } from './format'
import { notifyCacheUpdated } from './offlineCache'

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

// Rejoue une vente en attente. Le stock est relu au moment de la synchro
// (pas figé au moment de la vente hors-ligne) pour rester correct même si
// plusieurs ventes hors-ligne pour le même produit sont synchronisées à la suite.
export async function syncOneSale(entry) {
  // Stock relu au moment de la synchro : on refuse de vendre plus que ce qui
  // est réellement disponible à cet instant (l'entrée reste en file, à
  // régler manuellement, plutôt que de faire passer le stock sous zéro).
  const { data: currentProduct, error: prodFetchError } = await supabase
      .from('products').select('stock').eq('id', entry.product_id).single()
  if (prodFetchError) throw prodFetchError
  if (entry.qty > (currentProduct?.stock ?? 0)) {
    throw new Error(`Insufficient stock to sync offline sale of "${entry.product_name}" (needs ${entry.qty}, has ${currentProduct?.stock ?? 0})`)
  }

  const { data: batches, error: batchError } = await supabase
      .from('stock_batches')
      .select(`*, stock_movements (delta)`)
      .eq('product_id', entry.product_id)
      .is('exhausted_at', null)
      .order('received_at', { ascending: true })
      .limit(1)
  if (batchError) throw batchError
  const activeBatch = batches?.[0] ?? null

  // Déterminer si cette vente épuise le lot AVANT d'insérer la vente, pour
  // pouvoir l'enregistrer directement sur la ligne `sales` (voir SaleModal
  // pour la même logique côté en-ligne).
  let willExhaustBatch = false
  if (activeBatch) {
    const pastDeltasSum = activeBatch.stock_movements?.reduce((sum, mov) => sum + mov.delta, 0) || 0
    const batchRemainingStock = activeBatch.received_qty + pastDeltasSum - entry.qty
    willExhaustBatch = batchRemainingStock <= 0
  }

  const { error: saleError } = await supabase.from('sales').insert({
    product_id: entry.product_id,
    client_id: entry.client_id,
    user_id: entry.user_id,
    qty: entry.qty,
    amount: entry.amount,
    type: entry.type,
    batch_id: activeBatch?.id ?? null,
    batch_was_exhausted: willExhaustBatch,
    original_amount: entry.original_amount ?? null,
    discount_reason: entry.discount_reason ?? null,
  })
  if (saleError) throw saleError

  const newStock = (currentProduct?.stock ?? 0) - entry.qty
  const { error: stockError } = await supabase
      .from('products').update({ stock: newStock }).eq('id', entry.product_id)
  if (stockError) throw stockError

  const { error: movError } = await supabase.from('stock_movements').insert({
    product_id: entry.product_id,
    batch_id: activeBatch?.id ?? null,
    delta: -entry.qty,
    reason: 'vente (sync hors-ligne)',
  })
  if (movError) console.error('Erreur mouvement (sync hors-ligne) :', movError)

  if (activeBatch && willExhaustBatch) {
    const now = new Date()
    const receivedAt = new Date(activeBatch.received_at)
    const durationDays = Math.round((now - receivedAt) / (1000 * 60 * 60 * 24))
    const { error: batchUpdateError } = await supabase
        .from('stock_batches')
        .update({ exhausted_at: now.toISOString(), duration_days: durationDays })
        .eq('id', activeBatch.id)
    if (batchUpdateError) console.error('Erreur update batch (sync hors-ligne) :', batchUpdateError)
  }

  if (entry.type === 'dette' && entry.client_id) {
    const { data: client } = await supabase.from('clients').select('debt').eq('id', entry.client_id).single()
    await supabase.from('clients').update({ debt: round2((client?.debt ?? 0) + entry.amountDue) }).eq('id', entry.client_id)
  }

  const creditDelta = round2((entry.newCreditFromChange || 0) - (entry.appliedCredit || 0))
  if (entry.client_id && creditDelta !== 0) {
    const { data: client } = await supabase.from('clients').select('credit').eq('id', entry.client_id).single()
    await supabase.from('clients').update({ credit: round2((client?.credit ?? 0) + creditDelta) }).eq('id', entry.client_id)
  }
}

// Rejoue toutes les ventes en attente, dans l'ordre où elles ont été créées.
// Une entrée qui échoue reste en file (elle sera retentée à la prochaine synchro)
// plutôt que d'être perdue.
export async function flushPendingSales() {
  const queue = getPendingSales()
  if (!queue.length) return { synced: 0, failed: 0, remaining: 0 }

  let synced = 0
  const stillPending = []
  for (const entry of queue) {
    try {
      await syncOneSale(entry)
      synced++
    } catch (err) {
      console.error('Échec de synchronisation pour', entry.localId, err)
      stillPending.push(entry)
    }
  }
  setPendingSales(stillPending)
  if (synced > 0) notifyCacheUpdated()
  return { synced, failed: stillPending.length, remaining: stillPending.length }
}
