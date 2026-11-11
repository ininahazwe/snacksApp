import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

// Écran réservé à l'administrateur (route protégée + fonctions SQL list_team /
// set_user_role / set_user_active qui re-vérifient le rôle côté base).

const ROLE_META = {
  admin:   { icon: '🛡️', label: 'Admin',   sub: 'All rights + accounts' },
  manager: { icon: '👑', label: 'Manager', sub: 'Stock, sales, customers' },
  cashier: { icon: '🏪', label: 'Cashier', sub: 'Sells, sees own sales' },
}
const ROLES = ['admin', 'manager', 'cashier']

export default function UsersView() {
  const { user: currentUser } = useAuth()
  const [users, setUsers]           = useState([])
  const [loading, setLoading]       = useState(true)
  const [loadError, setLoadError]   = useState(null)
  const [showAdd, setShowAdd]       = useState(false)
  const [busyId, setBusyId]         = useState(null)
  const [actionError, setActionError] = useState(null)

  const fetchUsers = useCallback(async () => {
    const { data, error } = await supabase.rpc('list_team')
    if (error) {
      console.error('list_team:', error)
      setLoadError(error.message || 'Unable to load the team')
      setUsers([])
    } else {
      setLoadError(null)
      setUsers(data ?? [])
    }
    setLoading(false)
  }, [])

  useEffect(() => { fetchUsers() }, [fetchUsers])

  const changerRole = async (userId, nouveauRole) => {
    setBusyId(userId)
    setActionError(null)
    const { error } = await supabase.rpc('set_user_role', { target_user_id: userId, new_role: nouveauRole })
    if (error) setActionError(error.message || 'Unable to change the role')
    else setUsers(us => us.map(u => u.id === userId ? { ...u, role: nouveauRole } : u))
    setBusyId(null)
  }

  const changerActif = async (userId, actif) => {
    setBusyId(userId)
    setActionError(null)
    const { error } = await supabase.rpc('set_user_active', { target_user_id: userId, is_active: actif })
    if (error) setActionError(error.message || 'Unable to update the account')
    else setUsers(us => us.map(u => u.id === userId ? { ...u, active: actif } : u))
    setBusyId(null)
  }

  const formatDate = (iso) => iso ? new Date(iso).toLocaleDateString('en', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'
  const formatLastLogin = (iso) => iso ? new Date(iso).toLocaleDateString('en', { day: '2-digit', month: 'short' }) : 'Never'

  if (loading) return <div style={s.loading}>Loading…</div>

  const pending  = users.filter(u => !u.active)
  const managers = users.filter(u => u.active && (u.role === 'manager' || u.role === 'admin'))

  return (
      <div style={{ fontFamily: "'DM Sans', sans-serif" }}>
        <div style={s.headerRow}>
          <p style={s.titre}>Team</p>
          <button style={s.addBtn} onClick={() => setShowAdd(true)}>+ Add user</button>
        </div>

        <div style={{ ...s.kpiRow, gridTemplateColumns: '1fr 1fr 1fr' }}>
          <div style={s.kpiCard}>
            <div style={s.kpiLabel}>Active</div>
            <div style={s.kpiValue}>{users.length - pending.length}</div>
          </div>
          <div style={s.kpiCard}>
            <div style={s.kpiLabel}>Managers</div>
            <div style={s.kpiValue}>{managers.length}</div>
          </div>
          <div style={s.kpiCard}>
            <div style={s.kpiLabel}>Pending</div>
            <div style={{ ...s.kpiValue, color: pending.length > 0 ? '#C45000' : '#1A1A1A' }}>{pending.length}</div>
          </div>
        </div>

        {actionError && <div style={s.errorMsg}>{actionError}</div>}

        {loadError ? (
            <div style={s.empty}>
              <div style={{ fontSize: '32px', marginBottom: '12px' }}>⚠️</div>
              {loadError}
              <div style={{ marginTop: '8px', fontSize: '12px' }}>
                Make sure <code style={s.code}>phase1_roles_securite.sql</code> has been run in the Supabase SQL Editor.
              </div>
            </div>
        ) : users.length === 0 ? (
            <div style={s.empty}>
              <div style={{ fontSize: '32px', marginBottom: '12px' }}>👤</div>
              No users found
            </div>
        ) : (
            <div style={s.card}>
              {users.map((u, i) => {
                const isSelf = u.id === currentUser?.id
                const busy = busyId === u.id
                return (
                    <div key={u.id} style={{ ...s.userRow, opacity: u.active ? 1 : 0.75, borderBottom: i < users.length - 1 ? '1px solid rgba(0,0,0,0.04)' : 'none' }}>
                      <div style={s.avatar}>{u.email?.charAt(0).toUpperCase()}</div>
                      <div style={s.userInfo}>
                        <div style={s.userEmail}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{u.email}</span>
                          {isSelf && <span style={s.youBadge}>you</span>}
                          {!u.active && <span style={x.pendingBadge}>pending</span>}
                        </div>
                        <div style={s.userMeta}>Joined {formatDate(u.created_at)} · Last login {formatLastLogin(u.last_sign_in_at)}</div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'flex-end', flexShrink: 0 }}>
                        {busy ? (
                            <div style={s.updating}>…</div>
                        ) : (
                            <>
                              <select
                                  style={{ ...s.roleSelect, color: u.role === 'cashier' ? '#666' : '#1A1A1A' }}
                                  value={u.role ?? 'cashier'}
                                  onChange={e => changerRole(u.id, e.target.value)}
                                  disabled={isSelf} // on ne peut pas changer son propre rôle
                              >
                                {ROLES.map(r => <option key={r} value={r}>{ROLE_META[r].icon} {ROLE_META[r].label}</option>)}
                              </select>
                              {!isSelf && (
                                  <button
                                      style={u.active ? x.deactivateBtn : x.activateBtn}
                                      onClick={() => changerActif(u.id, !u.active)}
                                  >
                                    {u.active ? 'Deactivate' : 'Activate'}
                                  </button>
                              )}
                            </>
                        )}
                      </div>
                    </div>
                )
              })}
            </div>
        )}

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
                    <div>Go to <strong>Supabase dashboard</strong> → Authentication → Users → <strong>Add user</strong></div>
                  </div>
                  <div style={s.instructionStep}>
                    <div style={s.stepNum}>2</div>
                    <div>Enter email + password, check "Auto confirm user", then <strong>Create user</strong></div>
                  </div>
                  <div style={s.instructionStep}>
                    <div style={s.stepNum}>3</div>
                    <div>Come back here and press <strong>Refresh list</strong>. The new account appears as <strong>pending</strong> (cashier): choose its role, then press <strong>Activate</strong></div>
                  </div>
                </div>

                <div style={s.fieldGroup}>
                  <div style={s.fieldLabel}>Roles</div>
                  <div style={s.roleToggle}>
                    {ROLES.map(r => (
                        <div key={r} style={{ ...s.roleOption, cursor: 'default' }}>
                          <div style={{ fontSize: '20px', marginBottom: '4px' }}>{ROLE_META[r].icon}</div>
                          <div style={{ ...s.roleOptionLabel, color: '#1A1A1A' }}>{ROLE_META[r].label}</div>
                          <div style={{ ...s.roleOptionSub, color: '#999' }}>{ROLE_META[r].sub}</div>
                        </div>
                    ))}
                  </div>
                </div>

                <button
                    style={{ ...s.addBtn, width: '100%', padding: '13px 16px', fontSize: '14px' }}
                    onClick={async () => { await fetchUsers(); setShowAdd(false) }}
                >
                  Refresh list
                </button>
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

const x = {
  pendingBadge: { fontSize: '10px', background: '#FFF3E0', color: '#C45000', padding: '1px 6px', borderRadius: '100px', fontWeight: '500', flexShrink: 0 },
  activateBtn: { background: '#1A1A1A', color: 'white', border: 'none', borderRadius: '100px', padding: '5px 12px', fontSize: '11.5px', fontWeight: '500', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  deactivateBtn: { background: 'none', color: '#999', border: 'none', padding: '2px 4px', fontSize: '11px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", textDecoration: 'underline' },
}
