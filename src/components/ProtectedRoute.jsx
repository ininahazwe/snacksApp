import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

// Redirige vers /login si l'utilisateur n'est pas connecté
export default function ProtectedRoute({ children, requiredRole }) {
  const { user, role, loading } = useAuth()

  if (loading) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: "'DM Sans', sans-serif",
        color: '#999',
        fontSize: '14px',
        background: '#F7F6F3',
      }}>
        Chargement…
      </div>
    )
  }

  if (!user) return <Navigate to="/login" replace />

  // Si une route exige le rôle gérant
  if (requiredRole && role !== requiredRole) {
    return <Navigate to="/" replace />
  }

  return children
}
