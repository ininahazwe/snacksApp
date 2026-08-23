import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { formatPrice, round2 } from '../lib/format'

const PERIODS = [
  { id: 'today', label: 'Today' },
  { id: 'week',  label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'total', label: 'Total' },
  { id: 'custom', label: 'Custom' },
]

const PERIOD_KPI_LABEL = {
  today: "Today's revenue",
  week: "This week's revenue",
  month: "This month's revenue",
  total: 'All-time revenue',
  custom: 'Selected period revenue',
}

const PERIOD_SECTION_LABEL = {
  today: 'today',
  week: 'this week',
  month: 'this month',
  total: 'all time',
  custom: 'selected period',
}

// Bornes de dates pour la période choisie. `start: null` signifie "depuis le
// début" (utilisé pour 'total') : on ne filtre alors pas sur created_at.
function getPeriodRange(period, customStart, customEnd) {
  const now = new Date()

  if (period === 'today') {
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    return { start, end: now }
  }
  if (period === 'week') {
    const start = new Date(now)
    start.setDate(now.getDate() - now.getDay() + 1) // lundi de la semaine en cours
    start.setHours(0, 0, 0, 0)
    return { start, end: now }
  }
  if (period === 'month') {
    return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: now }
  }
  if (period === 'custom') {
    if (!customStart || !customEnd) return { start: null, end: now, invalid: true }
    const start = new Date(customStart)
    start.setHours(0, 0, 0, 0)
    const end = new Date(customEnd)
    end.setHours(23, 59, 59, 999)
    return { start, end }
  }
  // 'total' : pas de borne basse, on remonte à la toute première vente
  return { start: null, end: now }
}

// Construit les points du graphique d'évolution du revenu (ventes cash
// uniquement, cohérent avec le KPI principal). La granularité s'adapte à
// l'étendue de la période : heure pour un jour, jour pour <=60 jours,
// sinon mois — pour ne jamais afficher un graphique illisible.
function buildChartData(sales, start, end) {
  const cashSales = sales.filter(s => s.type === 'cash')
  const effectiveStart = start ?? (
      sales.length
          ? new Date(Math.min(...sales.map(s => new Date(s.created_at).getTime())))
          : new Date(end.getTime() - 6 * 24 * 60 * 60 * 1000)
  )

  const spanDays = Math.max((end - effectiveStart) / (1000 * 60 * 60 * 24), 0)
  const granularity = spanDays <= 1.5 ? 'hour' : spanDays <= 60 ? 'day' : 'month'

  const keyFor = (d) => {
    if (granularity === 'hour') return `${d.toISOString().slice(0, 13)}`
    if (granularity === 'month') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    return d.toISOString().slice(0, 10)
  }
  const labelFor = (d) => {
    if (granularity === 'hour') return d.toLocaleTimeString('en', { hour: 'numeric' })
    if (granularity === 'month') return d.toLocaleDateString('en', { month: 'short', year: '2-digit' })
    return d.toLocaleDateString('en', { day: '2-digit', month: 'short' })
  }

  const buckets = new Map()
  const cursor = new Date(effectiveStart)
  let guard = 0
  while (cursor <= end && guard < 400) {
    const key = keyFor(cursor)
    if (!buckets.has(key)) buckets.set(key, { key, label: labelFor(cursor), value: 0 })
    if (granularity === 'hour') cursor.setHours(cursor.getHours() + 1)
    else if (granularity === 'month') cursor.setMonth(cursor.getMonth() + 1)
    else cursor.setDate(cursor.getDate() + 1)
    guard += 1
  }

  cashSales.forEach(s => {
    const key = keyFor(new Date(s.created_at))
    if (buckets.has(key)) buckets.get(key).value += s.amount
  })

  // Ne jamais afficher plus de 30 barres : on garde les plus récentes pour
  // rester lisible même sur "Total" avec un long historique.
  const points = Array.from(buckets.values())
  return points.length > 30 ? points.slice(points.length - 30) : points
}

// Petit graphique en barres, sans dépendance externe : cohérent avec le
// reste de l'app (SVG + styles inline). <title> donne le détail au survol.
function RevenueChart({ data }) {
  if (data.length === 0) return null
  const max = Math.max(...data.map(d => d.value), 1)
  const barWidth = 100 / data.length

  return (
      <div style={s.chartCard}>
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" style={s.chartSvg}>
          {data.map((d, i) => {
            const h = max > 0 ? (d.value / max) * 34 : 0
            return (
                <rect
                    key={d.key}
                    x={i * barWidth + barWidth * 0.18}
                    y={40 - h - 1}
                    width={Math.max(barWidth * 0.64, 0.5)}
                    height={h}
                    rx="0.5"
                    fill={d.value > 0 ? '#1A1A1A' : '#EEE'}
                >
                  <title>{d.label} · {d.value.toLocaleString()} GH₵</title>
                </rect>
            )
          })}
        </svg>
        <div style={s.chartLabels}>
          <span>{data[0]?.label}</span>
          <span>{data[data.length - 1]?.label}</span>
        </div>
      </div>
  )
}

export default function Dashboard({ onProductTap }) {
  const [period, setPeriod] = useState('today')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')

  const [stats, setStats] = useState({ revenue: 0, txCount: 0, dettes: 0, stockBas: 0, panieMoyen: 0, cashCount: 0, detteCount: 0 })
  const [chartData, setChartData] = useState([])
  const [ventesRecentes, setVentesRecentes] = useState([])
  const [topProduits, setTopProduits] = useState([])
  const [topClients, setTopClients] = useState([])
  const [stockCritique, setStockCritique] = useState([])
  const [clientsDebiteurs, setClientsDebiteurs] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Pas de fetch tant qu'une période "Custom" incomplète est sélectionnée
    if (period === 'custom' && (!customStart || !customEnd)) return
    fetchDashboard()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, customStart, customEnd])

  const fetchDashboard = async () => {
    setLoading(true)
    const { start, end } = getPeriodRange(period, customStart, customEnd)

    // Toutes les requêtes sur `sales` excluent les ventes annulées
    // (cancelled_at IS NULL) : elles restent en base pour l'audit mais ne
    // doivent pas polluer le chiffre d'affaires ni les classements.
    let periodQuery = supabase
        .from('sales')
        .select('amount, type, product_id, qty, client_id, created_at, products(name,emoji)')
        .lte('created_at', end.toISOString())
        .is('cancelled_at', null)
    if (start) periodQuery = periodQuery.gte('created_at', start.toISOString())

    const [{ data: periodSales }, { data: clientsData }, { data: stocksData }, { data: recentes }, { data: stockDetails }] = await Promise.all([
      periodQuery,
      supabase.from('clients').select('id, debt, name'),
      supabase.from('products').select('id, stock, name, emoji').lt('stock', 10),
      supabase.from('sales').select('id, amount, type, created_at, original_amount, discount_reason, products(name,emoji), clients(name)').is('cancelled_at', null).order('created_at', { ascending: false }).limit(5),
      supabase.from('products').select('id, stock, name, emoji').order('stock', { ascending: true }).limit(10),
    ])

    const activeSales = periodSales ?? []
    const cashSales = activeSales.filter(s => s.type === 'cash')

    // Top produits de la période
    const compteur = {}
    activeSales.forEach(v => {
      if (!v.product_id) return
      if (!compteur[v.product_id]) compteur[v.product_id] = { nom: v.products?.name, emoji: v.products?.emoji, total: 0, qty: 0 }
      compteur[v.product_id].total += v.amount
      compteur[v.product_id].qty += v.qty
    })
    const top5Produits = Object.values(compteur).sort((a, b) => b.total - a.total).slice(0, 5)

    // Top clients de la période
    const clientsCompteur = {}
    activeSales.forEach(v => {
      if (!v.client_id) return
      if (!clientsCompteur[v.client_id]) {
        const clientName = clientsData?.find(c => c.id === v.client_id)?.name ?? 'Unknown'
        clientsCompteur[v.client_id] = { nom: clientName, total: 0, nb: 0 }
      }
      clientsCompteur[v.client_id].total += v.amount
      clientsCompteur[v.client_id].nb += 1
    })
    const top5Clients = Object.values(clientsCompteur).sort((a, b) => b.total - a.total).slice(0, 5)

    // Clients débiteurs (dette > 0) — indépendant de la période choisie
    const debiteurs = clientsData?.filter(c => c.debt > 0).sort((a, b) => b.debt - a.debt).slice(0, 5) ?? []

    const cashCount = cashSales.length
    const detteCount = activeSales.filter(s => s.type === 'dette').length

    const totalAmount = activeSales.reduce((sum, s) => sum + s.amount, 0)
    const panieMoyen = activeSales.length > 0 ? round2(totalAmount / activeSales.length) : 0

    setStats({
      revenue:  cashSales.reduce((sum, s) => sum + s.amount, 0),
      txCount:  activeSales.length,
      dettes:   clientsData?.reduce((sum, c) => sum + (c.debt ?? 0), 0) ?? 0,
      stockBas: stocksData?.length ?? 0,
      panieMoyen,
      cashCount,
      detteCount,
    })
    setChartData(buildChartData(activeSales, start, end))
    setVentesRecentes(recentes ?? [])
    setTopProduits(top5Produits)
    setTopClients(top5Clients)
    setStockCritique(stockDetails ?? [])
    setClientsDebiteurs(debiteurs)
    setLoading(false)
  }

  const formatDate = (iso) => new Date(iso).toLocaleDateString('en', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

  const periodLabel = PERIOD_KPI_LABEL[period]
  const sectionLabel = PERIOD_SECTION_LABEL[period]

  if (loading) return <div style={s.loading}>Loading…</div>

  return (
      <div style={{ fontFamily: "'DM Sans', sans-serif" }}>

        {/* Sélecteur de période */}
        <div style={s.periodRow}>
          {PERIODS.map(p => (
              <button
                  key={p.id}
                  onClick={() => setPeriod(p.id)}
                  style={{ ...s.periodBtn, ...(period === p.id ? s.periodBtnActive : {}) }}
              >
                {p.label}
              </button>
          ))}
        </div>

        {/* Choix libre de dates */}
        {period === 'custom' && (
            <div style={s.customRow}>
              <div style={{ flex: 1 }}>
                <label style={s.customLabel}>From</label>
                <input type="date" value={customStart} onChange={e => setCustomStart(e.target.value)} style={s.customInput} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={s.customLabel}>To</label>
                <input type="date" value={customEnd} onChange={e => setCustomEnd(e.target.value)} style={s.customInput} />
              </div>
            </div>
        )}

        {/* KPI principal */}
        <div style={s.kpiAccent}>
          <div style={s.kpiAccentLabel}>{periodLabel}</div>
          <div style={s.kpiAccentValue}>{stats.revenue.toLocaleString()} <span style={{ fontSize: 18 }}>GH₵</span></div>
          <div style={s.kpiAccentSub}>{stats.txCount} transaction{stats.txCount !== 1 ? 's' : ''}</div>
        </div>

        {/* Graphique d'évolution du revenu sur la période */}
        <RevenueChart data={chartData} />

        {/* KPIs secondaires — indépendants de la période */}
        <div style={s.kpiGrid}>
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

        {/* Row 2 KPIs: Ratio Cash/Dette + Panier moyen — pour la période choisie */}
        <div style={s.kpiGrid}>
          <div style={s.kpiCard}>
            <div style={s.kpiLabel}>Cash vs Credit</div>
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

        {/* Top produits */}
        {topProduits.length > 0 && (
            <>
              <p style={s.sectionTitle}>🔥 Top 5 products · {sectionLabel}</p>
              <div style={s.card}>
                {topProduits.map((p, i) => (
                    <div key={p.nom ?? i} style={{ ...s.topRow, borderBottom: i < topProduits.length - 1 ? '1px solid rgba(0,0,0,0.04)' : 'none' }}>
                      <div style={s.topRank}>#{i + 1}</div>
                      <div style={s.topEmoji}>{p.emoji ?? '🍬'}</div>
                      <div style={{ flex: 1 }}>
                        <div style={s.topNom}>{p.nom}</div>
                        <div style={s.topQty}>{p.qty} sold · {p.total.toLocaleString()} GH₵</div>
                      </div>
                    </div>
                ))}
              </div>
            </>
        )}

        {/* Top clients */}
        {topClients.length > 0 && (
            <>
              <p style={s.sectionTitle}>👥 Top 5 clients · {sectionLabel}</p>
              <div style={s.card}>
                {topClients.map((c, i) => (
                    <div key={c.nom ?? i} style={{ ...s.topRow, borderBottom: i < topClients.length - 1 ? '1px solid rgba(0,0,0,0.04)' : 'none' }}>
                      <div style={s.topRank}>#{i + 1}</div>
                      <div style={s.topEmoji}>👤</div>
                      <div style={{ flex: 1 }}>
                        <div style={s.topNom}>{c.nom}</div>
                        <div style={s.topQty}>{c.nb} transaction{c.nb !== 1 ? 's' : ''}</div>
                      </div>
                      <div style={s.topMontant}>{c.total.toLocaleString()} GH₵</div>
                    </div>
                ))}
              </div>
            </>
        )}

        {/* Stock critique */}
        {stockCritique.length > 0 && (
            <>
              <p style={s.sectionTitle}>⚠️ Low stock · Alert</p>
              <div style={s.card}>
                {stockCritique.map((p, i) => (
                    <div key={p.id} style={{ ...s.topRow, borderBottom: i < stockCritique.length - 1 ? '1px solid rgba(0,0,0,0.04)' : 'none', backgroundColor: i % 2 === 0 ? 'rgba(196, 80, 0, 0.02)' : 'transparent' }}>
                      <div style={{ ...s.topEmoji, fontSize: '16px' }}>{p.emoji ?? '🍬'}</div>
                      <div style={{ flex: 1 }}>
                        <div style={s.topNom}>{p.name}</div>
                        <div style={{ ...s.topQty, color: '#C45000', fontWeight: '500' }}>Stock: {p.stock} unit{p.stock !== 1 ? 's' : ''}</div>
                      </div>
                    </div>
                ))}
              </div>
            </>
        )}

        {/* Clients débiteurs */}
        {clientsDebiteurs.length > 0 && (
            <>
              <p style={s.sectionTitle}>💳 Clients with debt</p>
              <div style={s.card}>
                {clientsDebiteurs.map((c, i) => (
                    <div key={c.id} style={{ ...s.topRow, borderBottom: i < clientsDebiteurs.length - 1 ? '1px solid rgba(0,0,0,0.04)' : 'none' }}>
                      <div style={s.topEmoji}>👤</div>
                      <div style={{ flex: 1 }}>
                        <div style={s.topNom}>{c.name}</div>
                        <div style={s.topQty}>Outstanding balance</div>
                      </div>
                      <div style={{ ...s.topMontant, color: '#C45000', fontWeight: '600' }}>{c.debt.toLocaleString()} GH₵</div>
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
                      {v.original_amount != null && (
                          <div style={{ fontSize: '10px', color: '#C45000', marginTop: '1px' }}>
                            🏷️ Discounted{v.discount_reason ? ` — ${v.discount_reason}` : ''}
                          </div>
                      )}
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      {v.original_amount != null && (
                          <div style={{ fontSize: '10px', color: '#BBB', textDecoration: 'line-through' }}>
                            {v.original_amount.toLocaleString()} GH₵
                          </div>
                      )}
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
  periodRow: { display: 'flex', gap: '6px', marginBottom: '16px', background: '#F0F0F0', padding: '4px', borderRadius: '12px' },
  periodBtn: { flex: 1, padding: '8px 6px', borderRadius: '9px', border: 'none', background: 'transparent', fontSize: '12.5px', fontWeight: '500', color: '#999', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  periodBtnActive: { background: 'white', color: '#1A1A1A', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' },
  customRow: { display: 'flex', gap: '12px', marginBottom: '16px' },
  customLabel: { fontSize: '11px', color: '#999', textTransform: 'uppercase', letterSpacing: '0.6px', display: 'block', marginBottom: '6px' },
  customInput: { width: '100%', padding: '10px 12px', borderRadius: '10px', border: '1.5px solid #EBEBEB', fontSize: '13px', fontFamily: "'DM Sans', sans-serif", boxSizing: 'border-box' },
  kpiAccent: { background: '#1A1A1A', borderRadius: '20px', padding: '22px 20px', marginBottom: '12px' },
  kpiAccentLabel: { fontSize: '11px', color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '8px' },
  kpiAccentValue: { fontFamily: "'DM Serif Display', serif", fontSize: '32px', color: 'white', letterSpacing: '-0.5px' },
  kpiAccentSub: { fontSize: '12px', color: 'rgba(255,255,255,0.4)', marginTop: '6px' },
  chartCard: { background: 'white', borderRadius: '16px', padding: '14px 16px 10px', border: '1px solid rgba(0,0,0,0.05)', boxShadow: '0 2px 12px rgba(0,0,0,0.04)', marginBottom: '20px' },
  chartSvg: { width: '100%', height: '76px', display: 'block' },
  chartLabels: { display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#BBB', marginTop: '4px' },
  kpiGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '16px' },
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
