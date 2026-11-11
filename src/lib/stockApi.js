// Accès au stock « par détenteur » (phase 2). Toutes les opérations qui
// modifient le stock passent par des fonctions SQL atomiques (record_sale,
// cancel_sales, record_restock, adjust_stock) : le navigateur n'écrit plus
// jamais directement dans products.stock, stock_batches ni stock_movements.
import { supabase } from './supabase'

const MY_STOCK_KEY = 'douceurs_cache_mystock_v1'

// Identifiant de requête (idempotence : rejouer la même requête ne duplique pas la vente)
export function newRequestId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  // Repli très ancien navigateur : UUID v4 approximatif
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
  })
}

async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args)
  if (error) {
    const err = new Error(error.message || `Operation failed (${name})`)
    err.code = error.code
    err.isNetwork = !error.code && /fetch|network/i.test(error.message || '')
    throw err
  }
  return data
}

// Vente (1 ou plusieurs lignes) — voir record_sale dans phase2_stock_par_utilisateur.sql
export const recordSale     = (payload) => rpc('record_sale', { p_payload: payload })
export const cancelSales    = (saleIds) => rpc('cancel_sales', { p_sale_ids: saleIds })
export const recordRestock  = (productId, qty, unitCost) =>
  rpc('record_restock', { p_product_id: productId, p_qty: qty, p_unit_cost: unitCost })
export const adjustStock    = (productId, newTotal) =>
  rpc('adjust_stock', { p_product_id: productId, p_new_total: newTotal })
export const fetchStockOverview = () => rpc('stock_overview', {})

// ── Stock que L'UTILISATEUR peut vendre (qty − reserved), avec cache hors-ligne ──
export async function fetchMyStock(userId) {
  const { data, error } = await supabase
    .from('stock_holdings')
    .select('product_id, qty, reserved')
    .eq('owner_id', userId)
  if (error) throw error
  const map = {}
  ;(data ?? []).forEach(h => { map[h.product_id] = Math.max(0, (h.qty ?? 0) - (h.reserved ?? 0)) })
  return map
}

export function getCachedMyStock(userId) {
  try {
    const raw = localStorage.getItem(MY_STOCK_KEY)
    const c = raw ? JSON.parse(raw) : null
    return c && c.userId === userId ? (c.map ?? {}) : {}
  } catch { return {} }
}

export function cacheMyStock(userId, map) {
  try { localStorage.setItem(MY_STOCK_KEY, JSON.stringify({ userId, map })) } catch { /* ignore */ }
}

// Ajuste le cache après une vente (en ligne ou hors-ligne) : deltas = { [productId]: -qty }
export function adjustCachedMyStock(userId, deltas) {
  const map = { ...getCachedMyStock(userId) }
  Object.entries(deltas).forEach(([pid, d]) => { map[pid] = Math.max(0, (map[pid] ?? 0) + d) })
  cacheMyStock(userId, map)
}
