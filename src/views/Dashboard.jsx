import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { formatPrice, round2 } from '../lib/format'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'

export default function Dashboard({ onProductTap }) {
  const [stats, setStats] = useState({ today: 0, week: 0, month: 0, nbToday: 0, dettes: 0, stockBas: 0, panieMoyen: 0, cashCount: 0, detteCount: 0 })
  const [ventesRecentes, setVentesRecentes] = useState([])
  const [topProduits, setTopProduits] = useState([])
  const [topClients, setTopClients] = useState([])
  const [stockCritique, setStockCritique] = useState([])
  const [clientsDebiteurs, setClientsDebiteurs] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => { fetchDashboard() }, [])

  const fetchDashboard = async () => {
    const now = new Date()
    const today     = now.toISOString().split('T')[0]
    const lundiDernier = new Date(now); lundiDernier.setDate(now.getDate() - now.getDay() + 1); lundiDernier.setHours(0,0,0,0)
    const premierMois = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()

    // On exclut systématiquement les ventes annulées (cancelled_at) et les lignes
    // paiement/avoir (mouvements de solde client, pas des ventes) des statistiques —
    // sinon un remboursement de dette ou un avoir gonflait artificiellement le panier
    // moyen, le nombre de transactions et le classement des meilleurs clients.
    const [{ data: salesToday }, { data: salesWeek }, { data: salesMonth }, { data: clientsData }, { data: stocksData }, { data: recentes }, { data: stockDetails }] = await Promise.all([
      supabase.from('sales').select('amount, type').is('cancelled_at', null).in('type', ['cash', 'dette']).gte('created_at', `${today}T00:00:00`),
      supabase.from('sales').select('amount, type').is('cancelled_at', null).in('type', ['cash', 'dette']).gte('created_at', lundiDernier.toISOString()),
      supabase.from('sales').select('amount, type, product_id, qty, client_id, products(name,emoji)').is('cancelled_at', null).in('type', ['cash', 'dette']).gte('created_at', premierMois),
      supabase.from('clients').select('id, debt, name'),
      supabase.from('products').select('id, stock, name, emoji').lt('stock', 10),
      supabase.from('sales').select('amount, type, created_at, products(name,emoji), clients(name)').is('cancelled_at', null).in('type', ['cash', 'dette']).order('created_at', { ascending: false }).limit(5),
      supabase.from('products').select('id, stock, name, emoji').order('stock', { ascending: true }).limit(10),
    ])

    // Top produits du mois
    const compteur = {}
    salesMonth?.forEach(v => {
      if (!v.product_id) return
      if (!compteur[v.product_id]) compteur[v.product_id] = { nom: v.products?.name, emoji: v.products?.emoji, total: 0, qty: 0 }
      compteur[v.product_id].total += v.amount
      compteur[v.product_id].qty += v.qty
    })
    const top5Produits = Object.values(compteur).sort((a, b) => b.total - a.total).slice(0, 5)

    // Top clients du mois
    const clientsCompteur = {}
    salesMonth?.forEach(v => {
      if (!v.client_id) return
      if (!clientsCompteur[v.client_id]) {
        const clientName = clientsData?.find(c => c.id === v.client_id)?.name ?? 'Unknown'
        clientsCompteur[v.client_id] = { nom: clientName, total: 0, nb: 0 }
      }
      clientsCompteur[v.client_id].total += v.amount
      clientsCompteur[v.client_id].nb += 1
    })
    const top5Clients = Object.values(clientsCompteur).sort((a, b) => b.total - a.total).slice(0, 5)

    // Clients débiteurs (dette > 0)
    const debiteurs = clientsData?.filter(c => c.debt > 0).sort((a, b) => b.debt - a.debt).slice(0, 5) ?? []

    // Cash vs Dette
    const cashCount = salesToday?.filter(s => s.type === 'cash').length ?? 0
    const detteCount = salesToday?.filter(s => s.type === 'dette').length ?? 0

    // Panier moyen
    const totalAmount = salesToday?.reduce((sum, s) => sum + s.amount, 0) ?? 0
    const panieMoyen = salesToday && salesToday.length > 0 ? round2(totalAmount / salesToday.length) : 0

    setStats({
      today:    salesToday?.filter(s => s.type === 'cash').reduce((sum, s) => sum + s.amount, 0) ?? 0,
      week:     salesWeek?.filter(s => s.type === 'cash').reduce((sum, s) => sum + s.amount, 0) ?? 0,
      month:    salesMonth?.filter(s => s.type === 'cash').reduce((sum, s) => sum + s.amount, 0) ?? 0,
      nbToday:  salesToday?.length ?? 0,
      dettes:   clientsData?.reduce((sum, c) => sum + (c.debt ?? 0), 0) ?? 0,
      stockBas: stocksData?.length ?? 0,
      panieMoyen,
      cashCount,
      detteCount,
    })
    setVentesRecentes(recentes ?? [])
    setTopProduits(top5Produits)
    setTopClients(top5Clients)
    setStockCritique(stockDetails ?? [])
    setClientsDebiteurs(debiteurs)
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

        {/* Row 2 KPIs: Ratio Cash/Dette + Panier moyen */}
        <div style={s.kpiGrid}>
          <div style={s.kpiCard}>
            <div style={s.kpiLabel}>Today · Cash vs Credit</div>
            <div style={{ display: 'flex', gap: '12px', marginTop: '8px', alignItems: 'flex-end' }}>
              <div>
                <div style={{ ...s.kpiValue, color: '#2E7D42' }}>{stats.cashCount}</div>
                <div style={s.kpiSub}>paid</div>
              </div>
              <div style={{ fontSize: '12px', color: '#BBB' }}>/</div>
              <div>
                <div style={{ ...s.kpiValue, color: '#C45000' }}>{stats.detteCount}</div>
                <div style={s.kpiSub}>credit</div>
              </div>
            </div>
          </div>
          <div style={s.kpiCard}>
            <div style={s.kpiLabel}>Avg basket</div>
            <div style={s.kpiValue}>{stats.panieMoyen.toLocaleString()}</div>
            <div style={s.kpiSub}>GH₵ per sale</div>
          </div>
        </div>

        {/* Top Produits - BarChart Vertical FULL WIDTH */}
        {topProduits.length > 0 && (
            <div style={s.card}>
              <p style={s.sectionTitle}>🔥 Top products · this month</p>
              <ResponsiveContainer width="100%" height={320}>
                <BarChart
                    data={topProduits.map((p) => ({
                      name: p.nom,
                      emoji: p.emoji,
                      value: p.total,
                      qty: p.qty,
                    }))}
                    margin={{ top: 20, right: 30, left: 20, bottom: 80 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)" />
                  <XAxis
                      dataKey="name"
                      stroke="#999"
                      style={{ fontSize: '12px' }}
                      angle={-45}
                      textAnchor="end"
                      height={100}
                  />
                  <YAxis stroke="#999" style={{ fontSize: '11px' }} />
                  <Tooltip
                      contentStyle={{ background: '#1A1A1A', border: 'none', borderRadius: '8px', color: 'white', fontSize: '12px' }}
                      cursor={{ fill: 'rgba(0,0,0,0.05)' }}
                      formatter={(value) => value.toLocaleString() + ' GH₵'}
                  />
                  <Bar dataKey="value" fill="#5BAD72" radius={[8, 8, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
        )}

        {/* Top Clients - BarChart Vertical FULL WIDTH */}
        {topClients.length > 0 && (
            <div style={s.card}>
              <p style={s.sectionTitle}>👥 Top clients · this month</p>
              <ResponsiveContainer width="100%" height={320}>
                <BarChart
                    data={topClients.map((c) => ({
                      name: c.nom,
                      value: c.total,
                      nb: c.nb,
                    }))}
                    margin={{ top: 20, right: 30, left: 20, bottom: 80 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)" />
                  <XAxis
                      dataKey="name"
                      stroke="#999"
                      style={{ fontSize: '12px' }}
                      angle={-45}
                      textAnchor="end"
                      height={100}
                  />
                  <YAxis stroke="#999" style={{ fontSize: '11px' }} />
                  <Tooltip
                      contentStyle={{ background: '#1A1A1A', border: 'none', borderRadius: '8px', color: 'white', fontSize: '12px' }}
                      cursor={{ fill: 'rgba(0,0,0,0.05)' }}
                      formatter={(value) => value.toLocaleString() + ' GH₵'}
                  />
                  <Bar dataKey="value" fill="#E84B6E" radius={[8, 8, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
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
                      <div style={s.saleAmount}>{v.amount?.toLocaleString()} GH₵</div>
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
  kpiAccent: { background: '#1A1A1A', borderRadius: '24px', padding: '28px 24px', marginBottom: '20px', color: 'white' },
  kpiAccentLabel: { fontSize: '12px', color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '8px' },
  kpiAccentValue: { fontFamily: "'DM Serif Display', serif", fontSize: '40px', letterSpacing: '-1px', marginBottom: '4px' },
  kpiAccentSub: { fontSize: '13px', color: 'rgba(255,255,255,0.5)' },
  kpiGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '20px' },
  kpiCard: { background: 'white', borderRadius: '16px', padding: '16px', border: '1px solid rgba(0,0,0,0.05)', boxShadow: '0 2px 12px rgba(0,0,0,0.04)' },
  kpiLabel: { fontSize: '11px', color: '#999', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '6px' },
  kpiValue: { fontFamily: "'DM Serif Display', serif", fontSize: '22px', color: '#1A1A1A' },
  kpiSub: { fontSize: '11px', color: '#999', marginTop: '2px' },
  sectionTitle: { fontFamily: "'DM Serif Display', serif", fontSize: '16px', color: '#1A1A1A', marginBottom: '12px', marginTop: '0px' },
  card: { background: 'white', borderRadius: '18px', border: '1px solid rgba(0,0,0,0.05)', boxShadow: '0 2px 12px rgba(0,0,0,0.04)', overflow: 'hidden', padding: '16px', marginBottom: '20px' },
  saleRow: { display: 'flex', alignItems: 'center', padding: '12px 0', gap: '12px' },
  saleEmoji: { width: '34px', height: '34px', borderRadius: '9px', background: '#F5F5F5', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px', flexShrink: 0 },
  saleInfo: { flex: 1, minWidth: 0 },
  saleName: { fontSize: '13px', fontWeight: '500', color: '#1A1A1A', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  saleMeta: { fontSize: '11px', color: '#BBB', marginTop: '1px' },
  saleAmount: { fontSize: '13px', fontWeight: '600', color: '#1A1A1A' },
  badgeCash: { display: 'inline-block', padding: '2px 7px', borderRadius: '100px', fontSize: '10px', fontWeight: '500', background: '#E8F5EC', color: '#2E7D42', marginTop: '2px' },
  badgeDette: { display: 'inline-block', padding: '2px 7px', borderRadius: '100px', fontSize: '10px', fontWeight: '500', background: '#FFF0E8', color: '#C45000', marginTop: '2px' },
  empty: { textAlign: 'center', padding: '24px', color: '#BBB', fontSize: '14px' },
}