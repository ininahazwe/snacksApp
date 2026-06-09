import { useState } from 'react'
import { useAuth } from '../context/AuthContext'

export default function LoginPage() {
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async () => {
    if (!email || !password) return
    setError(null)
    setLoading(true)
    try {
      await login(email, password)
    } catch (err) {
      setError('Incorrect email or password')
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleSubmit()
  }

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        {/* Logo */}
        <div style={styles.logoWrap}>
          <span style={styles.logoEmoji}>🍬</span>
        </div>
        <h1 style={styles.title}>Douceurs</h1>
        <p style={styles.subtitle}>Sign in to access the POS</p>

        {/* Form */}
        <div style={styles.fieldGroup}>
          <label style={styles.label}>Email</label>
          <input
            style={styles.input}
            type="email"
            placeholder="manager@douceurs.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
            onKeyDown={handleKeyDown}
            autoComplete="email"
          />
        </div>

        <div style={styles.fieldGroup}>
          <label style={styles.label}>Mot de passe</label>
          <input
            style={styles.input}
            type="password"
            placeholder="••••••••"
            value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={handleKeyDown}
            autoComplete="current-password"
          />
        </div>

        {error && <div style={styles.error}>{error}</div>}

        <button
          style={{ ...styles.btn, opacity: loading ? 0.7 : 1 }}
          onClick={handleSubmit}
          disabled={loading}
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </div>
    </div>
  )
}

const styles = {
  container: {
    minHeight: '100vh',
    background: '#F7F6F3',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
    fontFamily: "'DM Sans', sans-serif",
  },
  card: {
    background: 'white',
    borderRadius: '24px',
    padding: '36px 28px',
    width: '100%',
    maxWidth: '380px',
    boxShadow: '0 4px 32px rgba(0,0,0,0.07)',
    border: '1px solid rgba(0,0,0,0.05)',
  },
  logoWrap: {
    width: '60px',
    height: '60px',
    background: '#FFF5E6',
    borderRadius: '16px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '28px',
    marginBottom: '16px',
  },
  title: {
    fontFamily: "'DM Serif Display', serif",
    fontSize: '28px',
    color: '#1A1A1A',
    letterSpacing: '-0.3px',
    marginBottom: '6px',
  },
  subtitle: {
    fontSize: '14px',
    color: '#999',
    marginBottom: '28px',
  },
  fieldGroup: {
    marginBottom: '16px',
  },
  label: {
    display: 'block',
    fontSize: '12px',
    fontWeight: '600',
    color: '#999',
    textTransform: 'uppercase',
    letterSpacing: '0.6px',
    marginBottom: '8px',
  },
  input: {
    width: '100%',
    padding: '13px 16px',
    borderRadius: '12px',
    border: '1.5px solid #EBEBEB',
    fontSize: '15px',
    fontFamily: "'DM Sans', sans-serif",
    color: '#1A1A1A',
    background: 'white',
    outline: 'none',
    transition: 'border-color 0.15s',
    boxSizing: 'border-box',
  },
  error: {
    background: '#FFF0F0',
    color: '#C00',
    borderRadius: '10px',
    padding: '10px 14px',
    fontSize: '13px',
    marginBottom: '16px',
  },
  btn: {
    width: '100%',
    padding: '15px',
    background: '#1A1A1A',
    color: 'white',
    border: 'none',
    borderRadius: '14px',
    fontSize: '15px',
    fontWeight: '500',
    fontFamily: "'DM Sans', sans-serif",
    cursor: 'pointer',
    marginTop: '8px',
    transition: 'background 0.2s',
  },
}
