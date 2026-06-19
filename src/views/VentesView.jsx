import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { formatPrice, round2 } from '../lib/format'

export default function VentesView() {
  const [sales, setSales] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('toutes') // toutes, payees, dettes
  const [search, setSearch] = useState('')
  const [dateStart, setDateStart] = useState('')
  const [dateEnd, setDateEnd] = useState('')
  const [profitData, setProfitData] = useState(null)
  const [saleToCancel, setSaleToCancel] = useState(null)
  const [cancelling, setCancelling] = useState(false)
  const [usersById, setUsersById] = useState({})
  const [visibleCount, setVisibleCount] = useState(10)

  useEffect(() => { fetchSales(); fetchUsers() }, [])

  // Revenir à 10 ventes affichées dès que le filtre ou la recherche change,
  // sinon "load more" garderait un nombre incohérent avec la nouvelle liste
  useEffect(() => { setVisibleCount(10) }, [filter, search])

  const fetchSales = async () => {
    const { data } = await supabase
        .from('sales')
        .select('id, product_id, client_id, user_id, qty, amount, type, created_at, products(name, emoji, price, cost), clients(name)')
        .order('created_at', { ascending: false })
    setSales(data ?? [])
    setLoading(false)
  }

  // Récupérer les vendeurs (email) pour affichage — pas de FK déclarée
  // entre sales.user_id et users_view, donc on fait un fetch à part
  // et on associe en mémoire par id.
  const fetchUsers = async () => {
    const { data } = await supabase
        .from('users_view')
        .select('id, email')
    const map = {}
    ;(data ?? []).forEach(u => { map[u.id] = u.email })
    setUsersById(map)
  }

  const handleCalculateProfit = async () => {
    if (!dateStart || !dateEnd) {
      alert('Veuillez sélectionner une plage de dates')
      return
    }

    const start = new Date(dateStart).toISOString()
    const end = new Date(dateEnd + 'T23:59:59').toISOString()

    // Récupérer les ventes sur la période (avec cost du produit)
    const { data: periodSales } = await supabase
        .from('sales')
        .select('id, product_id, qty, amount, type, products(name, emoji, price, cost)')
        .gte('created_at', start)
        .lte('created_at', end)

    if (!periodSales || periodSales.length === 0) {
      alert('Aucune vente sur cette période')
      setProfitData(null)
      return
    }

    // Calculer les stats
    let totalRevenue = 0
    let totalCost = 0
    let cashRevenue = 0
    let creditRevenue = 0
    let transactionCount = 0

    periodSales.forEach(sale => {
      totalRevenue += sale.amount
      const productCost = sale.products?.cost ?? 0
      const saleItemCost = productCost * sale.qty
      totalCost += saleItemCost

      if (sale.type === 'cash') {
        cashRevenue += sale.amount
      } else {
        creditRevenue += sale.amount
      }
      transactionCount += 1
    })

    const profit = totalRevenue - totalCost
    const profitMargin = totalRevenue > 0 ? ((profit / totalRevenue) * 100).toFixed(1) : 0

    setProfitData({
      periodStart: dateStart,
      periodEnd: dateEnd,
      totalRevenue: round2(totalRevenue),
      totalCost: round2(totalCost),
      profit: round2(profit),
      profitMargin,
      cashRevenue: round2(cashRevenue),
      creditRevenue: round2(creditRevenue),
      transactionCount,
      avgProfit: transactionCount > 0 ? round2(profit / transactionCount) : 0,
    })
  }

  const formatDate = (iso) => {
    return new Date(iso).toLocaleDateString('fr', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  }

  // Confirmer l'annulation d'une vente
  const handleConfirmCancel = async () => {
    if (!saleToCancel) return
    setCancelling(true)

    const sale = saleToCancel

    try {
      // 1. Restaurer le stock du produit
      if (sale.product_id) {
        const { data: product } = await supabase
            .from('products')
            .select('stock')
            .eq('id', sale.product_id)
            .single()

        const newStock = (product?.stock ?? 0) + sale.qty

        await supabase
            .from('products')
            .update({ stock: newStock })
            .eq('id', sale.product_id)

        // 2. Journaliser le mouvement de stock
        await supabase
            .from('stock_movements')
            .insert({
              product_id: sale.product_id,
              delta: sale.qty,
              reason: 'Sale cancelled',
            })
      }

      // 3. Si vente à crédit, réduire la dette du client
      if (sale.type === 'dette' && sale.client_id) {
        const { data: client } = await supabase
            .from('clients')
            .select('debt')
            .eq('id', sale.client_id)
            .single()

        const newDebt = round2(Math.max(0, (client?.debt ?? 0) - sale.amount))

        await supabase
            .from('clients')
            .update({ debt: newDebt })
            .eq('id', sale.client_id)
      }

      // 4. Supprimer la vente
      await supabase
          .from('sales')
          .delete()
          .eq('id', sale.id)

      setSaleToCancel(null)
      fetchSales()
    } catch (err) {
      alert("Erreur lors de l'annulation de la vente")
      console.error(err)
    } finally {
      setCancelling(false)
    }
  }

  // Filtrer les ventes par type puis par recherche nominative
  const filtered = sales
      .filter(s => {
        if (filter === 'payees') return s.type === 'cash'
        if (filter === 'dettes') return s.type === 'dette'
        return true
      })
      .filter(s => {
        if (!search.trim()) return true
        const q = search.trim().toLowerCase()
        const productName = s.products?.name?.toLowerCase() ?? ''
        const clientName = s.clients?.name?.toLowerCase() ?? ''
        const sellerEmail = (s.user_id ? usersById[s.user_id] : '')?.toLowerCase() ?? ''
        return productName.includes(q) || clientName.includes(q) || sellerEmail.includes(q)
      })

  const visibleSales = filtered.slice(0, visibleCount)
  const hasMore = visibleCount < filtered.length

  if (loading) return <div style={{ color: '#999', fontSize: '14px', paddingTop: '20px', fontFamily: "'DM Sans', sans-serif" }}>Loading…</div>

  return (
      <div style={{ fontFamily: "'DM Sans', sans-serif" }}>
        {/* Header */}
        <p style={{ fontFamily: "'DM Serif Display', serif", fontSize: '18px', color: '#1A1A1A', marginBottom: '16px' }}>Sales</p>

        {/* Filtres par type */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
          {[
            { id: 'toutes', label: 'All' },
            { id: 'payees', label: 'Paid' },
            { id: 'dettes', label: 'Credit' },
          ].map(f => (
              <button
                  key={f.id}
                  onClick={() => setFilter(f.id)}
                  style={{
                    padding: '8px 14px',
                    borderRadius: '100px',
                    border: 'none',
                    background: filter === f.id ? '#1A1A1A' : 'white',
                    color: filter === f.id ? 'white' : '#999',
                    fontFamily: "'DM Sans', sans-serif",
                    fontSize: '13px',
                    fontWeight: '500',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                    borderWidth: '1px',
                    borderStyle: 'solid',
                    borderColor: filter === f.id ? '#1A1A1A' : '#EBEBEB',
                  }}
              >
                {f.label}
              </button>
          ))}
        </div>

        {/* Barre de recherche nominative */}
        <div style={{ position: 'relative', marginBottom: '16px' }}>
          <span style={{ position: 'absolute', left: '14px', top: '50%', transform: 'translateY(-50%)', fontSize: '14px', color: '#BBB' }}>🔍</span>
          <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by product, client or seller"
              style={{
                width: '100%',
                padding: '11px 14px 11px 38px',
                borderRadius: '12px',
                border: '1.5px solid #EBEBEB',
                fontSize: '13px',
                fontFamily: "'DM Sans', sans-serif",
                boxSizing: 'border-box',
                background: 'white',
              }}
          />
          {search && (
              <button
                  onClick={() => setSearch('')}
                  style={{
                    position: 'absolute',
                    right: '10px',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none',
                    border: 'none',
                    color: '#BBB',
                    fontSize: '15px',
                    cursor: 'pointer',
                    padding: '4px',
                  }}
              >
                ✕
              </button>
          )}
        </div>

        {/* Total encaissé */}
        <div style={{ background: '#1A1A1A', borderRadius: '20px', padding: '22px 20px', marginBottom: '20px' }}>
          <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '8px' }}>
            {filter === 'toutes' ? 'Total · All Sales' : filter === 'payees' ? 'Total · Paid' : 'Total · Credit'}
          </div>
          <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: '32px', color: 'white', letterSpacing: '-0.5px' }}>
            {formatPrice(filtered.reduce((sum, s) => sum + s.amount, 0))} <span style={{ fontSize: '18px' }}>GH₵</span>
          </div>
          <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.4)', marginTop: '6px' }}>
            {filtered.length} transaction{filtered.length !== 1 ? 's' : ''}
          </div>
        </div>

        {/* Ventes récentes */}
        {filtered.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '48px 24px', color: '#BBB', fontSize: '14px' }}>
              <div style={{ fontSize: '32px', marginBottom: '12px' }}>🛒</div>No sales
            </div>
        ) : (
            <div style={{ background: 'white', borderRadius: '18px', border: '1px solid rgba(0,0,0,0.05)', boxShadow: '0 2px 12px rgba(0,0,0,0.04)', overflow: 'hidden', marginBottom: hasMore ? '12px' : '24px' }}>
              {visibleSales.map((s, i) => (
                  <div key={s.id} style={{ ...saleRowStyles, borderBottom: i < visibleSales.length - 1 ? '1px solid rgba(0,0,0,0.04)' : 'none' }}>
                    <div style={{ width: '34px', height: '34px', borderRadius: '9px', background: '#F5F5F5', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px', flexShrink: 0 }}>
                      {s.products?.emoji ?? '🍬'}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '13px', fontWeight: '500', color: '#1A1A1A', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {s.products?.name ?? '—'}
                      </div>
                      <div style={{ fontSize: '11px', color: '#BBB', marginTop: '1px' }}>
                        {s.clients?.name ?? 'Unknown'} · {formatDate(s.created_at)} · x{s.qty}
                      </div>
                      {s.user_id && usersById[s.user_id] && (
                          <div style={{ fontSize: '10px', color: '#CCC', marginTop: '1px' }}>
                            👤 {usersById[s.user_id]}
                          </div>
                      )}
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontSize: '13px', fontWeight: '600', color: '#1A1A1A' }}>{s.amount?.toLocaleString()} GH₵</div>
                      <span style={s.type === 'cash' ? badgeCashStyles : badgeDetteStyles}>
                  {s.type === 'cash' ? 'Paid' : 'Credit'}
                </span>
                    </div>
                    <button
                        onClick={() => setSaleToCancel(s)}
                        title="Cancel sale"
                        style={{
                          background: 'none',
                          border: 'none',
                          color: '#BBB',
                          fontSize: '15px',
                          cursor: 'pointer',
                          padding: '6px',
                          flexShrink: 0,
                          lineHeight: 1,
                        }}
                    >
                      🗑️
                    </button>
                  </div>
              ))}
            </div>
        )}

        {/* Load more */}
        {hasMore && (
            <div style={{ textAlign: 'center', marginBottom: '24px' }}>
              <button
                  onClick={() => setVisibleCount(c => c + 5)}
                  style={{
                    padding: '10px 20px',
                    borderRadius: '100px',
                    border: '1.5px solid #EBEBEB',
                    background: 'white',
                    color: '#1A1A1A',
                    fontFamily: "'DM Sans', sans-serif",
                    fontSize: '13px',
                    fontWeight: '500',
                    cursor: 'pointer',
                  }}
              >
                Load more
              </button>
              <div style={{ fontSize: '11px', color: '#BBB', marginTop: '8px' }}>
                {visibleSales.length} of {filtered.length}
              </div>
            </div>
        )}

        {/* CALENDRIER CALCUL PROFIT */}
        <div style={{ background: '#F9F9F9', borderRadius: '18px', padding: '20px', marginBottom: '24px' }}>
          <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: '16px', color: '#1A1A1A', marginBottom: '16px' }}>📅 Profit Calculator</div>

          <div style={{ display: 'flex', gap: '12px', marginBottom: '12px' }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: '11px', color: '#999', textTransform: 'uppercase', letterSpacing: '0.6px', display: 'block', marginBottom: '6px' }}>From</label>
              <input
                  type="date"
                  value={dateStart}
                  onChange={e => setDateStart(e.target.value)}
                  style={{ width: '100%', padding: '10px 12px', borderRadius: '10px', border: '1.5px solid #EBEBEB', fontSize: '13px', fontFamily: "'DM Sans', sans-serif", boxSizing: 'border-box' }}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: '11px', color: '#999', textTransform: 'uppercase', letterSpacing: '0.6px', display: 'block', marginBottom: '6px' }}>To</label>
              <input
                  type="date"
                  value={dateEnd}
                  onChange={e => setDateEnd(e.target.value)}
                  style={{ width: '100%', padding: '10px 12px', borderRadius: '10px', border: '1.5px solid #EBEBEB', fontSize: '13px', fontFamily: "'DM Sans', sans-serif", boxSizing: 'border-box' }}
              />
            </div>
          </div>

          <button
              onClick={handleCalculateProfit}
              style={{
                width: '100%',
                padding: '12px',
                background: '#1A1A1A',
                color: 'white',
                border: 'none',
                borderRadius: '10px',
                fontFamily: "'DM Sans', sans-serif",
                fontSize: '13px',
                fontWeight: '500',
                cursor: 'pointer',
              }}
          >
            Calculate Profit
          </button>

          {/* Résultats profit */}
          {profitData && (
              <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid #EBEBEB' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '12px' }}>
                  <div style={{ background: 'white', borderRadius: '10px', padding: '12px' }}>
                    <div style={{ fontSize: '10px', color: '#999', textTransform: 'uppercase', marginBottom: '4px' }}>Revenue</div>
                    <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: '18px', color: '#1A1A1A' }}>
                      {profitData.totalRevenue.toLocaleString()} GH₵
                    </div>
                  </div>

                  <div style={{ background: 'white', borderRadius: '10px', padding: '12px' }}>
                    <div style={{ fontSize: '10px', color: '#999', textTransform: 'uppercase', marginBottom: '4px' }}>Cost</div>
                    <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: '18px', color: '#C45000' }}>
                      {profitData.totalCost.toLocaleString()} GH₵
                    </div>
                  </div>

                  <div style={{ background: '#E8F5EC', borderRadius: '10px', padding: '12px' }}>
                    <div style={{ fontSize: '10px', color: '#2E7D42', textTransform: 'uppercase', marginBottom: '4px' }}>Profit</div>
                    <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: '18px', color: '#2E7D42', fontWeight: '600' }}>
                      {profitData.profit.toLocaleString()} GH₵
                    </div>
                  </div>

                  <div style={{ background: '#E8F5EC', borderRadius: '10px', padding: '12px' }}>
                    <div style={{ fontSize: '10px', color: '#2E7D42', textTransform: 'uppercase', marginBottom: '4px' }}>Margin %</div>
                    <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: '18px', color: '#2E7D42', fontWeight: '600' }}>
                      {profitData.profitMargin}%
                    </div>
                  </div>
                </div>

                <div style={{ background: 'white', borderRadius: '10px', padding: '12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13px', marginBottom: '8px' }}>
                    <span style={{ color: '#999' }}>Cash sales</span>
                    <span style={{ fontWeight: '600', color: '#2E7D42' }}>{profitData.cashRevenue.toLocaleString()} GH₵</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13px', marginBottom: '8px' }}>
                    <span style={{ color: '#999' }}>Credit sales</span>
                    <span style={{ fontWeight: '600', color: '#C45000' }}>{profitData.creditRevenue.toLocaleString()} GH₵</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13px' }}>
                    <span style={{ color: '#999' }}>Avg profit / transaction</span>
                    <span style={{ fontWeight: '600', color: '#1A1A1A' }}>{profitData.avgProfit.toLocaleString()} GH₵</span>
                  </div>
                </div>
              </div>
          )}
        </div>

        {/* Modal de confirmation d'annulation */}
        {saleToCancel && (
            <div
                style={{
                  position: 'fixed',
                  inset: 0,
                  background: 'rgba(0,0,0,0.4)',
                  display: 'flex',
                  alignItems: 'flex-end',
                  justifyContent: 'center',
                  zIndex: 1000,
                }}
                onClick={() => !cancelling && setSaleToCancel(null)}
            >
              <div
                  style={{
                    background: 'white',
                    borderRadius: '28px 28px 0 0',
                    padding: '24px 20px 28px',
                    width: '100%',
                    maxWidth: '430px',
                    boxSizing: 'border-box',
                  }}
                  onClick={e => e.stopPropagation()}
              >
                <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: '18px', color: '#1A1A1A', marginBottom: '8px' }}>
                  Cancel this sale?
                </div>
                <div style={{ fontSize: '13px', color: '#999', marginBottom: '16px', lineHeight: '1.5' }}>
                  {saleToCancel.products?.name ?? 'Product'} · x{saleToCancel.qty} · {saleToCancel.amount?.toLocaleString()} GH₵
                  <br />
                  Stock will be restored
                  {saleToCancel.type === 'dette' ? ' and the client\'s debt will be reduced accordingly.' : '.'}
                  {' '}This cannot be undone.
                </div>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button
                      onClick={() => setSaleToCancel(null)}
                      disabled={cancelling}
                      style={{
                        flex: 1,
                        padding: '12px',
                        background: '#F5F5F5',
                        color: '#1A1A1A',
                        border: 'none',
                        borderRadius: '10px',
                        fontFamily: "'DM Sans', sans-serif",
                        fontSize: '13px',
                        fontWeight: '500',
                        cursor: cancelling ? 'default' : 'pointer',
                      }}
                  >
                    Keep sale
                  </button>
                  <button
                      onClick={handleConfirmCancel}
                      disabled={cancelling}
                      style={{
                        flex: 1,
                        padding: '12px',
                        background: '#E84B6E',
                        color: 'white',
                        border: 'none',
                        borderRadius: '10px',
                        fontFamily: "'DM Sans', sans-serif",
                        fontSize: '13px',
                        fontWeight: '500',
                        cursor: cancelling ? 'default' : 'pointer',
                        opacity: cancelling ? 0.7 : 1,
                      }}
                  >
                    {cancelling ? 'Cancelling…' : 'Cancel sale'}
                  </button>
                </div>
              </div>
            </div>
        )}
      </div>
  )
}

const saleRowStyles = { display: 'flex', alignItems: 'center', padding: '12px 16px', gap: '12px' }
const badgeCashStyles = { display: 'inline-block', padding: '2px 7px', borderRadius: '100px', fontSize: '10px', fontWeight: '500', background: '#E8F5EC', color: '#2E7D42', marginTop: '2px' }
const badgeDetteStyles = { display: 'inline-block', padding: '2px 7px', borderRadius: '100px', fontSize: '10px', fontWeight: '500', background: '#FFF0E8', color: '#C45000', marginTop: '2px' }