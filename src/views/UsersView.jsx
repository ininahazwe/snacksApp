import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

const ROLES = ['gerant', 'vendeur']

export default function UsersView() {
  const { user: currentUser } = useAuth()
  const [users, setUsers]         = useState([])
  const [loading, setLoading]     = useState(true)
  const [showAdd, setShowAdd]     = useState(false)
  const [newRole, setNewRole]     = useState('vendeur')
  const [updatingId, setUpdatingId] = useState(null)

  useEffect(() => { fetchUsers() }, [])

  const fetchUsers = async () => {
    // Utilise la vue users_view créée dans le SQL
    const { data, error } = await supabase
        .from('users_view')
        .select('*')
        .order('created_at', { ascending: false })

    if (error) {
      // Fallback : si la vue n'existe pas encore, afficher un message
      console.error('users_view inaccessible:', error)
      setUsers([])
    } else {
      setUsers(data ?? [])
    }
    setLoading(false)
  }

  const changerRole = async (userId, nouveauRole) => {
    setUpdatingId(userId)
    // Supabase Admin API via edge function ou service role
    // Pour l'instant on utilise la fonction RPC qu'on va créer
    const { error } = await supabase.rpc('update_user_role', {
      target_user_id: userId,
      new_role: nouveauRole,
    })
    if (!error) {
      setUsers(us => us.map(u => u.id === userId ? { ...u, role: nouveauRole } : u))
    } else {
      alert('Could not update role. Make sure the SQL function is installed.')
    }
    setUpdatingId(null)
  }



  const formatDate = (iso) => iso ? new Date(iso).toLocaleDateString('en', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'
  const formatLastLogin = (iso) => iso ? new Date(iso).toLocaleDateString('en', { day: '2-digit', month: 'short' }) : 'Never'

  if (loading) return <div style={s.loading}>Loading…</div>

  return (
      <div style={{ fontFamily: "'DM Sans', sans-serif" }}>
        <div style={s.headerRow}>
          <p style={s.titre}>Team</p>
          <button style={s.addBtn} onClick={() => setShowAdd(true)}>+ Add user</button>
        </div>

        <div style={s.kpiRow}>
          <div style={s.kpiCard}>
            <div style={s.kpiLabel}>Total users</div>
            <div style={s.kpiValue}>{users.length}</div>
          </div>
          <div style={s.kpiCard}>
            <div style={s.kpiLabel}>Managers</div>
            <div style={s.kpiValue}>{users.filter(u => u.role === 'gerant').length}</div>
          </div>
        </div>

        {users.length === 0 ? (
            <div style={s.empty}>
              <div style={{ fontSize: '32px', marginBottom: '12px' }}>👤</div>
              No users found — make sure to run supabase-migration-phase5.sql
            </div>
        ) : (
            <div style={s.card}>
              {users.map((u, i) => (
                  <div key={u.id} style={{ ...s.userRow, borderBottom: i < users.length - 1 ? '1px solid rgba(0,0,0,0.04)' : 'none' }}>
                    <div style={s.avatar}>{u.email?.charAt(0).toUpperCase()}</div>
                    <div style={s.userInfo}>
                      <div style={s.userEmail}>
                        {u.email}
                        {u.id === currentUser?.id && <span style={s.youBadge}>you</span>}
                      </div>
                      <div style={s.userMeta}>Joined {formatDate(u.created_at)} · Last login {formatLastLogin(u.last_sign_in_at)}</div>
                    </div>
                    {/* Sélecteur de rôle */}
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      {updatingId === u.id ? (
                          <div style={s.updating}>…</div>
                      ) : (
                          <select
                              style={{ ...s.roleSelect, color: u.role === 'gerant' ? '#1A1A1A' : '#666' }}
                              value={u.role ?? 'vendeur'}
                              onChange={e => changerRole(u.id, e.target.value)}
                              disabled={u.id === currentUser?.id} // on ne peut pas changer son propre rôle
                          >
                            <option value="gerant">👑 Manager</option>
                            <option value="vendeur">🏪 Cashier</option>
                          </select>
                      )}
                    </div>
                  </div>
              ))}
            </div>
        )}

        {/* Note d'installation SQL */}
        <div style={s.sqlNote}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          Run <code style={s.code}>supabase-migration-phase5.sql</code> and <code style={s.code}>supabase-rpc-roles.sql</code> in Supabase SQL Editor to enable this view.
        </div>

        {/* Modal instructions ajout utilisateur */}
        {showAdd && (
            <div style={s.overlay} onClick={e => { if (e.target === e.currentTarget) setShowAdd(false) }}>
              <div style={s.modal}>
                <div style={s.handle} />
                <div style={s.modalHeader}>
                  <div style={s.modalTitre}>Add a user</div>
                  <button style={s.cancelBtn} onClick={() => setShowAdd(false)}>Close</button>
                </div>

                <div style={s.instructionBox}>
                  <div style={s.instructionStep}>
                    <div style={s.stepNum}>1</div>
                    <div>Go to your <strong>Supabase dashboard</strong> → Authentication → Users → <strong>Add user</strong></div>
                  </div>
                  <div style={s.instructionStep}>
                    <div style={s.stepNum}>2</div>
                    <div>Enter the email and password of the new user</div>
                  </div>
                  <div style={s.instructionStep}>
                    <div style={s.stepNum}>3</div>
                    <div>Then set their role below using the <strong>SQL Editor</strong></div>
                  </div>
                </div>

                <div style={s.fieldGroup}>
                  <div style={s.fieldLabel}>Role to assign</div>
                  <div style={s.roleToggle}>
                    {ROLES.map(r => (
                        <div
                            key={r}
                            style={{ ...s.roleOption, borderColor: newRole === r ? '#1A1A1A' : '#EBEBEB', background: newRole === r ? '#1A1A1A' : 'white' }}
                            onClick={() => setNewRole(r)}
                        >
                          <div style={{ fontSize: '20px', marginBottom: '4px' }}>{r === 'gerant' ? '👑' : '🏪'}</div>
                          <div style={{ ...s.roleOptionLabel, color: newRole === r ? 'white' : '#1A1A1A' }}>
                            {r === 'gerant' ? 'Manager' : 'Cashier'}
                          </div>
                          <div style={{ ...s.roleOptionSub, color: newRole === r ? 'rgba(255,255,255,0.6)' : '#999' }}>
                            {r === 'gerant' ? 'Full access' : 'Sales only'}
                          </div>
                        </div>
                    ))}
                  </div>
                </div>

                <div style={s.sqlBlock}>
                  <div style={s.sqlBlockLabel}>SQL to run after creating the user</div>
                  <code style={s.sqlCode}>
                    {`UPDATE auth.users
SET raw_user_meta_data = raw_user_meta_data || '{"role": "${newRole}"}'::jsonb
WHERE email = 'email@example.com';`}
                  </code>
                </div>
              </div>
            </div>
        )}
      </div>
  )
}

const s = {
  loading: { color: '#999', fontSize: '14px', paddingTop: '20px' },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' },
  titre: { fontFamily: "'DM Serif Display', serif", fontSize: '18px', color: '#1A1A1A', margin: 0 },
  addBtn: { background: '#1A1A1A', color: 'white', border: 'none', borderRadius: '100px', padding: '8px 16px', fontSize: '13px', fontWeight: '500', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  kpiRow: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '20px' },
  kpiCard: { background: 'white', borderRadius: '16px', padding: '16px', border: '1px solid rgba(0,0,0,0.05)', boxShadow: '0 2px 12px rgba(0,0,0,0.04)' },
  kpiLabel: { fontSize: '11px', color: '#999', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '6px' },
  kpiValue: { fontFamily: "'DM Serif Display', serif", fontSize: '22px', color: '#1A1A1A' },
  empty: { textAlign: 'center', padding: '32px 24px', color: '#BBB', fontSize: '13px', lineHeight: 1.6 },
  card: { background: 'white', borderRadius: '18px', border: '1px solid rgba(0,0,0,0.05)', boxShadow: '0 2px 12px rgba(0,0,0,0.04)', overflow: 'hidden', marginBottom: '16px' },
  userRow: { display: 'flex', alignItems: 'center', padding: '13px 16px', gap: '12px' },
  avatar: { width: '36px', height: '36px', borderRadius: '50%', background: 'linear-gradient(135deg,#E84B6E22,#F5C84222)', border: '1.5px solid rgba(0,0,0,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', fontWeight: '600', color: '#1A1A1A', flexShrink: 0 },
  userInfo: { flex: 1, minWidth: 0 },
  userEmail: { fontSize: '13px', fontWeight: '500', color: '#1A1A1A', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: '6px' },
  youBadge: { fontSize: '10px', background: '#F0F0F0', color: '#999', padding: '1px 6px', borderRadius: '100px', fontWeight: '400' },
  userMeta: { fontSize: '11px', color: '#BBB', marginTop: '2px' },
  roleSelect: { border: '1.5px solid #EBEBEB', borderRadius: '10px', padding: '6px 10px', fontSize: '12.5px', fontWeight: '500', background: 'white', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", outline: 'none' },
  updating: { fontSize: '13px', color: '#BBB', padding: '6px 10px' },
  sqlNote: { display: 'flex', alignItems: 'flex-start', gap: '8px', background: '#F9F9F9', borderRadius: '12px', padding: '12px 14px', fontSize: '12px', color: '#999', lineHeight: 1.5 },
  code: { background: '#EFEFEF', borderRadius: '4px', padding: '1px 5px', fontFamily: 'monospace', fontSize: '11px', color: '#555' },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(4px)', zIndex: 100, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
  modal: { background: 'white', borderRadius: '28px 28px 0 0', padding: '8px 24px 40px', width: '100%', maxWidth: '430px', fontFamily: "'DM Sans', sans-serif" },
  handle: { width: '36px', height: '4px', background: '#E0E0E0', borderRadius: '10px', margin: '10px auto 20px' },
  modalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' },
  modalTitre: { fontFamily: "'DM Serif Display', serif", fontSize: '20px', color: '#1A1A1A' },
  cancelBtn: { background: 'none', border: 'none', fontSize: '14px', fontWeight: '500', color: '#999', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  fieldGroup: { marginBottom: '16px' },
  fieldLabel: { fontSize: '11.5px', fontWeight: '600', color: '#999', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '8px' },
  input: { width: '100%', padding: '13px 16px', borderRadius: '12px', border: '1.5px solid #EBEBEB', fontSize: '15px', fontFamily: "'DM Sans', sans-serif", color: '#1A1A1A', outline: 'none', boxSizing: 'border-box' },
  roleToggle: { display: 'flex', gap: '10px' },
  roleOption: { flex: 1, padding: '14px 12px', borderRadius: '14px', border: '1.5px solid #EBEBEB', cursor: 'pointer', textAlign: 'center', transition: 'all 0.15s' },
  roleOptionLabel: { fontSize: '13.5px', fontWeight: '600' },
  roleOptionSub: { fontSize: '11px', marginTop: '2px' },
  errorMsg: { background: '#FFF0F0', color: '#C00', borderRadius: '10px', padding: '10px 14px', fontSize: '13px', marginBottom: '16px' },
  instructionBox: { background: '#F9F9F9', borderRadius: '14px', padding: '16px', marginBottom: '20px', display: 'flex', flexDirection: 'column', gap: '12px' },
  instructionStep: { display: 'flex', alignItems: 'flex-start', gap: '12px', fontSize: '13.5px', color: '#444', lineHeight: 1.5 },
  stepNum: { width: '22px', height: '22px', borderRadius: '50%', background: '#1A1A1A', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: '700', flexShrink: 0, marginTop: '1px' },
  sqlBlock: { background: '#1A1A1A', borderRadius: '14px', padding: '14px 16px', marginTop: '16px' },
  sqlBlockLabel: { fontSize: '11px', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '8px' },
  sqlCode: { fontFamily: 'monospace', fontSize: '12px', color: '#7EE787', whiteSpace: 'pre', display: 'block', lineHeight: 1.6 },
}
