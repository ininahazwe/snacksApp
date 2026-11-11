import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useMyStock } from '../hooks/useMyStock'
import { useOnlineStatus } from '../hooks/useOnlineStatus'
import { getCachedProducts } from '../lib/offlineCache'
import { fetchStockOverview, newRequestId } from '../lib/stockApi'
import {
  fetchInbox, sendTransfer, respondTransfer, cancelTransfer,
  requestStock, declineRequest, cancelRequest,
  markNotificationsRead, listColleagues,
  refreshMyStockCache, notifyTransfersChanged,
} from '../lib/transfersApi'
import { reasonLabel } from '../lib/inventoryApi'

// Boîte « Transfers » (phase 3a) :
//   • À traiter   : transferts reçus (accepter tout / une partie, refuser avec
//                   motif) et demandes de stock reçues (envoyer ou décliner) ;
//   • En attente  : mes envois et mes demandes sans réponse (annulables) ;
//   • Nouvelles   : acceptations, refus, expirations… (pastille) ;
//   • Historique  : transferts et demandes terminés (toute l'équipe pour un
//                   manager/admin).
// Un envoi RÉSERVE la quantité chez l'expéditeur (« in transit ») : elle n'est
// plus vendable, mais n'est débitée qu'à l'acceptation. Sans réponse sous 72 h
// le transfert expire et rien n'est débité. Tout exige d'être en ligne.

const EMPTY_INBOX = {
  incoming: [], outgoing: [], requests_in: [], requests_out: [],
  history_transfers: [], history_requests: [], notifications: [],
}

const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''

// « expires in 2d 5h » — délai restant avant l'expiration automatique
function timeLeft(iso) {
  const ms = new Date(iso).getTime() - Date.now()
  if (!(ms > 0)) return 'expiring…'
  const min = Math.floor(ms / 60000)
  if (min < 60) return `expires in ${Math.max(min, 1)} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `expires in ${h}h`
  return `expires in ${Math.floor(h / 24)}d ${h % 24}h`
}

function describeNotification(n, uid) {
  const p = n.payload || {}
  const item = `${p.product_name ?? 'a product'}`
  switch (n.type) {
    case 'transfer_accepted':
      return {
        icon: '✅',
        text: `${p.to_name} accepted ${p.qty_accepted} × ${item}`
          + (p.qty_returned > 0 ? ` — ${p.qty_returned} came back to your stock` : ''),
      }
    case 'transfer_refused':
      return { icon: '↩️', text: `${p.to_name} refused ${p.qty} × ${item}: “${p.refusal_reason ?? ''}”. Your stock was not debited.` }
    case 'transfer_cancelled':
      return { icon: '✖️', text: `${p.from_name} cancelled the transfer of ${p.qty} × ${item}` }
    case 'transfer_expired':
      return { icon: '⏱️', text: `No answer from ${p.to_name} within 72 h: the transfer of ${p.qty} × ${item} expired. Your stock was not debited.` }
    case 'transfer_capped':
      if (p.cause === 'reassignment') {
        return p.qty_left > 0
          ? { icon: '⚠️', text: `Transfer ${p.from_name} → ${p.to_name}: a manager reassigned part of ${p.from_name}'s stock. ${p.qty_left} × ${item} left in the transfer.` }
          : { icon: '⚠️', text: `Transfer ${p.from_name} → ${p.to_name} of ${item} cancelled: a manager reassigned ${p.from_name}'s stock.` }
      }
      return p.qty_left > 0
        ? { icon: '⚠️', text: `Transfer ${p.from_name} → ${p.to_name}: ${p.qty_sold} × ${item} were sold by the sender while offline. ${p.qty_left} left in the transfer.` }
        : { icon: '⚠️', text: `Transfer ${p.from_name} → ${p.to_name} of ${item} cancelled: the sender sold this stock while offline.` }
    case 'inventory_discrepancy': {
      // Écart d'inventaire (phase 3b) : pour les managers, ou pour la personne dont un manager a compté le stock
      const whose = p.owner === uid ? 'your stock' : `${p.owner_name}'s stock`
      const n = Math.abs(p.delta ?? 0)
      const by = p.declared_by && p.declared_by !== p.owner ? ` Counted by ${p.declared_by === uid ? 'you' : p.declared_by_name}.` : ''
      return {
        icon: p.delta < 0 ? '📉' : '📈',
        text: `Count of ${whose}: ${n} × ${item} ${p.delta < 0 ? 'missing' : 'more than expected'} (${reasonLabel(p.reason).toLowerCase()}${p.note ? ` — “${p.note}”` : ''}). Counted ${p.counted_qty}, expected ${p.expected_qty}.${by}`,
      }
    }
    case 'stock_reassigned': {
      const items = (p.items ?? []).slice(0, 3).map(i => `${i.qty} × ${i.product_name}`).join(', ')
      const more = (p.items ?? []).length > 3 ? '…' : ''
      const from = p.from_user === uid ? 'your stock' : `${p.from_name}'s stock`
      const to = p.to_user === uid ? 'yours' : `${p.to_name}'s`
      return { icon: '🔀', text: `${p.by_name} moved ${p.total_qty} unit(s) from ${from} to ${to}: ${items}${more}${p.note ? ` — “${p.note}”` : ''}` }
    }
    case 'request_declined':
      return { icon: '↩️', text: `${p.target_name} declined your request for ${p.qty} × ${item}: “${p.decline_reason ?? ''}”` }
    case 'request_expired':
      return { icon: '⏱️', text: `No answer from ${p.target_name} within 72 h: your request for ${p.qty} × ${item} expired.` }
    default:
      return { icon: '🔔', text: n.type }
  }
}

const STATUS_STYLE = {
  accepted:           { label: 'Accepted',        bg: '#E8F5EC', color: '#2E7D42' },
  partially_accepted: { label: 'Partly accepted', bg: '#E8F5EC', color: '#2E7D42' },
  fulfilled:          { label: 'Sent',            bg: '#E8F5EC', color: '#2E7D42' },
  refused:            { label: 'Refused',         bg: '#FFF0E8', color: '#C45000' },
  declined:           { label: 'Declined',        bg: '#FFF0E8', color: '#C45000' },
  cancelled:          { label: 'Cancelled',       bg: '#F0F0F0', color: '#777' },
  expired:            { label: 'Expired',         bg: '#F0F0F0', color: '#777' },
  pending:            { label: 'Pending',         bg: '#EAF1FF', color: '#2F5FB3' },
  reassigned:         { label: 'Reassigned',      bg: '#F1EAFF', color: '#6A3FB3' },
}

export default function TransfertsView({ onToast }) {
  const { user, estGerant } = useAuth()
  const uid = user?.id ?? null
  const isOnline = useOnlineStatus()
  const location = useLocation()
  const navigate = useNavigate()
  const { myStock, refresh: refreshMyStock } = useMyStock()

  const [inbox, setInbox] = useState(EMPTY_INBOX)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [actionError, setActionError] = useState(null)
  const [busy, setBusy] = useState(null)            // identifiant de l'action en cours
  const [showAll, setShowAll] = useState(false)     // historique de toute l'équipe (manager/admin)
  const [products, setProducts] = useState([])
  const [overview, setOverview] = useState([])      // qui détient quoi
  const [colleagues, setColleagues] = useState([])

  const [sendPreset, setSendPreset] = useState(null)       // modal « Send stock »
  const [requestPreset, setRequestPreset] = useState(null) // modal « Request stock »
  const [acceptTarget, setAcceptTarget] = useState(null)   // transfert à accepter
  const [reasonTarget, setReasonTarget] = useState(null)   // { kind: 'refuse' | 'decline', item }

  // Nouvelles vues pendant cette visite : elles restent affichées même une fois marquées lues
  const seenIds = useRef(new Set())

  const loadInbox = useCallback(async (all) => {
    if (!navigator.onLine) { setLoading(false); return }
    try {
      const data = await fetchInbox(all)
      const next = { ...EMPTY_INBOX, ...(data || {}) }
      const unread = next.notifications.filter(n => !n.read_at)
      unread.forEach(n => seenIds.current.add(n.id))
      setInbox(next)
      setLoadError(null)
      if (unread.length > 0) {
        markNotificationsRead().then(notifyTransfersChanged).catch(() => {})
      }
    } catch (err) {
      console.error('transfers_inbox:', err)
      setLoadError(err?.isNetwork
        ? 'Network error — pull to retry.'
        : 'Transfers are not available yet (the database update for transfers has not been applied).')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadReferences = useCallback(async () => {
    if (!navigator.onLine) { setProducts(getCachedProducts()); return }
    const [prod, over, coll] = await Promise.allSettled([
      supabase.from('products').select('id, name, emoji, color, stock').order('name'),
      fetchStockOverview(),
      listColleagues(),
    ])
    setProducts(prod.status === 'fulfilled' && prod.value.data ? prod.value.data : getCachedProducts())
    setOverview(over.status === 'fulfilled' ? (over.value ?? []) : [])
    setColleagues(coll.status === 'fulfilled' ? (coll.value ?? []) : [])
  }, [])

  useEffect(() => { loadInbox(showAll) }, [loadInbox, showAll, isOnline])
  useEffect(() => { loadReferences() }, [loadReferences, isOnline])

  // Arrivée depuis l'écran Inventory : « Send to a colleague » / « Request stock » sur un produit
  useEffect(() => {
    const st = location.state
    if (!st?.action) return
    if (st.action === 'send') setSendPreset({ productId: st.productId ?? '' })
    if (st.action === 'request') setRequestPreset({ productId: st.productId ?? '' })
    navigate(location.pathname, { replace: true, state: null })
  }, [location.state, location.pathname, navigate])

  // Après toute action : boîte, répartition du stock, stock vendable, pastille
  const afterChange = useCallback(async () => {
    await Promise.allSettled([loadInbox(showAll), loadReferences(), refreshMyStockCache(uid)])
    refreshMyStock()
    notifyTransfersChanged()
  }, [loadInbox, loadReferences, refreshMyStock, showAll, uid])

  // Exécute une action ; renvoie son résultat, ou null en cas d'échec (message affiché)
  const run = async (key, fn) => {
    if (!navigator.onLine) { setActionError('You must be online to manage transfers.'); return null }
    setBusy(key)
    setActionError(null)
    try {
      const res = await fn()
      await afterChange()
      return res ?? {}
    } catch (err) {
      console.error(key, err)
      setActionError(err?.isNetwork ? 'Network error — please try again.' : (err?.message || 'The operation failed.'))
      await loadInbox(showAll)
      return null
    } finally {
      setBusy(null)
    }
  }

  const productById = useMemo(() => {
    const m = {}
    products.forEach(p => { m[p.id] = p })
    return m
  }, [products])

  const who = (id, name) => (id === uid ? 'You' : (name ?? 'Unknown'))

  // ── Actions ────────────────────────────────────────────────────────────────
  const handleAccept = async (t, qty) => {
    const res = await run(`accept-${t.id}`, () => respondTransfer(t.id, 'accept', { qty }))
    if (!res) return false
    if (res.status === 'expired') onToast?.('This transfer had expired — nothing was received')
    else onToast?.(`✓ ${res.qty_accepted} × ${t.product_name} added to your stock`)
    return true
  }

  const handleReason = async (reason) => {
    const { kind, item } = reasonTarget
    const res = kind === 'refuse'
      ? await run(`refuse-${item.id}`, () => respondTransfer(item.id, 'refuse', { reason }))
      : await run(`decline-${item.id}`, () => declineRequest(item.id, reason))
    if (!res) return false
    onToast?.(kind === 'refuse' ? 'Transfer refused' : 'Request declined')
    return true
  }

  const handleCancelTransfer = async (t) => {
    const res = await run(`cancel-${t.id}`, () => cancelTransfer(t.id))
    if (res) onToast?.('Transfer cancelled — the stock is yours again')
  }

  const handleCancelRequest = async (r) => {
    const res = await run(`cancelreq-${r.id}`, () => cancelRequest(r.id))
    if (res) onToast?.('Request cancelled')
  }

  const handleSend = async ({ to, productId, qty, note, requestId, clientRef, toName, productName }) => {
    const res = await run('send', () => sendTransfer({ to, productId, qty, note, requestId, clientRef }))
    if (!res) return false
    onToast?.(`✓ ${qty} × ${productName} sent to ${toName}`)
    return true
  }

  const handleRequest = async ({ target, productId, qty, note, clientRef, targetName }) => {
    const res = await run('request', () => requestStock({ target, productId, qty, note, clientRef }))
    if (!res) return false
    onToast?.(`✓ Request sent to ${targetName}`)
    return true
  }

  // Répondre à une demande = ouvrir l'envoi pré-rempli (bénéficiaire et produit imposés)
  const answerRequest = (r) => {
    const avail = myStock[r.product_id] ?? 0
    setSendPreset({
      productId: r.product_id, to: r.requester, toName: r.requester_name,
      qty: Math.min(r.qty, avail), requestId: r.id, requestedQty: r.qty,
    })
  }

  // ── Données dérivées ───────────────────────────────────────────────────────
  const news = inbox.notifications.filter(n => !n.read_at || seenIds.current.has(n.id))
  const todoCount = inbox.incoming.length + inbox.requests_in.length
  const waitingCount = inbox.outgoing.length + inbox.requests_out.length

  const history = useMemo(() => {
    const rows = [
      ...inbox.history_transfers.map(t => ({ ...t, _type: 'transfer', _date: t.responded_at ?? t.created_at })),
      ...inbox.history_requests.map(r => ({ ...r, _type: 'request', _date: r.responded_at ?? r.created_at })),
    ]
    return rows.sort((a, b) => new Date(b._date) - new Date(a._date))
  }, [inbox.history_transfers, inbox.history_requests])

  const canSend = Object.values(myStock).some(q => q > 0)

  const emojiBox = (item, size = 38) => (
    <div style={{ ...s.emoji, width: size, height: size, fontSize: Math.round(size * 0.47), background: (item.product_color ?? '#EEE') + '22' }}>
      {item.product_emoji ?? '🍬'}
    </div>
  )

  if (loading) return <div style={s.loading}>Loading…</div>

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif" }}>
      <div style={s.headerRow}>
        <p style={s.titre}>Transfers</p>
      </div>

      <div style={s.actionRow}>
        <button
          style={{ ...s.primaryBtn, opacity: isOnline && canSend ? 1 : 0.45 }}
          disabled={!isOnline || !canSend}
          onClick={() => setSendPreset({})}
          title={canSend ? 'Send stock to a colleague' : 'You have no stock to send'}
        >
          ↗ Send stock
        </button>
        <button
          style={{ ...s.secondaryBtn, opacity: isOnline ? 1 : 0.45 }}
          disabled={!isOnline}
          onClick={() => setRequestPreset({})}
        >
          ↙ Request stock
        </button>
      </div>

      {!isOnline && (
        <div style={s.infoBox}>You are offline. Transfers and stock requests need an internet connection.</div>
      )}
      {loadError && <div style={s.errorBox}>{loadError}</div>}
      {actionError && (
        <div style={s.errorBox} onClick={() => setActionError(null)}>{actionError}</div>
      )}

      {/* ── À traiter ─────────────────────────────────────────────────────── */}
      <div style={s.sectionLabel}>To handle{todoCount > 0 ? ` (${todoCount})` : ''}</div>
      {todoCount === 0 ? (
        <div style={s.emptyCard}>Nothing is waiting for you</div>
      ) : (
        <div style={s.card}>
          {inbox.incoming.map(t => (
            <div key={t.id} style={s.row}>
              {emojiBox(t)}
              <div style={s.rowBody}>
                <div style={s.rowTitle}>{t.from_name} sends you {t.qty} × {t.product_name}</div>
                <div style={s.rowMeta}>
                  {fmtDate(t.created_at)} · {timeLeft(t.expires_at)}
                  {t.qty < t.qty_sent ? ` · ${t.qty_sent} sent at first, ${t.qty_sent - t.qty} sold by the sender meanwhile` : ''}
                </div>
                {t.note && <div style={s.note}>“{t.note}”</div>}
                <div style={s.btnRow}>
                  <button style={s.okBtn} disabled={!!busy} onClick={() => setAcceptTarget(t)}>Accept</button>
                  <button style={s.ghostBtn} disabled={!!busy} onClick={() => setReasonTarget({ kind: 'refuse', item: t })}>Refuse</button>
                </div>
              </div>
            </div>
          ))}
          {inbox.requests_in.map(r => {
            const avail = myStock[r.product_id] ?? 0
            return (
              <div key={r.id} style={s.row}>
                {emojiBox(r)}
                <div style={s.rowBody}>
                  <div style={s.rowTitle}>{r.requester_name} asks you for {r.qty} × {r.product_name}</div>
                  <div style={s.rowMeta}>
                    {fmtDate(r.created_at)} · {timeLeft(r.expires_at)} · you can send {avail}
                  </div>
                  {r.note && <div style={s.note}>“{r.note}”</div>}
                  <div style={s.btnRow}>
                    <button
                      style={{ ...s.okBtn, opacity: avail > 0 ? 1 : 0.45 }}
                      disabled={!!busy || avail <= 0}
                      onClick={() => answerRequest(r)}
                    >
                      Send…
                    </button>
                    <button style={s.ghostBtn} disabled={!!busy} onClick={() => setReasonTarget({ kind: 'decline', item: r })}>Decline</button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ── En attente de réponse ─────────────────────────────────────────── */}
      {waitingCount > 0 && (
        <>
          <div style={s.sectionLabel}>Waiting for an answer ({waitingCount})</div>
          <div style={s.card}>
            {inbox.outgoing.map(t => (
              <div key={t.id} style={s.row}>
                {emojiBox(t)}
                <div style={s.rowBody}>
                  <div style={s.rowTitle}>{t.qty} × {t.product_name} → {t.to_name}</div>
                  <div style={s.rowMeta}>
                    In transit (not sellable) · {timeLeft(t.expires_at)}
                    {t.qty < t.qty_sent ? ` · reduced from ${t.qty_sent} after an offline sale` : ''}
                  </div>
                  {t.note && <div style={s.note}>“{t.note}”</div>}
                  <div style={s.btnRow}>
                    <button style={s.ghostBtn} disabled={!!busy} onClick={() => handleCancelTransfer(t)}>
                      {busy === `cancel-${t.id}` ? 'Cancelling…' : 'Cancel transfer'}
                    </button>
                  </div>
                </div>
              </div>
            ))}
            {inbox.requests_out.map(r => (
              <div key={r.id} style={s.row}>
                {emojiBox(r)}
                <div style={s.rowBody}>
                  <div style={s.rowTitle}>You asked {r.target_name} for {r.qty} × {r.product_name}</div>
                  <div style={s.rowMeta}>{fmtDate(r.created_at)} · {timeLeft(r.expires_at)}</div>
                  {r.note && <div style={s.note}>“{r.note}”</div>}
                  <div style={s.btnRow}>
                    <button style={s.ghostBtn} disabled={!!busy} onClick={() => handleCancelRequest(r)}>
                      {busy === `cancelreq-${r.id}` ? 'Cancelling…' : 'Cancel request'}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── Nouvelles ─────────────────────────────────────────────────────── */}
      {news.length > 0 && (
        <>
          <div style={s.sectionLabel}>Updates</div>
          <div style={s.card}>
            {news.map(n => {
              const d = describeNotification(n, uid)
              return (
                <div key={n.id} style={s.row}>
                  <div style={{ ...s.emoji, width: 34, height: 34, fontSize: 16, background: '#F5F5F5' }}>{d.icon}</div>
                  <div style={s.rowBody}>
                    <div style={{ ...s.rowTitle, fontWeight: 400 }}>{d.text}</div>
                    <div style={s.rowMeta}>{fmtDate(n.created_at)}</div>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* ── Historique ────────────────────────────────────────────────────── */}
      <div style={{ ...s.sectionLabel, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>History</span>
        {estGerant && (
          <span style={{ display: 'flex', gap: '6px' }}>
            {[[false, 'Mine'], [true, 'Whole team']].map(([val, label]) => (
              <button
                key={label}
                onClick={() => setShowAll(val)}
                style={{ ...s.filterBtn, ...(showAll === val ? s.filterBtnActive : {}) }}
              >
                {label}
              </button>
            ))}
          </span>
        )}
      </div>
      {history.length === 0 ? (
        <div style={s.emptyCard}>No transfer yet</div>
      ) : (
        <div style={s.card}>
          {history.map(h => {
            const isReassign = h.kind === 'reassignment'   // réattribution par un manager : sans acceptation
            const st = isReassign ? STATUS_STYLE.reassigned : (STATUS_STYLE[h.status] ?? STATUS_STYLE.cancelled)
            const isTransfer = h._type === 'transfer'
            const title = isTransfer
              ? `${who(h.from_user, h.from_name)} → ${who(h.to_user, h.to_name)} · ${h.status === 'partially_accepted' ? `${h.qty_accepted}/${h.qty}` : (h.qty_accepted ?? h.qty)} × ${h.product_name}`
              : `${who(h.requester, h.requester_name)} asked ${h.target_user === uid ? 'you' : (h.target_name ?? 'Unknown')} for ${h.qty} × ${h.product_name}`
            const reason = isTransfer ? h.refusal_reason : h.decline_reason
            return (
              <div key={`${h._type}-${h.id}`} style={s.row}>
                {emojiBox(h, 34)}
                <div style={s.rowBody}>
                  <div style={{ ...s.rowTitle, fontWeight: 400 }}>{title}</div>
                  <div style={s.rowMeta}>
                    {isReassign
                      ? `Reassigned by ${h.created_by === uid ? 'you' : (h.created_by_name ?? 'a manager')}`
                      : (isTransfer ? 'Transfer' : 'Request')} · {fmtDate(h._date)}
                    {reason ? ` · “${reason}”` : ''}
                    {isReassign && h.note ? ` · “${h.note}”` : ''}
                  </div>
                </div>
                <div style={{ ...s.statusBadge, background: st.bg, color: st.color }}>{st.label}</div>
              </div>
            )
          })}
        </div>
      )}

      {/* ── Modals ────────────────────────────────────────────────────────── */}
      {sendPreset && (
        <SendModal
          preset={sendPreset}
          products={products}
          productById={productById}
          myStock={myStock}
          colleagues={colleagues}
          saving={busy === 'send'}
          error={actionError}
          onClose={() => { setSendPreset(null); setActionError(null) }}
          onSubmit={async (payload) => { if (await handleSend(payload)) setSendPreset(null) }}
        />
      )}
      {requestPreset && (
        <RequestModal
          preset={requestPreset}
          products={products}
          productById={productById}
          overview={overview}
          uid={uid}
          saving={busy === 'request'}
          error={actionError}
          onClose={() => { setRequestPreset(null); setActionError(null) }}
          onSubmit={async (payload) => { if (await handleRequest(payload)) setRequestPreset(null) }}
        />
      )}
      {acceptTarget && (
        <AcceptModal
          transfer={acceptTarget}
          saving={busy === `accept-${acceptTarget.id}`}
          error={actionError}
          onClose={() => { setAcceptTarget(null); setActionError(null) }}
          onSubmit={async (qty) => { if (await handleAccept(acceptTarget, qty)) setAcceptTarget(null) }}
        />
      )}
      {reasonTarget && (
        <ReasonModal
          target={reasonTarget}
          saving={!!busy}
          error={actionError}
          onClose={() => { setReasonTarget(null); setActionError(null) }}
          onSubmit={async (reason) => { if (await handleReason(reason)) setReasonTarget(null) }}
        />
      )}
    </div>
  )
}

// ── Feuille modale commune ───────────────────────────────────────────────────
function Sheet({ title, subtitle, onClose, children }) {
  return (
    <div style={s.overlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={s.modal}>
        <div style={s.handle} />
        <div style={{ marginBottom: '20px' }}>
          <div style={s.modalTitle}>{title}</div>
          {subtitle && <div style={s.modalSub}>{subtitle}</div>}
        </div>
        {children}
      </div>
    </div>
  )
}

// ── Envoyer du stock à un collègue ───────────────────────────────────────────
function SendModal({ preset, products, productById, myStock, colleagues, saving, error, onClose, onSubmit }) {
  const lockedRequest = !!preset.requestId   // réponse à une demande : produit et bénéficiaire imposés
  const [productId, setProductId] = useState(preset.productId ?? '')
  const [to, setTo] = useState(preset.to ?? '')
  const [qty, setQty] = useState(preset.qty ? String(preset.qty) : '')
  const [note, setNote] = useState('')
  const clientRef = useRef(newRequestId())

  const sendable = products.filter(p => (myStock[p.id] ?? 0) > 0)
  const avail = productId ? (myStock[productId] ?? 0) : 0
  const n = parseInt(qty, 10)
  const valid = !!productId && !!to && n > 0 && n <= avail
  const product = productById[productId]
  const toName = preset.toName ?? colleagues.find(c => c.id === to)?.name ?? ''

  return (
    <Sheet
      title={lockedRequest ? `Send to ${preset.toName}` : 'Send stock'}
      subtitle={lockedRequest
        ? `${preset.toName} asked for ${preset.requestedQty} × ${product?.name ?? 'this product'}`
        : 'The quantity stays reserved (not sellable) until your colleague answers. No answer within 72 h: it comes back to you.'}
      onClose={onClose}
    >
      {!lockedRequest && (
        <>
          <div style={s.fieldGroup}>
            <div style={s.fieldLabel}>Product</div>
            <select style={s.input} value={productId} onChange={e => { setProductId(e.target.value); setQty('') }}>
              <option value="">Choose a product…</option>
              {sendable.map(p => (
                <option key={p.id} value={p.id}>{p.emoji ?? '🍬'} {p.name} — {myStock[p.id]} in your stock</option>
              ))}
            </select>
            {sendable.length === 0 && <div style={s.preview}>You have no stock available to send.</div>}
          </div>
          <div style={s.fieldGroup}>
            <div style={s.fieldLabel}>To</div>
            <select style={s.input} value={to} onChange={e => setTo(e.target.value)}>
              <option value="">Choose a colleague…</option>
              {colleagues.map(c => (
                <option key={c.id} value={c.id}>{c.name} ({c.role})</option>
              ))}
            </select>
          </div>
        </>
      )}

      <div style={s.fieldGroup}>
        <div style={s.fieldLabel}>Quantity</div>
        <input
          style={s.input} type="number" inputMode="numeric" min="1" max={avail || undefined}
          placeholder={productId ? `Up to ${avail}` : 'Choose a product first'}
          value={qty} onChange={e => setQty(e.target.value)} disabled={!productId}
        />
        {productId && (
          <div style={{ ...s.preview, color: n > avail ? '#C00' : '#999' }}>
            {n > avail
              ? `You can send at most ${avail} unit(s)`
              : `You can send up to ${avail} unit(s)${n > 0 ? ` · ${avail - n} will stay sellable` : ''}`}
          </div>
        )}
      </div>

      <div style={s.fieldGroup}>
        <div style={s.fieldLabel}>Note (optional)</div>
        <input style={s.input} type="text" maxLength={140} placeholder="Ex: for the Saturday stand" value={note} onChange={e => setNote(e.target.value)} />
      </div>

      {error && <div style={s.errorBox}>{error}</div>}

      <button
        style={{ ...s.submitBtn, opacity: valid && !saving ? 1 : 0.5 }}
        disabled={!valid || saving}
        onClick={() => onSubmit({
          to, productId, qty: n, note: note.trim(), requestId: preset.requestId ?? null,
          clientRef: clientRef.current, toName, productName: product?.name ?? '',
        })}
      >
        {saving ? 'Sending…' : (valid ? `Send ${n} × ${product?.name ?? ''} to ${toName}` : 'Send')}
      </button>
    </Sheet>
  )
}

// ── Demander du stock à un collègue qui en détient ───────────────────────────
function RequestModal({ preset, products, productById, overview, uid, saving, error, onClose, onSubmit }) {
  const [productId, setProductId] = useState(preset.productId ?? '')
  const [target, setTarget] = useState('')
  const [qty, setQty] = useState('')
  const [note, setNote] = useState('')
  const clientRef = useRef(newRequestId())

  // Collègues qui ont du stock disponible, par produit
  const holdersByProduct = useMemo(() => {
    const m = {}
    overview.forEach(h => {
      const free = (h.qty ?? 0) - (h.reserved ?? 0)
      if (h.owner_id === uid || free <= 0) return
      ;(m[h.product_id] = m[h.product_id] || []).push({ id: h.owner_id, name: h.owner_name, free })
    })
    return m
  }, [overview, uid])

  const requestable = products.filter(p => (holdersByProduct[p.id] ?? []).length > 0)
  const holders = productId ? (holdersByProduct[productId] ?? []) : []
  const holder = holders.find(h => h.id === target)
  const n = parseInt(qty, 10)
  const valid = !!productId && !!holder && n > 0
  const product = productById[productId]

  // Un seul détenteur : on le présélectionne
  useEffect(() => {
    if (holders.length === 1) setTarget(holders[0].id)
    else if (!holders.some(h => h.id === target)) setTarget('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, holders.length])

  return (
    <Sheet
      title="Request stock"
      subtitle="Ask a colleague who holds the product. They answer by sending a transfer, or decline. No answer within 72 h: the request expires."
      onClose={onClose}
    >
      <div style={s.fieldGroup}>
        <div style={s.fieldLabel}>Product</div>
        <select style={s.input} value={productId} onChange={e => { setProductId(e.target.value); setTarget('') }}>
          <option value="">Choose a product…</option>
          {requestable.map(p => (
            <option key={p.id} value={p.id}>{p.emoji ?? '🍬'} {p.name}</option>
          ))}
        </select>
        {requestable.length === 0 && <div style={s.preview}>No colleague has stock available right now.</div>}
        {productId && holders.length === 0 && <div style={s.preview}>No colleague has this product available right now.</div>}
      </div>

      <div style={s.fieldGroup}>
        <div style={s.fieldLabel}>Ask</div>
        <select style={s.input} value={target} onChange={e => setTarget(e.target.value)} disabled={holders.length === 0}>
          <option value="">Choose a colleague…</option>
          {holders.map(h => (
            <option key={h.id} value={h.id}>{h.name} — {h.free} available</option>
          ))}
        </select>
      </div>

      <div style={s.fieldGroup}>
        <div style={s.fieldLabel}>Quantity</div>
        <input
          style={s.input} type="number" inputMode="numeric" min="1"
          placeholder="Ex: 10" value={qty} onChange={e => setQty(e.target.value)}
        />
        {holder && n > holder.free && (
          <div style={s.preview}>{holder.name} only has {holder.free} available: they may send less.</div>
        )}
      </div>

      <div style={s.fieldGroup}>
        <div style={s.fieldLabel}>Note (optional)</div>
        <input style={s.input} type="text" maxLength={140} placeholder="Ex: I am out since this morning" value={note} onChange={e => setNote(e.target.value)} />
      </div>

      {error && <div style={s.errorBox}>{error}</div>}

      <button
        style={{ ...s.submitBtn, opacity: valid && !saving ? 1 : 0.5 }}
        disabled={!valid || saving}
        onClick={() => onSubmit({
          target, productId, qty: n, note: note.trim(),
          clientRef: clientRef.current, targetName: holder?.name ?? '',
        })}
      >
        {saving ? 'Sending…' : (valid ? `Ask ${holder.name} for ${n} × ${product?.name ?? ''}` : 'Send request')}
      </button>
    </Sheet>
  )
}

// ── Accepter un transfert (tout ou partie) ───────────────────────────────────
function AcceptModal({ transfer, saving, error, onClose, onSubmit }) {
  const [qty, setQty] = useState(String(transfer.qty))
  const n = parseInt(qty, 10)
  const valid = n > 0 && n <= transfer.qty

  return (
    <Sheet
      title={`${transfer.qty} × ${transfer.product_name}`}
      subtitle={`From ${transfer.from_name}. Enter what you actually received: the rest goes back to ${transfer.from_name}.`}
      onClose={onClose}
    >
      <div style={s.fieldGroup}>
        <div style={s.fieldLabel}>Quantity received</div>
        <input
          style={s.input} type="number" inputMode="numeric" min="1" max={transfer.qty}
          value={qty} onChange={e => setQty(e.target.value)} autoFocus
        />
        <div style={{ ...s.preview, color: qty !== '' && !valid ? '#C00' : '#999' }}>
          {qty !== '' && !valid
            ? `Enter a quantity between 1 and ${transfer.qty}`
            : (n < transfer.qty
              ? `${n} added to your stock · ${transfer.qty - n} returned to ${transfer.from_name}`
              : 'Everything is added to your stock')}
        </div>
      </div>

      {error && <div style={s.errorBox}>{error}</div>}

      <button
        style={{ ...s.submitBtn, opacity: valid && !saving ? 1 : 0.5 }}
        disabled={!valid || saving}
        onClick={() => onSubmit(n)}
      >
        {saving ? 'Saving…' : (valid && n < transfer.qty ? `Accept ${n} of ${transfer.qty}` : 'Accept all')}
      </button>
    </Sheet>
  )
}

// ── Motif (refus d'un transfert / d'une demande) ─────────────────────────────
function ReasonModal({ target, saving, error, onClose, onSubmit }) {
  const [reason, setReason] = useState('')
  const isRefuse = target.kind === 'refuse'
  const item = target.item
  const valid = reason.trim().length > 0

  return (
    <Sheet
      title={isRefuse ? 'Refuse this transfer' : 'Decline this request'}
      subtitle={isRefuse
        ? `${item.qty} × ${item.product_name} from ${item.from_name}. Nothing is added to your stock; ${item.from_name} keeps everything.`
        : `${item.requester_name} asked for ${item.qty} × ${item.product_name}.`}
      onClose={onClose}
    >
      <div style={s.fieldGroup}>
        <div style={s.fieldLabel}>Reason (required)</div>
        <textarea
          style={{ ...s.input, minHeight: '84px', resize: 'vertical' }}
          maxLength={200}
          placeholder={isRefuse ? 'Ex: not received, wrong product, damaged…' : 'Ex: I need it for my own sales'}
          value={reason} onChange={e => setReason(e.target.value)} autoFocus
        />
      </div>

      {error && <div style={s.errorBox}>{error}</div>}

      <button
        style={{ ...s.submitBtn, opacity: valid && !saving ? 1 : 0.5 }}
        disabled={!valid || saving}
        onClick={() => onSubmit(reason.trim())}
      >
        {saving ? 'Saving…' : (isRefuse ? 'Refuse transfer' : 'Decline request')}
      </button>
    </Sheet>
  )
}

const s = {
  loading: { color: '#999', fontSize: '14px', paddingTop: '20px', fontFamily: "'DM Sans', sans-serif" },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' },
  titre: { fontFamily: "'DM Serif Display', serif", fontSize: '18px', color: '#1A1A1A', margin: 0 },
  actionRow: { display: 'flex', gap: '10px', marginBottom: '16px' },
  primaryBtn: { flex: 1, padding: '12px 14px', background: '#1A1A1A', color: 'white', border: 'none', borderRadius: '14px', fontFamily: "'DM Sans', sans-serif", fontSize: '13.5px', fontWeight: '500', cursor: 'pointer' },
  secondaryBtn: { flex: 1, padding: '12px 14px', background: 'white', color: '#1A1A1A', border: '1.5px solid #EBEBEB', borderRadius: '14px', fontFamily: "'DM Sans', sans-serif", fontSize: '13.5px', fontWeight: '500', cursor: 'pointer' },
  infoBox: { background: '#FFF8E6', color: '#8A6100', borderRadius: '12px', padding: '10px 14px', fontSize: '13px', marginBottom: '14px' },
  errorBox: { background: '#FFF0F0', color: '#C00', borderRadius: '12px', padding: '10px 14px', fontSize: '13px', marginBottom: '14px' },
  sectionLabel: { fontSize: '11px', fontWeight: '600', color: '#999', textTransform: 'uppercase', letterSpacing: '0.6px', margin: '18px 0 8px' },
  card: { background: 'white', borderRadius: '18px', border: '1px solid rgba(0,0,0,0.05)', boxShadow: '0 2px 12px rgba(0,0,0,0.04)', overflow: 'hidden' },
  emptyCard: { background: 'white', borderRadius: '18px', border: '1px solid rgba(0,0,0,0.05)', padding: '18px 16px', color: '#BBB', fontSize: '13px', textAlign: 'center' },
  row: { display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '14px 16px', borderBottom: '1px solid rgba(0,0,0,0.04)' },
  rowBody: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: '13.5px', fontWeight: '500', color: '#1A1A1A', lineHeight: 1.35 },
  rowMeta: { fontSize: '11.5px', color: '#999', marginTop: '3px', lineHeight: 1.4 },
  note: { fontSize: '12.5px', color: '#666', marginTop: '6px', fontStyle: 'italic' },
  btnRow: { display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' },
  okBtn: { padding: '8px 16px', background: '#1A1A1A', color: 'white', border: 'none', borderRadius: '100px', fontFamily: "'DM Sans', sans-serif", fontSize: '12.5px', fontWeight: '500', cursor: 'pointer' },
  ghostBtn: { padding: '8px 16px', background: 'white', color: '#666', border: '1.5px solid #EBEBEB', borderRadius: '100px', fontFamily: "'DM Sans', sans-serif", fontSize: '12.5px', fontWeight: '500', cursor: 'pointer' },
  emoji: { borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  statusBadge: { padding: '4px 9px', borderRadius: '100px', fontSize: '11px', fontWeight: '500', whiteSpace: 'nowrap', flexShrink: 0 },
  filterBtn: { padding: '5px 11px', borderRadius: '100px', border: '1.5px solid #EBEBEB', background: 'white', fontSize: '11px', fontWeight: '500', color: '#999', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", textTransform: 'none', letterSpacing: 0 },
  filterBtnActive: { background: '#1A1A1A', color: 'white', borderColor: '#1A1A1A' },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(4px)', zIndex: 100, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
  modal: { background: 'white', borderRadius: '28px 28px 0 0', padding: '8px 24px 40px', width: '100%', maxWidth: '430px', maxHeight: '88vh', overflowY: 'auto', fontFamily: "'DM Sans', sans-serif", boxSizing: 'border-box' },
  handle: { width: '36px', height: '4px', background: '#E0E0E0', borderRadius: '10px', margin: '10px auto 20px' },
  modalTitle: { fontFamily: "'DM Serif Display', serif", fontSize: '20px', color: '#1A1A1A' },
  modalSub: { fontSize: '13px', color: '#999', marginTop: '4px', lineHeight: 1.45 },
  fieldGroup: { marginBottom: '16px' },
  fieldLabel: { fontSize: '11.5px', fontWeight: '600', color: '#999', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '8px' },
  input: { width: '100%', padding: '13px 16px', borderRadius: '12px', border: '1.5px solid #EBEBEB', fontSize: '15px', fontFamily: "'DM Sans', sans-serif", color: '#1A1A1A', outline: 'none', boxSizing: 'border-box', background: 'white' },
  preview: { fontSize: '12.5px', color: '#999', marginTop: '8px', padding: '8px 12px', background: '#F9F9F9', borderRadius: '8px' },
  submitBtn: { width: '100%', padding: '16px', background: '#1A1A1A', color: 'white', border: 'none', borderRadius: '16px', fontFamily: "'DM Sans', sans-serif", fontSize: '15px', fontWeight: '500', cursor: 'pointer' },
}
