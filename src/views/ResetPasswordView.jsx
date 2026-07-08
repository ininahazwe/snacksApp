import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

// Règle de validation du nouveau mot de passe : 8 caractères min + 1 majuscule + 1 chiffre
const isPasswordValid = (pwd) => pwd.length >= 8 && /[A-Z]/.test(pwd) && /\d/.test(pwd)

export default function ResetPasswordView() {
  const navigate = useNavigate()

  const [ready, setReady]       = useState(false)   // session de récupération détectée
  const [linkError, setLinkError] = useState(null)  // lien invalide / expiré

  const [password, setPassword]   = useState('')
  const [confirm, setConfirm]     = useState('')
  const [error, setError]         = useState(null)
  const [loading, setLoading]     = useState(false)
  const [done, setDone]           = useState(false)

  useEffect(() => {
    // Supabase transforme le lien de l'email en session temporaire et émet
    // l'événement PASSWORD_RECOVERY. On l'écoute pour débloquer le formulaire.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') setReady(true)
    })

    // Si le lien est invalide ou expiré (>1h), Supabase ajoute des paramètres
    // d'erreur dans le hash de l'URL au lieu de créer une session.
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const err = hashParams.get('error') || hashParams.get('error_code')
    if (err) {
      setLinkError(
        hashParams.get('error_description')?.replace(/\+/g, ' ')
          || 'This link is invalid or has expired. Request a new one from the sign-in page.'
      )
    } else {
      // Filet de sécurité : si une session de récupération existe déjà au chargement
      supabase.auth.getSession().then(({ data: { session } }) => {
        if (session) setReady(true)
      })
    }

    return () => subscription.unsubscribe()
  }, [])

  const handleSubmit = async () => {
    if (!password || !confirm) return
    setError(null)

    if (!isPasswordValid(password)) {
      setError('Password must be at least 8 characters and include 1 uppercase letter and 1 number.')
      return
    }
    if (password !== confirm) {
      setError("Passwords don't match.")
      return
    }

    setLoading(true)
    try {
      const { error } = await supabase.auth.updateUser({ password })
      if (error) throw error

      // On déconnecte la session temporaire : l'utilisateur devra se
      // reconnecter avec son nouveau mot de passe.
      await supabase.auth.signOut()
      setDone(true)
      setTimeout(() => navigate('/login', { replace: true }), 2000)
    } catch (err) {
      setError('Could not update the password. Please try again.')
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
        <div style={styles.logoWrap}>
          <span style={styles.logoEmoji}>🍬</span>
        </div>
        <h1 style={styles.title}>New password</h1>

        {linkError && (
          <>
            <p style={styles.subtitle}>{linkError}</p>
            <button style={styles.btn} onClick={() => navigate('/login', { replace: true })}>
              Back to sign in
            </button>
          </>
        )}

        {!linkError && done && (
          <p style={styles.subtitle}>
            Password updated. Redirecting to sign in…
          </p>
        )}

        {!linkError && !done && !ready && (
          <p style={styles.subtitle}>Verifying link…</p>
        )}

        {!linkError && !done && ready && (
          <>
            <p style={styles.subtitle}>At least 8 characters, 1 uppercase letter and 1 number.</p>

            <div style={styles.fieldGroup}>
              <label style={styles.label}>New password</label>
              <input
                style={styles.input}
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={handleKeyDown}
                autoComplete="new-password"
                autoFocus
              />
            </div>

            <div style={styles.fieldGroup}>
              <label style={styles.label}>Confirm password</label>
              <input
                style={styles.input}
                type="password"
                placeholder="••••••••"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                onKeyDown={handleKeyDown}
                autoComplete="new-password"
              />
            </div>

            {error && <div style={styles.error}>{error}</div>}

            <button
              style={{ ...styles.btn, opacity: loading ? 0.7 : 1 }}
              onClick={handleSubmit}
              disabled={loading}
            >
              {loading ? 'Updating…' : 'Update password'}
            </button>
          </>
        )}
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
    fontSize: '26px',
    color: '#1A1A1A',
    letterSpacing: '-0.3px',
    marginBottom: '6px',
  },
  subtitle: {
    fontSize: '14px',
    color: '#999',
    marginBottom: '24px',
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
