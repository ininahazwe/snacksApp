import { useAuth } from '../context/AuthContext'

// Affiche le contenu uniquement si l'utilisateur a le rôle requis
//   requireGerant → manager ou admin
//   requireAdmin  → admin uniquement
// Sinon affiche un écran "Access restricted"
// (Confort d'affichage uniquement : la vraie protection est dans les règles RLS.)
export default function RoleGuard({ requireGerant, requireAdmin, children, fallback }) {
  const { estGerant, estAdmin, loading } = useAuth()

  if (loading) return null

  const denied = (requireAdmin && !estAdmin) || (requireGerant && !estGerant)
  if (denied) {
    return fallback ?? (
      <div style={styles.container}>
        <div style={styles.icon}>🔒</div>
        <div style={styles.title}>Access restricted</div>
        <div style={styles.sub}>
          {requireAdmin
            ? 'This section is only available to administrators.'
            : 'This section is only available to managers.'}
        </div>
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
