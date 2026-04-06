import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export default function ClientsView() {
  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedClient, setSelectedClient] = useState(null)
  const [historique, setHistorique] = useState([])
  const [loadingHistorique, setLoadingHistorique] = useState(false)
  const [montantRemboursement, setMontantRemboursement] = useState('')
  const [savingPaiement, setSavingPaiement] = useState(false)
  const [showAddClient, setShowAddClient] = useState(false)
  const [nouveauNom, setNouveauNom] = useState('')
  const [nouveauTel, setNouveauTel] = useState('')
  const [savingClient, setSavingClient] = useState(false)

  useEffect(() => { fetchClients() }, [])

  const fetchClients = async () => {
    const { data } = await supabase
      .from('clients')
      .select('*')
      .order('name')
    setClients(data ?? [])
    setLoading(false)
  }

  const ouvrirClient = async (client) => {
    setSelectedClient(client)
    setMontantRemboursement('')
    setLoadingHistorique(true)
    const { data } = await supabase
      .from('sales')
      .select('*, products(name, emoji)')
      .eq('client_id', client.id)
      .order('created_at', { ascending: false })
      .limit(20)
    setHistorique(data ?? [])
    setLoadingHistorique(false)
  }

  const enregistrerPaiement = async () => {
    const montant = parseInt(montantRemboursement)
    if (!montant || montant <= 0) return
    setSavingPaiement(true)
    const nouvelleDette = Math.max(0, selectedClient.debt - montant)
    await supabase
      .from('clients')
      .update({ debt: nouvelleDette })
      .eq('id', selectedClient.id)
    const clientMaj = { ...selectedClient, debt: nouvelleDette }
    setSelectedClient(clientMaj)
    setClients(cs => cs.map(c => c.id === clientMaj.id ? clientMaj : c))
    setMontantRemboursement('')
    setSavingPaiement(false)
  }

  const ajouterClient = async () => {
    if (!nouveauNom.trim()) return
    setSavingClient(true)
    const { data } = await supabase
      .from('clients')
      .insert({ name: nouveauNom.trim(), phone: nouveauTel.trim() || null, debt: 0 })
      .select()
      .single()
    if (data) setClients(cs => [...cs, data].sort((a, b) => a.name.localeCompare(b.name)))
    setNouveauNom('')
    setNouveauTel('')
    setSavingClient(false)
    setShowAddClient(false)
  }

  const totalDettes = clients.reduce((sum, c) => sum + (c.debt ?? 0), 0)
  const clientsAvecDette = clients.filter(c => c.debt > 0).length

  const formatDate = (iso) => new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })

  if (loading) return <div style={s.loading}>Loading…</div>

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif" }}>
      <div style={s.headerRow}>
        <p style={s.titre}>Customers</p>
        <button style={s.addBtn} onClick={() => setShowAddClient(true)}>+ Add</button>
      </div>

      {/* KPIs */}
      <div style={s.kpiRow}>
        <div style={s.kpiCard}>
          <div style={s.kpiLabel}>Outstanding debt</div>
          <div style={{ ...s.kpiValue, color: totalDettes > 0 ? '#C45000' : '#2E7D42' }}>
            {totalDettes.toLocaleString()} F
          </div>
        </div>
        <div style={s.kpiCard}>
          <div style={s.kpiLabel}>With balance</div>
          <div style={s.kpiValue}>{clientsAvecDette}</div>
        </div>
      </div>

      {/* Liste clients */}
      {clients.length === 0 ? (
        <div style={s.empty}><div style={{ fontSize: '32px', marginBottom: '12px' }}>👥</div>No customers yet</div>
      ) : (
        <div style={s.card}>
          {clients.map((c, i) => (
            <div
              key={c.id}
              style={{ ...s.clientRow, borderBottom: i < clients.length - 1 ? '1px solid rgba(0,0,0,0.04)' : 'none' }}
              onClick={() => ouvrirClient(c)}
            >
              <div style={s.avatar}>{c.name.charAt(0).toUpperCase()}</div>
              <div style={s.clientInfo}>
                <div style={s.clientNom}>{c.name}</div>
                <div style={s.clientTel}>{c.phone ?? 'No phone'}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                {c.debt > 0
                  ? <div style={s.detteAmount}>−{c.debt.toLocaleString()} GH₵</div>
                  : <div style={s.cleared}>✓ Cleared</div>
                }
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#CCC" strokeWidth="2" style={{ marginTop: '4px' }}>
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modal détail client */}
      {selectedClient && (
        <div style={s.overlay} onClick={e => { if (e.target === e.currentTarget) setSelectedClient(null) }}>
          <div style={s.modal}>
            <div style={s.handle} />

            <div style={s.modalHeader}>
              <div style={s.modalAvatar}>{selectedClient.name.charAt(0).toUpperCase()}</div>
              <div>
                <div style={s.modalNom}>{selectedClient.name}</div>
                <div style={s.modalTel}>{selectedClient.phone ?? 'No phone'}</div>
              </div>
            </div>

            {/* Solde dette */}
            <div style={{ ...s.detteBanner, background: selectedClient.debt > 0 ? '#FFF5EE' : '#F0FBF3' }}>
              <div style={s.detteBannerLabel}>Current balance</div>
              <div style={{ ...s.detteBannerValue, color: selectedClient.debt > 0 ? '#C45000' : '#2E7D42' }}>
                {selectedClient.debt > 0 ? `−${selectedClient.debt.toLocaleString()} GH₵` : 'Cleared ✓'}
              </div>
            </div>

            {/* Enregistrer un paiement */}
            {selectedClient.debt > 0 && (
              <div style={s.paiementSection}>
                <div style={s.fieldLabel}>Record a payment</div>
                <div style={s.paiementRow}>
                  <input
                    style={s.paiementInput}
                    type="number"
                    placeholder="Amount (GH₵)"
                    value={montantRemboursement}
                    onChange={e => setMontantRemboursement(e.target.value)}
                  />
                  <button
                    style={{ ...s.paiementBtn, opacity: (!montantRemboursement || savingPaiement) ? 0.5 : 1 }}
                    onClick={enregistrerPaiement}
                    disabled={!montantRemboursement || savingPaiement}
                  >
                    {savingPaiement ? '…' : 'Pay'}
                  </button>
                </div>
                <button
                  style={s.fullPayBtn}
                  onClick={() => setMontantRemboursement(String(selectedClient.debt))}
                >
                  Pay full amount ({selectedClient.debt.toLocaleString()} GH₵)
                </button>
              </div>
            )}

            {/* Historique achats */}
            <div style={s.fieldLabel}>Purchase history</div>
            {loadingHistorique ? (
              <div style={s.loading}>Loading…</div>
            ) : historique.length === 0 ? (
              <div style={s.emptySmall}>No purchases yet</div>
            ) : (
              <div style={s.historiqueList}>
                {historique.map((v, i) => (
                  <div key={v.id} style={{ ...s.historiqueRow, borderBottom: i < historique.length - 1 ? '1px solid rgba(0,0,0,0.04)' : 'none' }}>
                    <div style={s.histEmoji}>{v.products?.emoji ?? '🍬'}</div>
                    <div style={{ flex: 1 }}>
                      <div style={s.histNom}>{v.products?.name ?? '—'}</div>
                      <div style={s.histDate}>{formatDate(v.created_at)} · ×{v.qty}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={s.histMontant}>{v.amount?.toLocaleString()} GH₵</div>
                      <span style={v.type === 'cash' ? s.badgeCash : s.badgeDette}>
                        {v.type === 'cash' ? 'Paid' : 'Credit'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal ajout client */}
      {showAddClient && (
        <div style={s.overlay} onClick={e => { if (e.target === e.currentTarget) setShowAddClient(false) }}>
          <div style={{ ...s.modal, paddingBottom: '40px' }}>
            <div style={s.handle} />
            <div style={{ ...s.modalNom, marginBottom: '24px' }}>New customer</div>

            <div style={s.fieldGroup}>
              <div style={s.fieldLabel}>Full name *</div>
              <input style={s.input} placeholder="Aminata Diallo" value={nouveauNom} onChange={e => setNouveauNom(e.target.value)} />
            </div>
            <div style={s.fieldGroup}>
              <div style={s.fieldLabel}>Phone (optional)</div>
              <input style={s.input} placeholder="07 12 34 56" value={nouveauTel} onChange={e => setNouveauTel(e.target.value)} />
            </div>

            <button
              style={{ ...s.submitBtn, opacity: (!nouveauNom.trim() || savingClient) ? 0.5 : 1 }}
              onClick={ajouterClient}
              disabled={!nouveauNom.trim() || savingClient}
            >
              {savingClient ? 'Saving…' : 'Add customer'}
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
  empty: { textAlign: 'center', padding: '48px 24px', color: '#BBB', fontSize: '14px' },
  card: { background: 'white', borderRadius: '18px', border: '1px solid rgba(0,0,0,0.05)', boxShadow: '0 2px 12px rgba(0,0,0,0.04)', overflow: 'hidden' },
  clientRow: { display: 'flex', alignItems: 'center', padding: '14px 18px', gap: '12px', cursor: 'pointer' },
  avatar: { width: '38px', height: '38px', borderRadius: '50%', background: 'linear-gradient(135deg,#E84B6E22,#F5C84222)', border: '1.5px solid rgba(0,0,0,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '15px', fontWeight: '600', color: '#1A1A1A', flexShrink: 0 },
  clientInfo: { flex: 1 },
  clientNom: { fontSize: '13.5px', fontWeight: '500', color: '#1A1A1A' },
  clientTel: { fontSize: '11.5px', color: '#999', marginTop: '1px' },
  detteAmount: { fontSize: '14px', fontWeight: '600', color: '#C45000' },
  cleared: { fontSize: '13px', fontWeight: '500', color: '#2E7D42' },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(4px)', zIndex: 100, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
  modal: { background: 'white', borderRadius: '28px 28px 0 0', padding: '8px 24px 40px', width: '100%', maxWidth: '430px', maxHeight: '90vh', overflowY: 'auto', fontFamily: "'DM Sans', sans-serif" },
  handle: { width: '36px', height: '4px', background: '#E0E0E0', borderRadius: '10px', margin: '10px auto 20px' },
  modalHeader: { display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '20px' },
  modalAvatar: { width: '52px', height: '52px', borderRadius: '50%', background: 'linear-gradient(135deg,#E84B6E22,#F5C84222)', border: '1.5px solid rgba(0,0,0,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '20px', fontWeight: '600', color: '#1A1A1A', flexShrink: 0 },
  modalNom: { fontFamily: "'DM Serif Display', serif", fontSize: '20px', color: '#1A1A1A' },
  modalTel: { fontSize: '13px', color: '#999', marginTop: '2px' },
  detteBanner: { borderRadius: '14px', padding: '14px 18px', marginBottom: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  detteBannerLabel: { fontSize: '13px', color: '#999' },
  detteBannerValue: { fontFamily: "'DM Serif Display', serif", fontSize: '20px' },
  paiementSection: { marginBottom: '20px' },
  fieldLabel: { fontSize: '11.5px', fontWeight: '600', color: '#999', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '8px' },
  paiementRow: { display: 'flex', gap: '10px', marginBottom: '8px' },
  paiementInput: { flex: 1, padding: '12px 14px', borderRadius: '12px', border: '1.5px solid #EBEBEB', fontSize: '15px', fontFamily: "'DM Sans', sans-serif", color: '#1A1A1A', outline: 'none' },
  paiementBtn: { padding: '12px 20px', background: '#2E7D42', color: 'white', border: 'none', borderRadius: '12px', fontSize: '14px', fontWeight: '500', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  fullPayBtn: { width: '100%', padding: '10px', background: 'none', border: '1.5px dashed #CCC', borderRadius: '12px', fontSize: '13px', color: '#999', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  historiqueList: { background: '#FAFAFA', borderRadius: '14px', overflow: 'hidden', marginTop: '8px' },
  historiqueRow: { display: 'flex', alignItems: 'center', padding: '12px 14px', gap: '10px' },
  histEmoji: { width: '32px', height: '32px', borderRadius: '8px', background: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px', flexShrink: 0 },
  histNom: { fontSize: '13px', fontWeight: '500', color: '#1A1A1A' },
  histDate: { fontSize: '11px', color: '#BBB', marginTop: '1px' },
  histMontant: { fontSize: '13px', fontWeight: '600', color: '#1A1A1A' },
  badgeCash: { display: 'inline-block', padding: '2px 7px', borderRadius: '100px', fontSize: '10px', fontWeight: '500', background: '#E8F5EC', color: '#2E7D42' },
  badgeDette: { display: 'inline-block', padding: '2px 7px', borderRadius: '100px', fontSize: '10px', fontWeight: '500', background: '#FFF0E8', color: '#C45000' },
  emptySmall: { fontSize: '13px', color: '#BBB', padding: '16px 0' },
  fieldGroup: { marginBottom: '16px' },
  input: { width: '100%', padding: '13px 16px', borderRadius: '12px', border: '1.5px solid #EBEBEB', fontSize: '15px', fontFamily: "'DM Sans', sans-serif", color: '#1A1A1A', outline: 'none', boxSizing: 'border-box' },
  submitBtn: { width: '100%', padding: '16px', background: '#1A1A1A', color: 'white', border: 'none', borderRadius: '16px', fontFamily: "'DM Sans', sans-serif", fontSize: '15px', fontWeight: '500', cursor: 'pointer', marginTop: '8px' },
}
