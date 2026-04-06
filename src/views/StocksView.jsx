import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export default function StocksView() {
  const [produits, setProduits] = useState([])
  const [batches, setBatches] = useState([])
  const [loading, setLoading] = useState(true)
  const [editProduit, setEditProduit] = useState(null)
  const [nouvelleQte, setNouvelleQte] = useState('')
  const [saving, setSaving] = useState(false)
  const [filtre, setFiltre] = useState('all') // 'all' | 'low' | 'ok'
  const [expandedId, setExpandedId] = useState(null) // Quel produit est ouvert

  useEffect(() => {
    fetchProduits()
    fetchBatches()
  }, [])

  const fetchProduits = async () => {
    const { data } = await supabase
        .from('products')
        .select('*')
        .order('stock', { ascending: true })
    setProduits(data ?? [])
    setLoading(false)
  }

  const fetchBatches = async () => {
    const { data } = await supabase
        .from('stock_batches')
        .select('*')
        .order('received_at', { ascending: false })
    setBatches(data ?? [])
  }

  const ouvrirAjoutBatch = (produit, e) => {
    e.stopPropagation() // Ne pas fermer l'expandable
    setEditProduit(produit)
    setNouvelleQte('')
  }

  const enregistrerBatch = async () => {
    const qty = parseInt(nouvelleQte)
    if (!qty || qty <= 0) return
    setSaving(true)

    try {
      const { data: newBatch, error: batchError } = await supabase
          .from('stock_batches')
          .insert({
            product_id: editProduit.id,
            received_qty: qty,
            received_at: new Date().toISOString(),
          })
          .select()
          .single()

      if (batchError) throw batchError

      const nouveauStock = editProduit.stock + qty
      const { error: stockError } = await supabase
          .from('products')
          .update({ stock: nouveauStock })
          .eq('id', editProduit.id)
      if (stockError) throw stockError

      const { error: movError } = await supabase
          .from('stock_movements')
          .insert({
            product_id: editProduit.id,
            batch_id: newBatch.id,
            delta: qty,
            reason: 'reception_carton',
          })
      if (movError) console.error('Erreur mouvement:', movError)

      await fetchProduits()
      await fetchBatches()
      setEditProduit(null)
    } catch (err) {
      console.error('Erreur:', err)
      alert('Erreur lors de l\'enregistrement')
    } finally {
      setSaving(false)
    }
  }

  const filtres = {
    all: produits,
    low: produits.filter(p => p.stock < 10),
    ok: produits.filter(p => p.stock >= 10),
  }
  const liste = filtres[filtre]

  const stockBas = produits.filter(p => p.stock < 10).length
  const stockTotal = produits.reduce((sum, p) => sum + p.stock, 0)
  const maxStock = Math.max(...produits.map(p => p.stock), 1)

  if (loading) return <div style={s.loading}>Loading…</div>

  return (
      <div style={{ fontFamily: "'DM Sans', sans-serif" }}>
        <p style={s.titre}>Inventory</p>

        {/* KPIs */}
        <div style={s.kpiRow}>
          <div style={s.kpiCard}>
            <div style={s.kpiLabel}>Total units</div>
            <div style={s.kpiValue}>{stockTotal.toLocaleString()}</div>
          </div>
          <div style={{ ...s.kpiCard, borderColor: stockBas > 0 ? '#FFCDB2' : 'rgba(0,0,0,0.05)' }}>
            <div style={s.kpiLabel}>Low stock</div>
            <div style={{ ...s.kpiValue, color: stockBas > 0 ? '#C45000' : '#2E7D42' }}>
              {stockBas > 0 ? `⚠ ${stockBas}` : '✓ 0'}
            </div>
          </div>
        </div>

        {/* Filtres */}
        <div style={s.filterRow}>
          {[['all', 'All'], ['low', `Low stock (${stockBas})`], ['ok', 'In stock']].map(([val, label]) => (
              <button
                  key={val}
                  onClick={() => setFiltre(val)}
                  style={{ ...s.filterBtn, ...(filtre === val ? s.filterBtnActive : {}) }}
              >
                {label}
              </button>
          ))}
        </div>

        {/* Liste produits avec expandables */}
        {liste.length === 0 ? (
            <div style={s.empty}><div style={{ fontSize: '32px', marginBottom: '12px' }}>📦</div>No products found</div>
        ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {liste.map((p) => {
                const pct = Math.min(p.stock / maxStock * 100, 100)
                const isLow = p.stock < 10
                const isExpanded = expandedId === p.id
                const productBatches = batches.filter(b => b.product_id === p.id)

                return (
                    <div key={p.id} style={{ overflow: 'hidden' }}>
                      {/* Row produit - cliquable pour expand */}
                      <div
                          onClick={() => setExpandedId(isExpanded ? null : p.id)}
                          style={{
                            ...s.productRow,
                            background: isExpanded ? '#F9F9F9' : 'white',
                            borderBottomLeftRadius: isExpanded ? 0 : '18px',
                            borderBottomRightRadius: isExpanded ? 0 : '18px',
                          }}
                      >
                        <div style={{ ...s.prodEmoji, background: (p.color ?? '#EEE') + '22' }}>{p.emoji ?? '🍬'}</div>
                        <div style={s.barWrap}>
                          <div style={s.barHeader}>
                            <span style={s.prodNom}>{p.name}</span>
                            <span style={{ ...s.stockQte, color: isLow ? '#C45000' : '#999' }}>
                        {isLow ? '⚠ ' : ''}{p.stock}
                      </span>
                          </div>
                          <div style={s.barTrack}>
                            <div style={{
                              ...s.barFill,
                              width: `${pct}%`,
                              background: isLow
                                  ? 'linear-gradient(90deg,#FFAB76,#C45000)'
                                  : `linear-gradient(90deg,${p.color ?? '#5BAD72'}88,${p.color ?? '#5BAD72'})`,
                            }} />
                          </div>
                        </div>

                        {/* Bouton expand + add batch */}
                        <button
                            onClick={(e) => ouvrirAjoutBatch(p, e)}
                            style={s.addBatchBtn}
                            title="Add batch"
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                          </svg>
                        </button>

                        {/* Chevron expand */}
                        <div style={{
                          width: '20px',
                          height: '20px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: '#999',
                          transform: isExpanded ? 'rotate(180deg)' : 'rotate(0)',
                          transition: 'transform 0.2s ease',
                          cursor: 'pointer',
                        }}>
                          ▼
                        </div>
                      </div>

                      {/* Section batches - affichée si expanded */}
                      {isExpanded && (
                          <div style={s.expandedSection}>
                            {productBatches.length === 0 ? (
                                <div style={{ padding: '16px', textAlign: 'center', color: '#BBB', fontSize: '12px' }}>
                                  No batches yet
                                </div>
                            ) : (
                                <div>
                                  {productBatches.map((batch, i) => {
                                    const received = new Date(batch.received_at)
                                    const exhausted = batch.exhausted_at ? new Date(batch.exhausted_at) : new Date()
                                    const days = batch.duration_days ?? Math.round((exhausted - received) / (1000 * 60 * 60 * 24))
                                    const isActive = batch.exhausted_at === null

                                    return (
                                        <div
                                            key={batch.id}
                                            style={{
                                              ...s.batchRow,
                                              borderBottom: i < productBatches.length - 1 ? '1px solid rgba(0,0,0,0.04)' : 'none',
                                            }}
                                        >
                                          <div style={{
                                            ...s.statusBadge,
                                            background: isActive ? '#E8F5EC' : '#FFF0E8',
                                            color: isActive ? '#2E7D42' : '#C45000',
                                          }}>
                                            {isActive ? '🟢' : '✓'}
                                          </div>

                                          <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={s.batchInfo}>
                                              <div>
                                                <div style={s.batchQty}>{batch.received_qty} units</div>
                                                <div style={s.batchDate}>{received.toLocaleDateString('en', { month: 'short', day: 'numeric' })}</div>
                                              </div>
                                              {batch.exhausted_at && (
                                                  <div style={{ textAlign: 'right' }}>
                                                    <div style={s.batchQty}>Exhausted</div>
                                                    <div style={s.batchDate}>{exhausted.toLocaleDateString('en', { month: 'short', day: 'numeric' })}</div>
                                                  </div>
                                              )}
                                            </div>

                                            <div style={{ marginTop: '6px' }}>
                                              <div style={s.timelineBar}>
                                                <div style={{
                                                  ...s.timelineFill,
                                                  width: '100%',
                                                  background: isActive ? 'linear-gradient(90deg, #5BAD72, #2E7D42)' : 'linear-gradient(90deg, #C4A8E0, #999)',
                                                }} />
                                              </div>
                                              <div style={{ fontSize: '10px', color: '#999', marginTop: '3px' }}>
                                                {days}d {isActive ? '(ongoing)' : '(done)'}
                                              </div>
                                            </div>
                                          </div>
                                        </div>
                                    )
                                  })}
                                </div>
                            )}
                          </div>
                      )}
                    </div>
                )
              })}
            </div>
        )}

        {/* Modal ajout batch */}
        {editProduit && (
            <div style={s.overlay} onClick={e => { if (e.target === e.currentTarget) setEditProduit(null) }}>
              <div style={s.modal}>
                <div style={s.handle} />
                <div style={s.modalHeader}>
                  <div style={{ ...s.prodEmoji, width: '52px', height: '52px', fontSize: '26px', borderRadius: '14px', background: (editProduit.color ?? '#EEE') + '22' }}>
                    {editProduit.emoji ?? '🍬'}
                  </div>
                  <div>
                    <div style={s.modalNom}>{editProduit.name}</div>
                    <div style={s.modalStock}>Current stock: <strong>{editProduit.stock}</strong> units</div>
                  </div>
                </div>

                <div style={s.fieldGroup}>
                  <div style={s.fieldLabel}>Quantity in new box</div>
                  <input
                      style={s.input}
                      type="number"
                      placeholder="Ex: 100"
                      value={nouvelleQte}
                      onChange={e => setNouvelleQte(e.target.value)}
                      autoFocus
                  />
                  {nouvelleQte && parseInt(nouvelleQte) > 0 && (
                      <div style={s.preview}>
                        New total: <strong>{editProduit.stock + parseInt(nouvelleQte)} units</strong>
                      </div>
                  )}
                </div>

                <div style={s.shortcutRow}>
                  {[50, 100, 150, 200].map(n => (
                      <button key={n} style={s.shortcut} onClick={() => setNouvelleQte(String(n))}>+{n}</button>
                  ))}
                </div>

                <button
                    style={{ ...s.submitBtn, opacity: (!nouvelleQte || saving) ? 0.5 : 1 }}
                    onClick={enregistrerBatch}
                    disabled={!nouvelleQte || saving}
                >
                  {saving ? 'Saving…' : 'Register batch'}
                </button>
              </div>
            </div>
        )}
      </div>
  )
}

const s = {
  loading: { color: '#999', fontSize: '14px', paddingTop: '20px' },
  titre: { fontFamily: "'DM Serif Display', serif", fontSize: '18px', color: '#1A1A1A', marginBottom: '16px', marginBottom: '16px' },
  kpiRow: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px' },
  kpiCard: { background: 'white', borderRadius: '16px', padding: '16px', border: '1px solid rgba(0,0,0,0.05)', boxShadow: '0 2px 12px rgba(0,0,0,0.04)' },
  kpiLabel: { fontSize: '11px', color: '#999', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '6px' },
  kpiValue: { fontFamily: "'DM Serif Display', serif", fontSize: '22px', color: '#1A1A1A' },
  filterRow: { display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' },
  filterBtn: { padding: '7px 14px', borderRadius: '100px', border: '1.5px solid #EBEBEB', background: 'white', fontSize: '12.5px', fontWeight: '500', color: '#999', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  filterBtnActive: { background: '#1A1A1A', color: 'white', borderColor: '#1A1A1A' },
  empty: { textAlign: 'center', padding: '48px 24px', color: '#BBB', fontSize: '14px' },
  productRow: { background: 'white', borderRadius: '18px', border: '1px solid rgba(0,0,0,0.05)', boxShadow: '0 2px 12px rgba(0,0,0,0.04)', display: 'flex', alignItems: 'center', padding: '14px 16px', gap: '12px', cursor: 'pointer', transition: 'all 0.2s ease' },
  expandedSection: { background: '#F9F9F9', borderRadius: '0 0 18px 18px', border: '1px solid rgba(0,0,0,0.05)', borderTop: 'none', boxShadow: '0 2px 12px rgba(0,0,0,0.04)' },
  prodEmoji: { width: '38px', height: '38px', borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px', flexShrink: 0 },
  barWrap: { flex: 1, minWidth: 0 },
  barHeader: { display: 'flex', justifyContent: 'space-between', marginBottom: '5px' },
  prodNom: { fontSize: '13px', fontWeight: '500', color: '#1A1A1A', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '55%' },
  stockQte: { fontSize: '12px' },
  barTrack: { height: '4px', background: '#F0F0F0', borderRadius: '10px', overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: '10px', transition: 'width 0.6s ease' },
  addBatchBtn: { width: '32px', height: '32px', borderRadius: '50%', background: '#F5F5F5', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#1A1A1A', flexShrink: 0, transition: 'all 0.2s ease' },
  fieldGroup: { marginBottom: '16px' },
  fieldLabel: { fontSize: '11.5px', fontWeight: '600', color: '#999', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '8px' },
  batchRow: { display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '12px 16px' },
  statusBadge: { padding: '4px 8px', borderRadius: '100px', fontSize: '11px', fontWeight: '500', whiteSpace: 'nowrap', flexShrink: 0 },
  batchInfo: { display: 'flex', gap: '16px', marginBottom: '6px' },
  batchQty: { fontSize: '12px', fontWeight: '500', color: '#1A1A1A' },
  batchDate: { fontSize: '10px', color: '#999', marginTop: '1px' },
  timelineBar: { height: '3px', background: '#F0F0F0', borderRadius: '10px', overflow: 'hidden' },
  timelineFill: { height: '100%', borderRadius: '10px' },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(4px)', zIndex: 100, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
  modal: { background: 'white', borderRadius: '28px 28px 0 0', padding: '8px 24px 40px', width: '100%', maxWidth: '430px', fontFamily: "'DM Sans', sans-serif" },
  handle: { width: '36px', height: '4px', background: '#E0E0E0', borderRadius: '10px', margin: '10px auto 20px' },
  modalHeader: { display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '24px' },
  modalNom: { fontFamily: "'DM Serif Display', serif", fontSize: '20px', color: '#1A1A1A' },
  modalStock: { fontSize: '13px', color: '#999', marginTop: '2px' },
  input: { width: '100%', padding: '13px 16px', borderRadius: '12px', border: '1.5px solid #EBEBEB', fontSize: '15px', fontFamily: "'DM Sans', sans-serif", color: '#1A1A1A', outline: 'none', boxSizing: 'border-box' },
  preview: { fontSize: '13px', color: '#999', marginTop: '8px', padding: '8px 12px', background: '#F9F9F9', borderRadius: '8px' },
  shortcutRow: { display: 'flex', gap: '8px', marginBottom: '20px' },
  shortcut: { flex: 1, padding: '10px', background: '#F5F5F5', border: 'none', borderRadius: '10px', fontSize: '13px', fontWeight: '500', color: '#1A1A1A', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  submitBtn: { width: '100%', padding: '16px', background: '#1A1A1A', color: 'white', border: 'none', borderRadius: '16px', fontFamily: "'DM Sans', sans-serif", fontSize: '15px', fontWeight: '500', cursor: 'pointer' },
}