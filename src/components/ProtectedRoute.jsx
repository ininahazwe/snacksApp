import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

const screen = {
  minHeight: '100vh',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '12px',
  padding: '24px',
  textAlign: 'center',
  fontFamily: "'DM Sans', sans-serif",
  color: '#999',
  fontSize: '14px',
  background: '#F7F6F3',
}

// Redirige vers /login si l'utilisateur n'est pas connecté ; bloque les comptes
// non activés par l'administrateur.
export default function ProtectedRoute({ children, requiredRole }) {
  const { user, role, status, loading, logout, refreshProfile } = useAuth()

  if (loading) {
    return <div style={screen}>Chargement…</div>
  }

  if (!user) return <Navigate to="/login" replace />

  if (status === 'pending') {
    return (
      <div style={screen}>
        <div style={{ fontSize: '40px' }}>⏳</div>
        <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: '22px', color: '#1A1A1A' }}>
          Account awaiting activation
        </div>
        <div style={{ maxWidth: '280px', lineHeight: 1.5 }}>
          Your account ({user.email}) has not been activated yet. Ask an administrator to activate it, then try again.
        </div>
        <div style={{ display: 'flex', gap: '10px', marginTop: '8px' }}>
          <button onClick={refreshProfile} style={btnPrimary}>Check again</button>
          <button onClick={logout} style={btnGhost}>Sign out</button>
        </div>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div style={screen}>
        <div style={{ fontSize: '40px' }}>📡</div>
        <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: '22px', color: '#1A1A1A' }}>
          Unable to load your profile
        </div>
        <div style={{ maxWidth: '280px', lineHeight: 1.5 }}>
          Check your connection and try again. The first sign-in on a device needs internet.
        </div>
        <div style={{ display: 'flex', gap: '10px', marginTop: '8px' }}>
          <button onClick={refreshProfile} style={btnPrimary}>Retry</button>
          <button onClick={logout} style={btnGhost}>Sign out</button>
        </div>
      </div>
    )
  }

  // Si une route exige un rôle précis
  if (requiredRole && role !== requiredRole) {
    return <Navigate to="/" replace />
  }

  return children
}

const btnPrimary = { background: '#1A1A1A', color: 'white', border: 'none', borderRadius: '100px', padding: '10px 18px', fontSize: '13px', fontWeight: 500, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }
const btnGhost   = { background: 'white', color: '#1A1A1A', border: '1.5px solid #EBEBEB', borderRadius: '100px', padding: '10px 18px', fontSize: '13px', fontWeight: 500, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }
