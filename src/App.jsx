import { useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import RoleGuard from './components/RoleGuard'
import OfflineBanner from './components/OfflineBanner'
import LoginPage from './views/LoginPage'
import Dashboard from './views/Dashboard'
import VentesView from './views/VentesView'
import ProduitsView from './views/ProduitsView'
import ClientsView from './views/ClientsView'
import StocksView from './views/StocksView'
import UsersView from './views/UsersView'
import BarcodeScanner from './components/BarcodeScanner'
import SaleModal from './components/SaleModal'
import NewProductModal from './components/NewProductModal'
import Toast from './components/Toast'
import { supabase } from './lib/supabase'

// Navigation : vendeur voit seulement Sales + Products
// Gérant voit tout
const NAV_ITEMS = [
  {
    path: '/', label: 'Dashboard', gerantOnly: true,
    icon: (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>),
  },
  {
    path: '/ventes', label: 'Sales', gerantOnly: false,
    icon: (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>),
  },
  {
    path: '/produits', label: 'Products', gerantOnly: false,
    icon: (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>),
  },
  {
    path: '/clients', label: 'Customers', gerantOnly: true,
    icon: (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>),
  },
  {
    path: '/stocks', label: 'Inventory', gerantOnly: true,
    icon: (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>),
  },
  {
    path: '/team', label: 'Team', gerantOnly: true,
    icon: (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>),
  },
]

function AppLayout() {
  const location  = useLocation()
  const navigate  = useNavigate()
  const { logout, user, role, estGerant } = useAuth()

  const [showScanner,  setShowScanner]  = useState(false)
  const [saleProduct,  setSaleProduct]  = useState(null)
  const [newBarcode,   setNewBarcode]   = useState(null)
  const [toast,        setToast]        = useState(null)
  const [scanPulse,    setScanPulse]    = useState(false)

  const showToast = (msg) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  const handleBarcodeDetected = async (barcode) => {
    setShowScanner(false)
    setScanPulse(true)
    setTimeout(() => setScanPulse(false), 600)
    const { data } = await supabase.from('products').select('*').eq('barcode', barcode).single()
    if (data) setSaleProduct(data)
    else setNewBarcode(barcode)
  }

  const handleProductTap    = (product) => setSaleProduct(product)
  const handleProductCreated = (product) => { setNewBarcode(null); showToast(`✓ "${product.name}" created`); setSaleProduct(product) }
  const handleSaleSuccess   = (msg)     => { setSaleProduct(null); showToast(msg) }

  // Vendeur atterrit sur /ventes par défaut
  const defaultPath = estGerant ? '/' : '/ventes'

  // Items de nav filtrés selon le rôle
  const navItems = estGerant ? NAV_ITEMS : NAV_ITEMS.filter(i => !i.gerantOnly)

  return (
      <div style={st.app}>
        <OfflineBanner />

        {/* Header */}
        <div style={st.header}>
          <div style={st.headerTop}>
            <div>
              <div style={st.brand}>Douceurs<span style={st.brandDot} /></div>
              <div style={st.roleBadge}>
                {role === 'gerant' ? '👑 Manager' : '🏪 Cashier'} · {user?.email}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
              <button
                  style={{ ...st.scanBtn, ...(scanPulse ? { animation: 'scanPulse 0.6s ease' } : {}) }}
                  onClick={() => setShowScanner(true)}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 9V6a1 1 0 011-1h3M3 15v3a1 1 0 001 1h3M15 4h3a1 1 0 011 1v3M15 20h3a1 1 0 001-1v-3"/>
                  <line x1="8" y1="12" x2="8" y2="12.01"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="16" y1="12" x2="16" y2="12.01"/>
                </svg>
                Scan
              </button>
              <button style={st.logoutBtn} onClick={logout} title="Sign out">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
                  <polyline points="16 17 21 12 16 7"/>
                  <line x1="21" y1="12" x2="9" y2="12"/>
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* Pages */}
        <div style={st.content}>
          <Routes>
            <Route path="/" element={
              <RoleGuard requireGerant>
                <Dashboard onProductTap={handleProductTap} />
              </RoleGuard>
            } />
            <Route path="/ventes"  element={<VentesView />} />
            <Route path="/produits" element={<ProduitsView onProductTap={handleProductTap} />} />
            <Route path="/clients" element={
              <RoleGuard requireGerant>
                <ClientsView />
              </RoleGuard>
            } />
            <Route path="/stocks" element={
              <RoleGuard requireGerant>
                <StocksView />
              </RoleGuard>
            } />
            <Route path="/team" element={
              <RoleGuard requireGerant>
                <UsersView />
              </RoleGuard>
            } />
            {/* Redirection par défaut selon le rôle */}
            <Route path="*" element={<Navigate to={defaultPath} replace />} />
          </Routes>
        </div>

        {/* Bottom nav (filtrée par rôle) */}
        <nav style={st.bottomNav}>
          {navItems.map(item => {
            const active = location.pathname === item.path
            return (
                <button key={item.path} style={{ ...st.navItem, color: active ? '#1A1A1A' : '#BBB' }} onClick={() => navigate(item.path)}>
                  {item.icon}
                  <span style={st.navLabel}>{item.label}</span>
                  {active && <span style={st.navDot} />}
                </button>
            )
          })}
        </nav>

        {/* Modals globaux */}
        {showScanner  && <BarcodeScanner onDetected={handleBarcodeDetected} onClose={() => setShowScanner(false)} />}
        {newBarcode   && <NewProductModal barcode={newBarcode} onClose={() => setNewBarcode(null)} onCreated={handleProductCreated} />}
        {saleProduct  && <SaleModal product={saleProduct} onClose={() => setSaleProduct(null)} onSuccess={handleSaleSuccess} />}
        <Toast message={toast} />

        <style>{`
        @keyframes scanPulse { 0%{box-shadow:0 0 0 0 rgba(232,75,110,0.5)} 70%{box-shadow:0 0 0 14px rgba(232,75,110,0)} 100%{box-shadow:0 0 0 0 rgba(232,75,110,0)} }
        @keyframes overlayIn { from{opacity:0} to{opacity:1} }
        @keyframes modalUp   { from{transform:translateY(100%);opacity:0} to{transform:translateY(0);opacity:1} }
      `}</style>
      </div>
  )
}

export default function App() {
  return (
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<PublicRoute><LoginPage /></PublicRoute>} />
            <Route path="/*"    element={<ProtectedRoute><AppLayout /></ProtectedRoute>} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
  )
}

function PublicRoute({ children }) {
  const { user, loading } = useAuth()
  if (loading) return null
  if (user) return <Navigate to="/" replace />
  return children
}

const st = {
  app:       { maxWidth:'430px', margin:'0 auto', minHeight:'100vh', background:'#F7F6F3', display:'flex', flexDirection:'column', fontFamily:"'DM Sans',sans-serif", position:'relative' },
  header:    { padding:'20px 24px 16px', background:'#F7F6F3', position:'sticky', top:0, zIndex:10, borderBottom:'1px solid rgba(0,0,0,0.06)' },
  headerTop: { display:'flex', alignItems:'center', justifyContent:'space-between' },
  brand:     { fontFamily:"'DM Serif Display',serif", fontSize:'22px', color:'#1A1A1A', letterSpacing:'-0.3px' },
  brandDot:  { display:'inline-block', width:'7px', height:'7px', background:'#E84B6E', borderRadius:'50%', marginLeft:'3px', verticalAlign:'middle', marginBottom:'3px' },
  roleBadge: { fontSize:'11px', color:'#BBB', marginTop:'2px' },
  scanBtn:   { display:'flex', alignItems:'center', gap:'8px', background:'#1A1A1A', color:'white', border:'none', borderRadius:'100px', padding:'10px 18px', fontFamily:"'DM Sans',sans-serif", fontSize:'13.5px', fontWeight:'500', cursor:'pointer', transition:'all 0.2s ease' },
  logoutBtn: { background:'none', border:'none', cursor:'pointer', color:'#BBB', padding:'6px', borderRadius:'8px', display:'flex', alignItems:'center' },
  content:   { flex:1, padding:'20px 24px 100px', overflowY:'auto' },
  bottomNav: { position:'fixed', bottom:0, left:'50%', transform:'translateX(-50%)', width:'100%', maxWidth:'430px', background:'rgba(247,246,243,0.92)', backdropFilter:'blur(16px)', borderTop:'1px solid rgba(0,0,0,0.07)', display:'flex', padding:'10px 8px 20px', zIndex:20 },
  navItem:   { flex:1, display:'flex', flexDirection:'column', alignItems:'center', gap:'4px', padding:'6px 4px', cursor:'pointer', background:'none', border:'none', borderRadius:'12px', transition:'color 0.2s ease', fontFamily:"'DM Sans',sans-serif" },
  navLabel:  { fontSize:'10px', fontWeight:'500' },
  navDot:    { width:'4px', height:'4px', borderRadius:'50%', background:'#E84B6E' },
}
