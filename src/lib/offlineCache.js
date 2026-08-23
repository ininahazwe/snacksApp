// Cache local (localStorage) du dernier état connu des produits/clients,
// pour que la vente reste possible (lecture + création) quand le réseau tombe.
// Limite connue : mono-appareil, pas de résolution de conflit entre plusieurs
// appareils hors-ligne en même temps (cf. rapport livré avec ces changements).

const PRODUCTS_KEY = 'douceurs_cache_products'
const CLIENTS_KEY = 'douceurs_cache_clients'
const CACHE_EVENT = 'douceurs-cache-updated'

function readJson(key) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (err) {
    console.error('Cache local indisponible (quota ou navigation privée) :', err)
  }
}

export function cacheProducts(products) {
  writeJson(PRODUCTS_KEY, products ?? [])
}

export function getCachedProducts() {
  return readJson(PRODUCTS_KEY)
}

export function cacheClients(clients) {
  writeJson(CLIENTS_KEY, clients ?? [])
}

export function getCachedClients() {
  return readJson(CLIENTS_KEY)
}

// Prévient les autres vues ouvertes (ex. Products) qu'une mise à jour
// optimiste du cache a eu lieu, pour qu'elles se rafraîchissent depuis
// le cache sans attendre un remount.
export function notifyCacheUpdated() {
  try { window.dispatchEvent(new Event(CACHE_EVENT)) } catch { /* ignore */ }
}

export function onCacheUpdated(handler) {
  window.addEventListener(CACHE_EVENT, handler)
  return () => window.removeEventListener(CACHE_EVENT, handler)
}
