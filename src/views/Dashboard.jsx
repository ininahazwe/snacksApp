import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export default function Dashboard({ onProductTap }) {
  const [stats, setStats] = useState({ today: 0, week: 0, month: 0, nbToday: 0, dettes: 0, stockBas: 0 })
  const [ventesRecentes, setVentesRecentes] = useState([])
  const [topProduits, setTopProduits] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => { fetchDashboard() }, [])

  const fetchDashboard = async () => {
    const now = new Date()
    const today     = now.toISOString().split('T')[0]
    const lundiDernier = new Date(now); lundiDernier.setDate(now.getDate() - now.getDay() + 1); lundiDernier.setHours(0,0,0,0)
    const premierMois = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()

    const [{ data: salesToday }, { data: salesWeek }, { data: salesMonth }, { data: clientsData }, { data: stocksData }, { data: recentes }] = await Promise.all([
      supabase.from('sales').select('amount, type').gte('created_at', `${today}T00:00:00`),
      supabase.from('sales').select('amount, type').gte('created_at', lundiDernier.toISOString()),
      supabase.from('sales').select('amount, type, product_id, qty, products(name,emoji)').gte('created_at', premierMois),
      supabase.from('clients').select('debt'),
      supabase.from('products').select('stock').lt('stock', 10),
      supabase.from('sales').select('amount, type, created_at, products(name,emoji), clients(name)').order('created_at', { ascending: false }).limit(5),
    ])

    // Top produits du mois
    const compteur = {}
    salesMonth?.forEach(v => {
      if (!v.product_id) return
      if (!compteur[v.product_id]) compteur[v.product_id] = { nom: v.products?.name, emoji: v.products?.emoji, total: 0, qty: 0 }
      compteur[v.product_id].total += v.amount
      compteur[v.product_id].qty += v.qty
    })
    const top = Object.values(compteur).sort((a, b) => b.total - a.total).slice(0, 3)

    setStats({
      today:    salesToday?.filter(s => s.type === 'cash').reduce((sum, s) => sum + s.amount, 0) ?? 0,
      week:     salesWeek?.filter(s => s.type === 'cash').reduce((sum, s) => sum + s.amount, 0) ?? 0,
      month:    salesMonth?.filter(s => s.type === 'cash').reduce((sum, s) => sum + s.amount, 0) ?? 0,
      nbToday:  salesToday?.length ?? 0,
      dettes:   clientsData?.reduce((sum, c) => sum + (c.debt ?? 0), 0) ?? 0,
      stockBas: stocksData?.length ?? 0,
    })
    setVentesRecentes(recentes ?? [])
    setTopProduits(top)
    setLoading(false)
  }

  const formatDate = (iso) => new Date(iso).toLocaleDateString('en', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

  if (loading) return <div style={s.loading}>Loading…</div>

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif" }}>

      {/* KPI principal */}
      <div style={s.kpiAccent}>
        <div style={s.kpiAccentLabel}>Today's revenue</div>
        <div style={s.kpiAccentValue}>{stats.today.toLocaleString()} <span style={{ fontSize: 18 }}>GH₵</span></div>
        <div style={s.kpiAccentSub}>{stats.nbToday} transaction{stats.nbToday !== 1 ? 's' : ''}</div>
      </div>

      {/* KPIs secondaires */}
      <div style={s.kpiGrid}>
        <div style={s.kpiCard}>
          <div style={s.kpiLabel}>This week</div>
          <div style={s.kpiValue}>{stats.week.toLocaleString()}</div>
          <div style={s.kpiSub}>GH₵</div>
        </div>
        <div style={s.kpiCard}>
          <div style={s.kpiLabel}>This month</div>
          <div style={s.kpiValue}>{stats.month.toLocaleString()}</div>
          <div style={s.kpiSub}>GH₵</div>
        </div>
        <div style={s.kpiCard}>
          <div style={s.kpiLabel}>Outstanding</div>
          <div style={{ ...s.kpiValue, color: stats.dettes > 0 ? '#C45000' : '#2E7D42' }}>
            {stats.dettes.toLocaleString()}
          </div>
          <div style={s.kpiSub}>GH₵ debt</div>
        </div>
        <div style={{ ...s.kpiCard, borderColor: stats.stockBas > 0 ? '#FFCDB2' : 'rgba(0,0,0,0.05)' }}>
          <div style={s.kpiLabel}>Low stock</div>
          <div style={{ ...s.kpiValue, color: stats.stockBas > 0 ? '#C45000' : '#2E7D42' }}>
            {stats.stockBas > 0 ? `⚠ ${stats.stockBas}` : '✓ 0'}
          </div>
          <div style={s.kpiSub}>product{stats.stockBas !== 1 ? 's' : ''}</div>
        </div>
      </div>

      {/* Top produits */}
      {topProduits.length > 0 && (
        <>
          <p style={s.sectionTitle}>Top products · this month</p>
          <div style={s.card}>
            {topProduits.map((p, i) => (
              <div key={i} style={{ ...s.topRow, borderBottom: i < topProduits.length - 1 ? '1px solid rgba(0,0,0,0.04)' : 'none' }}>
                <div style={s.topRank}>#{i + 1}</div>
                <div style={s.topEmoji}>{p.emoji ?? '🍬'}</div>
                <div style={{ flex: 1 }}>
                  <div style={s.topNom}>{p.nom}</div>
                  <div style={s.topQty}>{p.qty} sold</div>
                </div>
                <div style={s.topMontant}>{p.total.toLocaleString()} F</div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Ventes récentes */}
      <p style={s.sectionTitle}>Recent sales</p>
      <div style={s.card}>
        {ventesRecentes.length === 0 ? (
          <div style={s.empty}>No sales yet today</div>
        ) : (
          ventesRecentes.map((v, i) => (
            <div key={v.id} style={{ ...s.saleRow, borderBottom: i < ventesRecentes.length - 1 ? '1px solid rgba(0,0,0,0.04)' : 'none' }}>
              <div style={s.saleEmoji}>{v.products?.emoji ?? '🍬'}</div>
              <div style={s.saleInfo}>
                <div style={s.saleName}>{v.products?.name ?? '—'}</div>
                <div style={s.saleMeta}>{v.clients?.name ?? 'Unknown'} · {formatDate(v.created_at)}</div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={s.saleAmount}>{v.amount?.toLocaleString()} F</div>
                <span style={v.type === 'cash' ? s.badgeCash : s.badgeDette}>
                  {v.type === 'cash' ? 'Paid' : 'Credit'}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

const s = {
  loading: { color: '#999', fontSize: '14px', paddingTop: '20px' },
  kpiAccent: { background: '#1A1A1A', borderRadius: '20px', padding: '22px 20px', marginBottom: '12px' },
  kpiAccentLabel: { fontSize: '11px', color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '8px' },
  kpiAccentValue: { fontFamily: "'DM Serif Display', serif", fontSize: '32px', color: 'white', letterSpacing: '-0.5px' },
  kpiAccentSub: { fontSize: '12px', color: 'rgba(255,255,255,0.4)', marginTop: '6px' },
  kpiGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '24px' },
  kpiCard: { background: 'white', borderRadius: '16px', padding: '14px 16px', border: '1px solid rgba(0,0,0,0.05)', boxShadow: '0 2px 12px rgba(0,0,0,0.04)' },
  kpiLabel: { fontSize: '11px', color: '#999', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '6px' },
  kpiValue: { fontFamily: "'DM Serif Display', serif", fontSize: '20px', color: '#1A1A1A' },
  kpiSub: { fontSize: '11px', color: '#BBB', marginTop: '3px' },
  sectionTitle: { fontFamily: "'DM Serif Display', serif", fontSize: '16px', color: '#1A1A1A', marginBottom: '12px' },
  card: { background: 'white', borderRadius: '18px', border: '1px solid rgba(0,0,0,0.05)', boxShadow: '0 2px 12px rgba(0,0,0,0.04)', overflow: 'hidden', marginBottom: '20px' },
  empty: { padding: '24px', textAlign: 'center', color: '#BBB', fontSize: '14px' },
  topRow: { display: 'flex', alignItems: 'center', padding: '12px 16px', gap: '10px' },
  topRank: { fontSize: '12px', fontWeight: '700', color: '#CCC', width: '20px', flexShrink: 0 },
  topEmoji: { fontSize: '20px', width: '28px', flexShrink: 0 },
  topNom: { fontSize: '13.5px', fontWeight: '500', color: '#1A1A1A' },
  topQty: { fontSize: '11px', color: '#BBB', marginTop: '1px' },
  topMontant: { fontFamily: "'DM Serif Display', serif", fontSize: '15px', color: '#1A1A1A', flexShrink: 0 },
  saleRow: { display: 'flex', alignItems: 'center', padding: '12px 16px', gap: '12px' },
  saleEmoji: { width: '34px', height: '34px', borderRadius: '9px', background: '#F5F5F5', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px', flexShrink: 0 },
  saleInfo: { flex: 1, minWidth: 0 },
  saleName: { fontSize: '13px', fontWeight: '500', color: '#1A1A1A', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  saleMeta: { fontSize: '11px', color: '#BBB', marginTop: '1px' },
  saleAmount: { fontSize: '13px', fontWeight: '600', color: '#1A1A1A' },
  badgeCash: { display: 'inline-block', padding: '2px 7px', borderRadius: '100px', fontSize: '10px', fontWeight: '500', background: '#E8F5EC', color: '#2E7D42' },
  badgeDette: { display: 'inline-block', padding: '2px 7px', borderRadius: '100px', fontSize: '10px', fontWeight: '500', background: '#FFF0E8', color: '#C45000' },
}
