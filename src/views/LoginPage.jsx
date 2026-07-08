import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'

export default function LoginPage() {
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  // Mode "mot de passe oublié"
  const [showForgot, setShowForgot] = useState(false)
  const [forgotEmail, setForgotEmail] = useState('')
  const [forgotSent, setForgotSent] = useState(false)
  const [forgotError, setForgotError] = useState(null)
  const [forgotLoading, setForgotLoading] = useState(false)

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

  const openForgot = () => {
    setForgotEmail(email)
    setForgotError(null)
    setForgotSent(false)
    setShowForgot(true)
  }

  const handleForgotSubmit = async () => {
    if (!forgotEmail) return
    setForgotError(null)
    setForgotLoading(true)
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(forgotEmail, {
        redirectTo: `${window.location.origin}/reset-password`,
      })
      if (error) throw error
      setForgotSent(true)
    } catch (err) {
      setForgotError('Could not send the email. Check the address.')
    } finally {
      setForgotLoading(false)
    }
  }

  const handleForgotKeyDown = (e) => {
    if (e.key === 'Enter') handleForgotSubmit()
  }

  if (showForgot) {
    return (
      <div style={styles.container}>
        <div style={styles.card}>
          <div style={styles.logoWrap}>
            <span style={styles.logoEmoji}>🍬</span>
          </div>
          <h1 style={styles.title}>Forgot password</h1>
          <p style={styles.subtitle}>
            {forgotSent
              ? 'Check your inbox.'
              : 'Get a password reset link by email (valid for 1 hour).'}
          </p>

          {!forgotSent && (
            <>
              <div style={styles.fieldGroup}>
                <label style={styles.label}>Email</label>
                <input
                  style={styles.input}
                  type="email"
                  placeholder="manager@douceurs.com"
                  value={forgotEmail}
                  onChange={e => setForgotEmail(e.target.value)}
                  onKeyDown={handleForgotKeyDown}
                  autoComplete="email"
                  autoFocus
                />
              </div>

              {forgotError && <div style={styles.error}>{forgotError}</div>}

              <button
                style={{ ...styles.btn, opacity: forgotLoading ? 0.7 : 1 }}
                onClick={handleForgotSubmit}
                disabled={forgotLoading}
              >
                {forgotLoading ? 'Sending…' : 'Send reset link'}
              </button>
            </>
          )}

          <button style={styles.linkBtn} onClick={() => setShowForgot(false)}>
            ← Back to sign in
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        {/* Logo */}
        <div style={styles.logoWrap}>
          <span style={styles.logoEmoji}>🍬</span>
        </div>
        <h1 style={styles.title}>Store</h1>
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
          <label style={styles.label}>Password</label>
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

        <button style={styles.linkBtn} onClick={openForgot}>
          Forgot password?
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
  linkBtn: {
    display: 'block',
    width: '100%',
    background: 'none',
    border: 'none',
    color: '#999',
    fontSize: '13px',
    fontFamily: "'DM Sans', sans-serif",
    textAlign: 'center',
    marginTop: '16px',
    cursor: 'pointer',
    padding: '4px',
  },
}
