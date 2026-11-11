import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useOnlineStatus } from '../hooks/useOnlineStatus'
import { formatPrice } from '../lib/format'
import { newRequestId } from '../lib/stockApi'
import { listColleagues, refreshMyStockCache, notifyTransfersChanged } from '../lib/transfersApi'
import {
  declareInventory, reassignStock, fetchHoldersSummary, fetchHolderDetail,
  SHORTAGE_REASONS, SURPLUS_REASONS, reasonLabel, movementLabel,
} from '../lib/inventoryApi'

// Onglet « By person » / « My stock » de l'écran Inventory (phase 3b) :
//   • manager/admin : une carte par personne (unités, valeur au prix d'achat,
//     écarts des 30 derniers jours), puis le détail de la personne choisie ;
//   • cashier : directement le détail de son propre stock.
// Détail : stock détenu par produit (bouton « Count »), comptages et écarts,
// journal des mouvements. Un manager/admin peut aussi compter le stock de
// quelqu'un d'autre et le réattribuer (départ d'un vendeur, etc.).
// Un écart est appliqué tout de suite, avec son motif ; un excédent ne peut
// être enregistré que par un manager/admin. Tout exige d'être en ligne.

const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString('en', { month: 'short', day: 'numeric' }) : ''
const fmtDateTime = (iso) =>
  iso ? new Date(iso).toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
const money = (n) => `${formatPrice(n)} GH₵`
const units = (n) => `${n} unit${n === 1 ? '' : 's'}`

export default function HoldersPanel({ onChanged }) {
  const { user, estGerant } = useAuth()
  const uid = user?.id ?? null
  const isOnline = useOnlineStatus()

  const [summary, setSummary] = useState([])
  const [selected, setSelected] = useState(null)        // personne affichée en détail
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [loadError, setLoadError] = useState(null)
  const [actionError, setActionError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [saving, setSaving] = useState(false)
  const [countTarget, setCountTarget] = useState(null)   // ligne de stock à compter
  const [showReassign, setShowReassign] = useState(false)
  const [colleagues, setColleagues] = useState([])

  const describeError = (err) => (err?.isNetwork
    ? 'Network error — check your connection and try again.'
    : 'Not available yet (the database update for inventory counts has not been applied).')

  const loadSummary = useCallback(async () => {
    if (!navigator.onLine) { setLoading(false); return }
    try {
      setSummary((await fetchHoldersSummary()) ?? [])
      setLoadError(null)
    } catch (err) {
      console.error('holders_summary:', err)
      setLoadError(describeError(err))
    } finally {
      setLoading(false)
    }
  }, [])

  const loadDetail = useCallback(async (owner) => {
    if (!owner || !navigator.onLine) return
    setDetailLoading(true)
    try {
      setDetail(await fetchHolderDetail(owner === uid ? null : owner))
      setLoadError(null)
    } catch (err) {
      console.error('holder_detail:', err)
      setLoadError(describeError(err))
    } finally {
      setDetailLoading(false)
    }
  }, [uid])

  useEffect(() => { loadSummary() }, [loadSummary, isOnline])
  // Un cashier n'a que sa propre ligne : on ouvre directement son détail
  useEffect(() => { if (!estGerant && uid) setSelected(uid) }, [estGerant, uid])
  useEffect(() => {
    if (selected) loadDetail(selected)
    else setDetail(null)
  }, [selected, loadDetail, isOnline])
  useEffect(() => {
    if (!estGerant || !navigator.onLine) return
    listColleagues().then(c => setColleagues(c ?? [])).catch(() => setColleagues([]))
  }, [estGerant, isOnline])

  const afterChange = async () => {
    await Promise.allSettled([loadSummary(), loadDetail(selected), refreshMyStockCache(uid)])
    notifyTransfersChanged()
    onChanged?.()
  }

  // Exécute une action ; renvoie son résultat, ou null en cas d'échec (message affiché)
  const run = async (fn) => {
    if (!navigator.onLine) { setActionError('You must be online to do this.'); return null }
    setSaving(true)
    setActionError(null)
    setNotice(null)
    try {
      const res = await fn()
      await afterChange()
      return res ?? {}
    } catch (err) {
      console.error(err)
      setActionError(err?.isNetwork ? 'Network error — please try again.' : (err?.message || 'The operation failed.'))
      return null
    } finally {
      setSaving(false)
    }
  }

  const person = summary.find(x => x.user_id === selected) ?? null
  const isOwn = selected === uid
  const canCount = isOwn || estGerant
  const holdings = detail?.holdings ?? []
  const personName = person?.name ?? detail?.name ?? ''

  const handleCount = async ({ counted, reason, note, clientRef }) => {
    const h = countTarget
    const res = await run(() => declareInventory({
      productId: h.product_id, counted, reason, note, owner: isOwn ? null : selected, clientRef,
    }))
    if (!res) return false
    const d = res.delta ?? 0
    setNotice(d === 0
      ? `✓ ${h.product_name}: count confirmed, no discrepancy`
      : (d < 0
        ? `✓ ${h.product_name}: ${units(-d)} removed from ${isOwn ? 'your' : `${personName}'s`} stock`
        : `✓ ${h.product_name}: ${units(d)} added to ${isOwn ? 'your' : `${personName}'s`} stock`))
    return true
  }

  const handleReassign = async ({ to, toName, productId, qty, note, clientRef }) => {
    const res = await run(() => reassignStock({ from: selected, to, productId, qty, note, clientRef }))
    if (!res) return false
    setNotice(`✓ ${units(res.total_qty ?? 0)} moved from ${personName} to ${toName}`)
    return true
  }

  if (loading) return <div style={s.loading}>Loading…</div>

  const totalValue = summary.reduce((n, x) => n + Number(x.value || 0), 0)
  const totalShort = summary.reduce((n, x) => n + Number(x.short_value_30d || 0), 0)
  // Bénéficiaires possibles d'une réattribution : moi + collègues actifs, sauf la personne source
  const targets = [{ id: uid, name: 'Me' }, ...colleagues.map(c => ({ id: c.id, name: `${c.name} (${c.role})` }))]
    .filter(t => t.id && t.id !== selected)

  return (
    <div>
      {!isOnline && (
        <div style={s.infoBox}>You are offline. Counts and stock details need an internet connection.</div>
      )}
      {loadError && <div style={s.errorBox}>{loadError}</div>}
      {notice && <div style={s.noticeBox} onClick={() => setNotice(null)}>{notice}</div>}
      {actionError && !countTarget && !showReassign && (
        <div style={s.errorBox} onClick={() => setActionError(null)}>{actionError}</div>
      )}

      {/* ── Vue d'ensemble : une carte par personne (manager/admin) ─────────── */}
      {estGerant && !selected && (
        <>
          <div style={s.kpiRow}>
            <div style={s.kpiCard}>
              <div style={s.kpiLabel}>Stock value (cost)</div>
              <div style={s.kpiValue}>{money(totalValue)}</div>
            </div>
            <div style={{ ...s.kpiCard, borderColor: totalShort > 0 ? '#FFCDB2' : 'rgba(0,0,0,0.05)' }}>
              <div style={s.kpiLabel}>Shortages · 30 days</div>
              <div style={{ ...s.kpiValue, color: totalShort > 0 ? '#C45000' : '#2E7D42' }}>{money(totalShort)}</div>
            </div>
          </div>

          {summary.length === 0 ? (
            <div style={s.emptyCard}>Nobody holds stock yet</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {summary.map(p => (
                <button key={p.user_id} style={s.personCard} onClick={() => { setSelected(p.user_id); setNotice(null); setActionError(null) }}>
                  <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                    <div style={s.personName}>
                      {p.name}{p.user_id === uid ? ' (you)' : ''}
                      <span style={s.roleTag}>{p.role}</span>
                      {!p.active && <span style={{ ...s.roleTag, background: '#FFF0E8', color: '#C45000' }}>inactive</span>}
                    </div>
                    <div style={s.personMeta}>
                      {units(p.units)} · {money(p.value)} · {p.products} product{p.products === 1 ? '' : 's'}
                      {p.reserved > 0 ? ` · ${p.reserved} in transit` : ''}
                    </div>
                    <div style={{ ...s.personMeta, color: p.short_units_30d > 0 ? '#C45000' : '#999' }}>
                      {p.short_units_30d > 0
                        ? `30 days: ${units(p.short_units_30d)} missing (${money(p.short_value_30d)})`
                        : '30 days: no shortage'}
                      {p.surplus_units_30d > 0 ? ` · ${p.surplus_units_30d} extra` : ''}
                      {' · '}{p.last_count_at ? `last count ${fmtDate(p.last_count_at)}` : 'never counted'}
                    </div>
                    {!p.active && p.units > 0 && (
                      <div style={{ ...s.personMeta, color: '#C45000' }}>Inactive account still holding stock — reassign it</div>
                    )}
                  </div>
                  <div style={{ color: '#BBB', fontSize: '18px' }}>›</div>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── Détail d'une personne ───────────────────────────────────────────── */}
      {selected && (
        <>
          {estGerant && (
            <button style={s.backBtn} onClick={() => { setSelected(null); setNotice(null); setActionError(null) }}>‹ Everyone</button>
          )}
          <div style={s.detailHeader}>
            <div style={{ minWidth: 0 }}>
              <div style={s.detailName}>{isOwn ? 'My stock' : personName}</div>
              {person && (
                <div style={s.personMeta}>
                  {units(person.units)} · {money(person.value)} at cost
                  {person.reserved > 0 ? ` · ${person.reserved} in transit` : ''}
                </div>
              )}
            </div>
            {estGerant && person && person.units > 0 && (
              <button style={s.ghostBtn} disabled={!isOnline} onClick={() => { setActionError(null); setShowReassign(true) }}>
                Reassign…
              </button>
            )}
          </div>

          {detailLoading && !detail ? (
            <div style={s.loading}>Loading…</div>
          ) : (
            <>
              <div style={s.sectionLabel}>Stock held</div>
              {holdings.length === 0 ? (
                <div style={s.emptyCard}>{isOwn ? 'You hold no stock' : `${personName} holds no stock`}</div>
              ) : (
                <div style={s.card}>
                  {holdings.map(h => (
                    <div key={h.product_id} style={s.row}>
                      <div style={{ ...s.emoji, background: (h.product_color ?? '#EEE') + '22' }}>{h.product_emoji ?? '🍬'}</div>
                      <div style={s.rowBody}>
                        <div style={s.rowTitle}>{h.product_name}</div>
                        <div style={s.rowMeta}>
                          {units(h.qty)}{h.reserved > 0 ? ` (${h.reserved} in transit)` : ''} · {money(h.value)}
                          {' · '}{h.last_count_at ? `counted ${fmtDate(h.last_count_at)}` : 'never counted'}
                        </div>
                      </div>
                      {canCount && (
                        <button style={s.countBtn} disabled={!isOnline} onClick={() => { setActionError(null); setCountTarget(h) }}>
                          Count
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div style={s.sectionLabel}>Counts and discrepancies</div>
              {(detail?.counts ?? []).length === 0 ? (
                <div style={s.emptyCard}>No count recorded yet</div>
              ) : (
                <div style={s.card}>
                  {detail.counts.map(c => {
                    const ok = c.delta === 0
                    return (
                      <div key={c.id} style={s.row}>
                        <div style={{ ...s.emoji, width: 34, height: 34, fontSize: 16, background: (c.product_color ?? '#EEE') + '22' }}>{c.product_emoji ?? '🍬'}</div>
                        <div style={s.rowBody}>
                          <div style={{ ...s.rowTitle, fontWeight: 400 }}>
                            {ok
                              ? `${c.product_name} — ${c.counted_qty} counted, as expected`
                              : `${c.product_name} — ${units(Math.abs(c.delta))} ${c.delta < 0 ? 'missing' : 'extra'} (counted ${c.counted_qty}, expected ${c.expected_qty})`}
                          </div>
                          <div style={s.rowMeta}>
                            {fmtDateTime(c.created_at)}
                            {!ok ? ` · ${reasonLabel(c.reason)}` : ''}
                            {c.note ? ` · “${c.note}”` : ''}
                            {c.declared_by !== selected ? ` · counted by ${c.declared_by === uid ? 'you' : c.declared_by_name}` : ''}
                          </div>
                        </div>
                        <div style={{
                          ...s.statusBadge,
                          background: ok ? '#E8F5EC' : (c.delta < 0 ? '#FFF0E8' : '#EAF1FF'),
                          color: ok ? '#2E7D42' : (c.delta < 0 ? '#C45000' : '#2F5FB3'),
                        }}>
                          {ok ? 'OK' : `${c.delta < 0 ? '−' : '+'}${money(Math.abs(c.value_delta))}`}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              <div style={s.sectionLabel}>Stock journal</div>
              {(detail?.movements ?? []).length === 0 ? (
                <div style={s.emptyCard}>No stock movement yet</div>
              ) : (
                <div style={s.card}>
                  {detail.movements.map(m => (
                    <div key={m.id} style={{ ...s.row, padding: '10px 16px' }}>
                      <div style={s.rowBody}>
                        <div style={{ ...s.rowTitle, fontWeight: 400 }}>{movementLabel(m.reason)} · {m.product_name ?? 'Unknown product'}</div>
                        <div style={s.rowMeta}>
                          {fmtDateTime(m.created_at)}
                          {m.actor_id && m.actor_id !== selected ? ` · by ${m.actor_id === uid ? 'you' : m.actor_name}` : ''}
                        </div>
                      </div>
                      <div style={{ fontSize: '13.5px', fontWeight: 600, color: m.delta < 0 ? '#C45000' : '#2E7D42', flexShrink: 0 }}>
                        {m.delta > 0 ? '+' : '−'}{Math.abs(m.delta)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}

      {countTarget && (
        <CountModal
          holding={countTarget}
          ownerName={isOwn ? null : personName}
          canSurplus={estGerant}
          saving={saving}
          error={actionError}
          onClose={() => { setCountTarget(null); setActionError(null) }}
          onSubmit={async (payload) => { if (await handleCount(payload)) setCountTarget(null) }}
        />
      )}
      {showReassign && person && (
        <ReassignModal
          person={person}
          holdings={holdings}
          targets={targets}
          saving={saving}
          error={actionError}
          onClose={() => { setShowReassign(false); setActionError(null) }}
          onSubmit={async (payload) => { if (await handleReassign(payload)) setShowReassign(false) }}
        />
      )}
    </div>
  )
}

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

// ── Compter un produit : écart appliqué tout de suite, motif obligatoire ─────
function CountModal({ holding, ownerName, canSurplus, saving, error, onClose, onSubmit }) {
  const [counted, setCounted] = useState('')
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const clientRef = useRef(newRequestId())

  const n = counted === '' ? NaN : parseInt(counted, 10)
  const valid = Number.isInteger(n) && n >= 0
  const delta = valid ? n - holding.qty : 0
  const inTransit = holding.reserved > 0
  const reasons = delta < 0 ? SHORTAGE_REASONS : SURPLUS_REASONS
  const reasonOk = delta === 0 || (reasons.some(([code]) => code === reason) && (reason !== 'other' || note.trim().length > 0))
  const blockedSurplus = delta > 0 && !canSurplus
  const blockedTransit = delta !== 0 && inTransit
  const canSubmit = valid && reasonOk && !blockedSurplus && !blockedTransit && !saving
  const whose = ownerName ? `${ownerName}'s` : 'your'

  return (
    <Sheet
      title={`Count ${holding.product_name}`}
      subtitle={`Count the units physically in ${whose} stock. The app expects ${holding.qty}.`
        + (inTransit ? ` ${holding.reserved} of them are in transit to a colleague.` : '')}
      onClose={onClose}
    >
      <div style={s.fieldGroup}>
        <div style={s.fieldLabel}>Units counted</div>
        <input
          style={s.input} type="number" inputMode="numeric" min="0"
          placeholder={`Expected: ${holding.qty}`}
          value={counted} onChange={e => { setCounted(e.target.value); setReason('') }} autoFocus
        />
        {valid && (
          <div style={{ ...s.preview, color: delta === 0 ? '#2E7D42' : '#C45000' }}>
            {delta === 0
              ? 'Matches the expected stock — nothing to correct'
              : (delta < 0
                ? `${units(-delta)} missing: ${whose} stock will go from ${holding.qty} to ${n}`
                : `${units(delta)} more than expected`)}
          </div>
        )}
      </div>

      {valid && blockedTransit && (
        <div style={s.errorBox}>
          {holding.reserved} unit(s) are in transit to a colleague. Wait for their answer or cancel the transfer before recording a discrepancy on this product.
        </div>
      )}
      {valid && !blockedTransit && blockedSurplus && (
        <div style={s.errorBox}>Only a manager can record a surplus. Count again, or ask a manager to check.</div>
      )}

      {valid && delta !== 0 && !blockedSurplus && !blockedTransit && (
        <>
          <div style={s.fieldGroup}>
            <div style={s.fieldLabel}>Reason (required)</div>
            <select style={s.input} value={reason} onChange={e => setReason(e.target.value)}>
              <option value="">Choose a reason…</option>
              {reasons.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
            </select>
          </div>
          <div style={s.fieldGroup}>
            <div style={s.fieldLabel}>{reason === 'other' ? 'Describe (required)' : 'Note (optional)'}</div>
            <input style={s.input} type="text" maxLength={200} placeholder="Ex: box crushed during transport" value={note} onChange={e => setNote(e.target.value)} />
          </div>
          <div style={s.preview}>The stock is corrected right away and the managers are notified.</div>
        </>
      )}

      {error && <div style={{ ...s.errorBox, marginTop: '12px' }}>{error}</div>}

      <button
        style={{ ...s.submitBtn, marginTop: '16px', opacity: canSubmit ? 1 : 0.5 }}
        disabled={!canSubmit}
        onClick={() => onSubmit({
          counted: n, reason: delta === 0 ? null : reason, note: delta === 0 ? null : note.trim(),
          clientRef: clientRef.current,
        })}
      >
        {saving ? 'Saving…' : (!valid || delta === 0
          ? 'Confirm count'
          : (delta < 0 ? `Record ${units(-delta)} missing` : `Record ${units(delta)} extra`))}
      </button>
    </Sheet>
  )
}

// ── Réattribuer le stock d'une personne (manager/admin), sans acceptation ────
function ReassignModal({ person, holdings, targets, saving, error, onClose, onSubmit }) {
  const [to, setTo] = useState('')
  const [scope, setScope] = useState('all')          // 'all' | 'one'
  const [productId, setProductId] = useState('')
  const [qty, setQty] = useState('')
  const [note, setNote] = useState('')
  const clientRef = useRef(newRequestId())

  const holding = holdings.find(h => h.product_id === productId)
  const n = qty === '' ? NaN : parseInt(qty, 10)
  const qtyOk = scope === 'all' || (!!holding && Number.isInteger(n) && n > 0 && n <= holding.qty)
  const valid = !!to && qtyOk
  const target = targets.find(t => t.id === to)
  const toName = target ? (target.name === 'Me' ? 'you' : target.name.replace(/ \(.*\)$/, '')) : ''
  const moved = scope === 'all' ? person.units : (qtyOk ? n : 0)

  return (
    <Sheet
      title={`Reassign ${person.name}'s stock`}
      subtitle="Applied immediately, without acceptance, at the same buying price. Both people are notified. Pending transfers sent by this person are reduced or cancelled if needed."
      onClose={onClose}
    >
      <div style={s.fieldGroup}>
        <div style={s.fieldLabel}>Give it to</div>
        <select style={s.input} value={to} onChange={e => setTo(e.target.value)}>
          <option value="">Choose a person…</option>
          {targets.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </div>

      <div style={s.fieldGroup}>
        <div style={s.fieldLabel}>What</div>
        <div style={{ display: 'flex', gap: '8px' }}>
          {[['all', `Everything (${units(person.units)})`], ['one', 'One product']].map(([val, label]) => (
            <button
              key={val}
              onClick={() => setScope(val)}
              style={{ ...s.scopeBtn, ...(scope === val ? s.scopeBtnActive : {}) }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {scope === 'one' && (
        <>
          <div style={s.fieldGroup}>
            <div style={s.fieldLabel}>Product</div>
            <select
              style={s.input} value={productId}
              onChange={e => {
                setProductId(e.target.value)
                const h = holdings.find(x => x.product_id === e.target.value)
                setQty(h ? String(h.qty) : '')
              }}
            >
              <option value="">Choose a product…</option>
              {holdings.map(h => (
                <option key={h.product_id} value={h.product_id}>{h.product_emoji ?? '🍬'} {h.product_name} — {h.qty}</option>
              ))}
            </select>
          </div>
          <div style={s.fieldGroup}>
            <div style={s.fieldLabel}>Quantity</div>
            <input
              style={s.input} type="number" inputMode="numeric" min="1" max={holding?.qty}
              value={qty} onChange={e => setQty(e.target.value)} disabled={!holding}
            />
            {holding && (
              <div style={{ ...s.preview, color: qtyOk ? '#999' : '#C00' }}>
                {qtyOk
                  ? `${person.name} keeps ${holding.qty - n}`
                    + (n > holding.qty - holding.reserved ? ` · ${n - (holding.qty - holding.reserved)} unit(s) in transit will be taken back from pending transfers` : '')
                  : `Enter a quantity between 1 and ${holding.qty}`}
              </div>
            )}
          </div>
        </>
      )}

      <div style={s.fieldGroup}>
        <div style={s.fieldLabel}>Note (optional)</div>
        <input style={s.input} type="text" maxLength={140} placeholder="Ex: left the team" value={note} onChange={e => setNote(e.target.value)} />
      </div>

      {error && <div style={s.errorBox}>{error}</div>}

      <button
        style={{ ...s.submitBtn, opacity: valid && !saving ? 1 : 0.5 }}
        disabled={!valid || saving}
        onClick={() => onSubmit({
          to, toName,
          productId: scope === 'one' ? productId : null,
          qty: scope === 'one' ? n : null,
          note: note.trim(), clientRef: clientRef.current,
        })}
      >
        {saving ? 'Saving…' : (valid ? `Move ${units(moved)} to ${toName}` : 'Reassign')}
      </button>
    </Sheet>
  )
}

const s = {
  loading: { color: '#999', fontSize: '14px', padding: '20px 0', fontFamily: "'DM Sans', sans-serif" },
  infoBox: { background: '#FFF8E6', color: '#8A6100', borderRadius: '12px', padding: '10px 14px', fontSize: '13px', marginBottom: '14px' },
  errorBox: { background: '#FFF0F0', color: '#C00', borderRadius: '12px', padding: '10px 14px', fontSize: '13px', marginBottom: '14px' },
  noticeBox: { background: '#E8F5EC', color: '#2E7D42', borderRadius: '12px', padding: '10px 14px', fontSize: '13px', marginBottom: '14px' },
  kpiRow: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px' },
  kpiCard: { background: 'white', borderRadius: '16px', padding: '16px', border: '1px solid rgba(0,0,0,0.05)', boxShadow: '0 2px 12px rgba(0,0,0,0.04)' },
  kpiLabel: { fontSize: '11px', color: '#999', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '6px' },
  kpiValue: { fontFamily: "'DM Serif Display', serif", fontSize: '20px', color: '#1A1A1A' },
  personCard: { display: 'flex', alignItems: 'center', gap: '12px', width: '100%', background: 'white', borderRadius: '18px', border: '1px solid rgba(0,0,0,0.05)', boxShadow: '0 2px 12px rgba(0,0,0,0.04)', padding: '14px 16px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", boxSizing: 'border-box' },
  personName: { fontSize: '14px', fontWeight: '500', color: '#1A1A1A', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
  roleTag: { fontSize: '10.5px', fontWeight: '500', color: '#777', background: '#F0F0F0', borderRadius: '100px', padding: '2px 8px' },
  personMeta: { fontSize: '11.5px', color: '#999', marginTop: '3px', lineHeight: 1.4 },
  backBtn: { background: 'none', border: 'none', color: '#666', fontSize: '13px', fontWeight: '500', cursor: 'pointer', padding: '0 0 10px', fontFamily: "'DM Sans', sans-serif" },
  detailHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '4px' },
  detailName: { fontFamily: "'DM Serif Display', serif", fontSize: '18px', color: '#1A1A1A' },
  sectionLabel: { fontSize: '11px', fontWeight: '600', color: '#999', textTransform: 'uppercase', letterSpacing: '0.6px', margin: '18px 0 8px' },
  card: { background: 'white', borderRadius: '18px', border: '1px solid rgba(0,0,0,0.05)', boxShadow: '0 2px 12px rgba(0,0,0,0.04)', overflow: 'hidden' },
  emptyCard: { background: 'white', borderRadius: '18px', border: '1px solid rgba(0,0,0,0.05)', padding: '18px 16px', color: '#BBB', fontSize: '13px', textAlign: 'center' },
  row: { display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 16px', borderBottom: '1px solid rgba(0,0,0,0.04)' },
  rowBody: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: '13.5px', fontWeight: '500', color: '#1A1A1A', lineHeight: 1.35 },
  rowMeta: { fontSize: '11.5px', color: '#999', marginTop: '3px', lineHeight: 1.4 },
  emoji: { width: '38px', height: '38px', fontSize: '18px', borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  countBtn: { padding: '7px 14px', background: '#1A1A1A', color: 'white', border: 'none', borderRadius: '100px', fontFamily: "'DM Sans', sans-serif", fontSize: '12.5px', fontWeight: '500', cursor: 'pointer', flexShrink: 0 },
  ghostBtn: { padding: '8px 14px', background: 'white', color: '#1A1A1A', border: '1.5px solid #EBEBEB', borderRadius: '100px', fontFamily: "'DM Sans', sans-serif", fontSize: '12.5px', fontWeight: '500', cursor: 'pointer', flexShrink: 0 },
  statusBadge: { padding: '4px 9px', borderRadius: '100px', fontSize: '11px', fontWeight: '500', whiteSpace: 'nowrap', flexShrink: 0 },
  scopeBtn: { flex: 1, padding: '10px 12px', borderRadius: '12px', border: '1.5px solid #EBEBEB', background: 'white', fontSize: '13px', fontWeight: '500', color: '#777', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  scopeBtnActive: { background: '#1A1A1A', color: 'white', borderColor: '#1A1A1A' },
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
