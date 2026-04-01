import { useAuth } from '../context/AuthContext'

// Affiche le contenu uniquement si l'utilisateur a le rôle requis
// Sinon affiche un écran "Access restricted"
export default function RoleGuard({ requireGerant, children, fallback }) {
  const { estGerant, loading } = useAuth()

  if (loading) return null

  if (requireGerant && !estGerant) {
    return fallback ?? (
      <div style={styles.container}>
        <div style={styles.icon}>🔒</div>
        <div style={styles.title}>Access restricted</div>
        <div style={styles.sub}>This section is only available to managers.</div>
      </div>
    )
  }

  return children
}

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '50vh',
    gap: '12px',
    fontFamily: "'DM Sans', sans-serif",
  },
  icon:  { fontSize: '40px' },
  title: { fontFamily: "'DM Serif Display', serif", fontSize: '22px', color: '#1A1A1A' },
  sub:   { fontSize: '14px', color: '#999', textAlign: 'center', maxWidth: '260px' },
}
