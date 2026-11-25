import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { formatPrice, round2 } from '../lib/format'
import { useAuth } from '../context/AuthContext'
import { recordClientPayment, applyClientCredit, newRequestId, clientMovementError } from '../lib/clientsApi'

export default function ClientsView() {
  // Manager/admin : gestion complète des clients. Cashier (phase 4) : encaisse
  // (paiement de dette, dépôt d'avoir, utilisation de l'avoir) sans créer,
  // renommer ni supprimer de client ; il ne voit que ses propres opérations.
  const { estGerant } = useAuth()
  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedClient, setSelectedClient] = useState(null)
  const [historique, setHistorique] = useState([])
  const [loadingHistorique, setLoadingHistorique] = useState(false)
  const [visibleHistCount, setVisibleHistCount] = useState(10)
  const [montantRemboursement, setMontantRemboursement] = useState('')
  const [savingPaiement, setSavingPaiement] = useState(false)
  const [showAddClient, setShowAddClient] = useState(false)
  const [nouveauNom, setNouveauNom] = useState('')
  const [nouveauTel, setNouveauTel] = useState('')
  const [savingClient, setSavingClient] = useState(false)

  // Recherche
  const [searchClient, setSearchClient] = useState('')

  // Edition nom
  const [editingNom, setEditingNom] = useState(false)
  const [editNomValue, setEditNomValue] = useState('')
  const [savingNom, setSavingNom] = useState(false)

  // Suppression
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

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
    setEditingNom(false)
    setConfirmDelete(false)
    setSurplusChoice(null)
    setResultat(null)
    setErreurPaiement(null)
    setVisibleHistCount(10)
    setLoadingHistorique(true)
    // Historique complet du client (plus de plafond à 20) : affiché ensuite
    // par pages de 10 côté client via "Load more", comme dans Sales.
    const { data } = await supabase
        .from('sales')
        .select('*, products(name, emoji)')
        .eq('client_id', client.id)
        .order('created_at', { ascending: false })
    setHistorique(data ?? [])
    setLoadingHistorique(false)
  }

  const fermerModal = () => {
    setSelectedClient(null)
    setEditingNom(false)
    setConfirmDelete(false)
    setSurplusChoice(null)
    setResultat(null)
    setErreurPaiement(null)
  }

  // ── Mouvements de compte : paiement, dépôt d'avoir, utilisation de l'avoir ──
  // Chaque action = UNE fonction SQL (atomique, soldes lus et verrouillés en
  // base, acteur enregistré). L'identifiant de requête est conservé tant que
  // l'action n'a pas abouti : un double clic ou un nouvel essai après une
  // coupure réseau ne crée jamais deux paiements.
  const pendingReq = useRef({ key: null, id: null })
  const requestIdFor = (key) => {
    if (pendingReq.current.key !== key) pendingReq.current = { key, id: newRequestId() }
    return pendingReq.current.id
  }
  const oublierRequete = () => { pendingReq.current = { key: null, id: null } }

  // Trop-perçu : { amount, surplus } en attente du choix « avoir » / « monnaie rendue »
  const [surplusChoice, setSurplusChoice] = useState(null)
  // Dernier mouvement enregistré : { text, change }
  const [resultat, setResultat] = useState(null)
  const [erreurPaiement, setErreurPaiement] = useState(null)

  const appliquerSoldes = (r) => {
    const clientMaj = { ...selectedClient, debt: Number(r.debt), credit: Number(r.credit) }
    setSelectedClient(clientMaj)
    setClients(cs => cs.map(c => c.id === clientMaj.id ? clientMaj : c))
  }

  const decrireResultat = (r) => {
    const parts = []
    if (Number(r.credit_used) > 0) parts.push(`${formatPrice(r.credit_used)} GH₵ of store credit applied to the debt`)
    else if (Number(r.debt_repaid) > 0) parts.push(`${formatPrice(r.debt_repaid)} GH₵ debt repaid`)
    if (Number(r.credit_created) > 0) parts.push(`${formatPrice(r.credit_created)} GH₵ added as store credit`)
    return { text: parts.join(' · ') || 'Recorded', change: Number(r.change_due ?? 0) }
  }

  const envoyerPaiement = async (montant, surplus) => {
    setSavingPaiement(true)
    setErreurPaiement(null)
    setResultat(null)
    try {
      const reqId = requestIdFor(`pay|${selectedClient.id}|${montant}|${surplus}`)
      const r = await recordClientPayment(selectedClient.id, montant, surplus, reqId)
      oublierRequete()
      appliquerSoldes(r)
      setResultat(decrireResultat(r))
      setMontantRemboursement('')
      setSurplusChoice(null)
      await rafraichirHistorique(selectedClient.id)
    } catch (err) {
      setErreurPaiement(clientMovementError(err))
    } finally {
      setSavingPaiement(false)
    }
  }

  const enregistrerPaiement = () => {
    const montant = round2(parseFloat(montantRemboursement))
    if (!montant || montant <= 0) return
    const dette = Math.max(0, selectedClient.debt ?? 0)
    // Trop-perçu : on demande AVANT d'enregistrer s'il devient de l'avoir ou
    // si la monnaie est rendue. Client sans dette : dépôt d'avoir.
    // (Si la dette réelle en base est plus faible que celle affichée, la base
    // convertit l'excédent en avoir et le message l'indique.)
    if (dette > 0 && montant > dette) {
      setSurplusChoice({ amount: montant, surplus: round2(montant - dette) })
      return
    }
    envoyerPaiement(montant, 'credit')
  }

  // ── Utiliser l'avoir pour solder (tout ou partie) la dette ──────────────────
  const [usingCredit, setUsingCredit] = useState(false)

  const utiliserAvoir = async () => {
    if (round2(Math.min(selectedClient.credit, selectedClient.debt)) <= 0) return
    setUsingCredit(true)
    setErreurPaiement(null)
    setResultat(null)
    try {
      const r = await applyClientCredit(selectedClient.id, requestIdFor(`credit|${selectedClient.id}`))
      oublierRequete()
      appliquerSoldes(r)
      setResultat(decrireResultat(r))
      await rafraichirHistorique(selectedClient.id)
    } catch (err) {
      setErreurPaiement(clientMovementError(err))
    } finally {
      setUsingCredit(false)
    }
  }

  const rafraichirHistorique = async (clientId) => {
    const { data } = await supabase
        .from('sales')
        .select('*, products(name, emoji)')
        .eq('client_id', clientId)
        .order('created_at', { ascending: false })
    setHistorique(data ?? [])
  }

  const ajouterClient = async () => {
    if (!nouveauNom.trim()) return
    setSavingClient(true)
    const { data, error } = await supabase
        .from('clients')
        .insert({ name: nouveauNom.trim(), phone: nouveauTel.trim() || null })
        .select()
        .single()
    if (error) alert(error.message || 'The customer could not be created')
    if (data) setClients(cs => [...cs, data].sort((a, b) => a.name.localeCompare(b.name)))
    setNouveauNom('')
    setNouveauTel('')
    setSavingClient(false)
    setShowAddClient(false)
  }

  // ── Modifier le nom ──────────────────────────────────────────────────────────
  const demarrerEditionNom = () => {
    setEditNomValue(selectedClient.name)
    setEditingNom(true)
    setConfirmDelete(false)
  }

  const sauvegarderNom = async () => {
    const nom = editNomValue.trim()
    if (!nom || nom === selectedClient.name) { setEditingNom(false); return }
    setSavingNom(true)
    const { error } = await supabase
        .from('clients')
        .update({ name: nom })
        .eq('id', selectedClient.id)
    if (!error) {
      const clientMaj = { ...selectedClient, name: nom }
      setSelectedClient(clientMaj)
      setClients(cs => cs.map(c => c.id === clientMaj.id ? clientMaj : c).sort((a, b) => a.name.localeCompare(b.name)))
    }
    setSavingNom(false)
    setEditingNom(false)
  }

  // ── Supprimer le client ──────────────────────────────────────────────────────
  const supprimerClient = async () => {
    setDeleting(true)
    const { error } = await supabase
        .from('clients')
        .delete()
        .eq('id', selectedClient.id)
    if (!error) {
      setClients(cs => cs.filter(c => c.id !== selectedClient.id))
      fermerModal()
    }
    setDeleting(false)
  }

  const totalDettes = clients.reduce((sum, c) => sum + (c.debt ?? 0), 0)
  const clientsAvecDette = clients.filter(c => c.debt > 0).length
  const aAchats = historique.length > 0
  const clientsFiltres = clients.filter(c =>
      c.name.toLowerCase().includes(searchClient.toLowerCase()) ||
      (c.phone ?? '').includes(searchClient)
  )

  const formatDate = (iso) => new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })

  if (loading) return <div style={s.loading}>Loading…</div>

  return (
      <div style={{ fontFamily: "'DM Sans', sans-serif" }}>
        <div style={s.headerRow}>
          <p style={s.titre}>Customers</p>
          {estGerant && <button style={s.addBtn} onClick={() => setShowAddClient(true)}>+ Add</button>}
        </div>

        {/* KPIs (manager/admin) */}
        {estGerant && (
        <div style={s.kpiRow}>
          <div style={s.kpiCard}>
            <div style={s.kpiLabel}>Outstanding debt</div>
            <div style={{ ...s.kpiValue, color: totalDettes > 0 ? '#C45000' : '#2E7D42' }}>
              {totalDettes.toLocaleString()} GH₵
            </div>
          </div>
          <div style={s.kpiCard}>
            <div style={s.kpiLabel}>With balance</div>
            <div style={s.kpiValue}>{clientsAvecDette}</div>
          </div>
        </div>
        )}

        {/* Recherche */}
        <input
            style={{width:'100%',padding:'12px 16px',borderRadius:'12px',border:'1.5px solid #EBEBEB',fontSize:'14px',fontFamily:"'DM Sans',sans-serif",color:'#1A1A1A',outline:'none',marginBottom:'16px',boxSizing:'border-box',background:'white'}}
            placeholder="Search customers…"
            value={searchClient}
            onChange={e => setSearchClient(e.target.value)}
        />

        {/* Liste clients */}
        {clientsFiltres.length === 0 ? (
            <div style={s.empty}><div style={{ fontSize: '32px', marginBottom: '12px' }}>👥</div>No customers yet</div>
        ) : (
            <div style={s.card}>
              {clientsFiltres.map((c, i) => (
                  <div
                      key={c.id}
                      style={{ ...s.clientRow, borderBottom: i < clientsFiltres.length - 1 ? '1px solid rgba(0,0,0,0.04)' : 'none' }}
                      onClick={() => ouvrirClient(c)}
                  >
                    <div style={s.avatar}>{c.name.charAt(0).toUpperCase()}</div>
                    <div style={s.clientInfo}>
                      <div style={s.clientNom}>{c.name}</div>
                      <div style={s.clientTel}>{c.phone ?? 'No phone'}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      {c.debt > 0 && <div style={s.detteAmount}>−{formatPrice(c.debt)} GH₵</div>}
                      {c.credit > 0 && <div style={s.creditAmount}>+{formatPrice(c.credit)} GH₵ credit</div>}
                      {!(c.debt > 0) && !(c.credit > 0) && <div style={s.cleared}>✓ Cleared</div>}
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#CCC" strokeWidth="2" style={{ marginTop: '4px' }}>
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                    </div>
                  </div>
              ))}
            </div>
        )}

        {/* ── Modal détail client ── */}
        {selectedClient && (
            <div style={s.overlay} onClick={e => { if (e.target === e.currentTarget) fermerModal() }}>
              <div style={s.modal}>
                <div style={s.handle} />

                {/* En-tête : avatar + nom (éditable) + téléphone */}
                <div style={s.modalHeader}>
                  <div style={s.modalAvatar}>{selectedClient.name.charAt(0).toUpperCase()}</div>
                  <div style={{ flex: 1 }}>
                    {editingNom ? (
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                          <input
                              style={{ ...s.input, flex: 1, fontSize: '15px', padding: '8px 12px' }}
                              value={editNomValue}
                              onChange={e => setEditNomValue(e.target.value)}
                              autoFocus
                          />
                          <button
                              style={{ ...s.iconBtn, background: '#1A1A1A', color: 'white' }}
                              onClick={sauvegarderNom}
                              disabled={savingNom}
                          >
                            {savingNom ? '…' : '✓'}
                          </button>
                          <button
                              style={{ ...s.iconBtn, background: '#F0F0F0', color: '#666' }}
                              onClick={() => setEditingNom(false)}
                          >
                            ✕
                          </button>
                        </div>
                    ) : (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <div style={s.modalNom}>{selectedClient.name}</div>
                          {estGerant && (
                              <button style={s.editPill} onClick={demarrerEditionNom}>
                                ✏ Edit
                              </button>
                          )}
                        </div>
                    )}
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

                {/* Avoir (store credit) */}
                {selectedClient.credit > 0 && (
                    <div style={{ ...s.detteBanner, background: '#E8F5EC' }}>
                      <div style={s.detteBannerLabel}>Store credit</div>
                      <div style={{ ...s.detteBannerValue, color: '#2E7D42' }}>
                        +{formatPrice(selectedClient.credit)} GH₵
                      </div>
                    </div>
                )}

                {/* Résultat du dernier mouvement (avec la monnaie à rendre) */}
                {resultat && (
                    <div style={{ ...s.surplusBanner, background: '#F0FBF3', border: '1.5px solid #C8E6CF' }}>
                      <div style={s.surplusText}>✓ {resultat.text}</div>
                      {resultat.change > 0 && (
                          <div style={{ ...s.surplusText, fontWeight: '600', marginTop: '6px' }}>
                            Give back {formatPrice(resultat.change)} GH₵ change
                          </div>
                      )}
                    </div>
                )}

                {erreurPaiement && (
                    <div style={{ ...s.surplusBanner, background: '#FFF0F0', border: '1.5px solid #F5C6C6' }}>
                      <div style={{ ...s.surplusText, color: '#B3261E' }}>{erreurPaiement}</div>
                    </div>
                )}

                {/* Trop-perçu : le choix est fait AVANT d'enregistrer (une seule opération) */}
                {surplusChoice && (
                    <div style={s.surplusBanner}>
                      <div style={s.surplusText}>
                        {formatPrice(surplusChoice.amount)} GH₵ received: the debt is settled and{' '}
                        <strong>{formatPrice(surplusChoice.surplus)} GH₵</strong> is left over. What should happen to it?
                      </div>
                      <div style={{ display: 'flex', gap: '10px', marginTop: '12px' }}>
                        <button
                            style={{ ...s.surplusDiscardBtn, opacity: savingPaiement ? 0.5 : 1 }}
                            onClick={() => envoyerPaiement(surplusChoice.amount, 'change')}
                            disabled={savingPaiement}
                        >
                          Give change back
                        </button>
                        <button
                            style={{ ...s.surplusConvertBtn, opacity: savingPaiement ? 0.5 : 1 }}
                            onClick={() => envoyerPaiement(surplusChoice.amount, 'credit')}
                            disabled={savingPaiement}
                        >
                          {savingPaiement ? 'Saving…' : `Store credit (+${formatPrice(surplusChoice.surplus)} GH₵)`}
                        </button>
                      </div>
                      <button
                          style={{ ...s.fullPayBtn, marginTop: '10px', border: 'none' }}
                          onClick={() => setSurplusChoice(null)}
                          disabled={savingPaiement}
                      >
                        Back
                      </button>
                    </div>
                )}

                {/* Enregistrer un paiement (ou un dépôt d'avoir si le client n'a pas de dette) */}
                {!surplusChoice && (
                    <div style={s.paiementSection}>
                      <div style={s.fieldLabel}>{selectedClient.debt > 0 ? 'Record a payment' : 'Add store credit (deposit)'}</div>
                      <div style={s.paiementRow}>
                        <input
                            style={s.paiementInput}
                            type="number"
                            step="0.01"
                            inputMode="decimal"
                            placeholder="Amount (GH₵)"
                            value={montantRemboursement}
                            onChange={e => { setMontantRemboursement(e.target.value); setErreurPaiement(null) }}
                        />
                        <button
                            style={{ ...s.paiementBtn, opacity: (!montantRemboursement || savingPaiement) ? 0.5 : 1 }}
                            onClick={enregistrerPaiement}
                            disabled={!montantRemboursement || savingPaiement}
                        >
                          {savingPaiement ? '…' : selectedClient.debt > 0 ? 'Pay' : 'Add'}
                        </button>
                      </div>
                      {selectedClient.debt > 0 && (
                          <button
                              style={s.fullPayBtn}
                              onClick={() => setMontantRemboursement(String(selectedClient.debt))}
                          >
                            Pay full amount ({selectedClient.debt.toLocaleString()} GH₵)
                          </button>
                      )}

                      {/* Utiliser l'avoir sur la dette */}
                      {selectedClient.debt > 0 && selectedClient.credit > 0 && (
                          <button
                              style={{ ...s.useCreditBtn, opacity: usingCredit ? 0.5 : 1 }}
                              onClick={utiliserAvoir}
                              disabled={usingCredit}
                          >
                            {usingCredit
                                ? 'Applying…'
                                : `💳 Use store credit (−${formatPrice(Math.min(selectedClient.credit, selectedClient.debt))} GH₵)`}
                          </button>
                      )}
                    </div>
                )}

                {/* Historique achats */}
                <div style={s.fieldLabel}>{estGerant ? 'Purchase history' : 'Your transactions with this customer'}</div>
                {loadingHistorique ? (
                    <div style={s.loading}>Loading…</div>
                ) : historique.length === 0 ? (
                    <div style={s.emptySmall}>{estGerant ? 'No purchases yet' : 'No transactions by you yet'}</div>
                ) : (
                    <>
                      <div style={s.historiqueList}>
                        {historique.slice(0, visibleHistCount).map((v, i, arr) => {
                          const isCancelled = !!v.cancelled_at
                          const emoji = v.type === 'paiement' ? '💳' : v.type === 'avoir' ? '💰' : (v.products?.emoji ?? '🍬')
                          const label = v.type === 'paiement'
                              ? (v.credit_used > 0 ? 'Debt payment (store credit)' : 'Debt payment')
                              : v.type === 'avoir'
                                  ? 'Store credit added'
                                  : (v.products?.name ?? '—')
                          const isNegative = v.type === 'paiement'
                          const badge = v.type === 'paiement'
                              ? { style: s.badgeCash, text: 'Payment' }
                              : v.type === 'avoir'
                                  ? { style: s.badgeCash, text: 'Store credit' }
                                  : v.type === 'cash'
                                      ? { style: s.badgeCash, text: 'Paid' }
                                      : { style: s.badgeDette, text: 'Credit' }
                          return (
                              <div
                                  key={v.id}
                                  style={{
                                    ...s.historiqueRow,
                                    borderBottom: i < arr.length - 1 ? '1px solid rgba(0,0,0,0.04)' : 'none',
                                    opacity: isCancelled ? 0.45 : 1,
                                  }}
                              >
                                <div style={s.histEmoji}>{emoji}</div>
                                <div style={{ flex: 1 }}>
                                  <div style={{ ...s.histNom, textDecoration: isCancelled ? 'line-through' : 'none' }}>{label}</div>
                                  <div style={s.histDate}>{formatDate(v.created_at)}{v.qty > 0 ? ` · ×${v.qty}` : ''}</div>
                                  {v.original_amount != null && (
                                      <div style={{ fontSize: '10px', color: '#C45000', marginTop: '1px' }}>
                                        🏷️ Discounted{v.discount_reason ? ` — ${v.discount_reason}` : ''}
                                      </div>
                                  )}
                                </div>
                                <div style={{ textAlign: 'right' }}>
                                  {v.original_amount != null && (
                                      <div style={{ fontSize: '10px', color: '#BBB', textDecoration: 'line-through' }}>
                                        {v.original_amount.toLocaleString()} GH₵
                                      </div>
                                  )}
                                  <div style={{ ...s.histMontant, color: isNegative ? '#2E7D42' : '#1A1A1A', textDecoration: isCancelled ? 'line-through' : 'none' }}>
                                    {isNegative ? '−' : ''}{v.amount?.toLocaleString()} GH₵
                                  </div>
                                  {isCancelled ? (
                                      <span style={s.badgeCancelled}>Cancelled</span>
                                  ) : (
                                      <span style={badge.style}>{badge.text}</span>
                                  )}
                                </div>
                              </div>
                          )
                        })}
                      </div>
                      {visibleHistCount < historique.length && (
                          <div style={{ textAlign: 'center', marginTop: '10px' }}>
                            <button style={s.loadMoreBtn} onClick={() => setVisibleHistCount(c => c + 10)}>
                              Load more
                            </button>
                            <div style={{ fontSize: '11px', color: '#BBB', marginTop: '6px' }}>
                              {Math.min(visibleHistCount, historique.length)} of {historique.length}
                            </div>
                          </div>
                      )}
                    </>
                )}

                {/* ── Zone suppression ── */}
                {estGerant && !loadingHistorique && !aAchats && (
                    <div style={{ marginTop: '24px', borderTop: '1px solid #F0F0F0', paddingTop: '20px' }}>
                      {!confirmDelete ? (
                          <button style={s.deleteBtn} onClick={() => setConfirmDelete(true)}>
                            🗑 Delete customer
                          </button>
                      ) : (
                          <div style={s.confirmBox}>
                            <div style={s.confirmText}>Delete <strong>{selectedClient.name}</strong>? This cannot be undone.</div>
                            <div style={{ display: 'flex', gap: '10px', marginTop: '12px' }}>
                              <button
                                  style={{ ...s.confirmCancelBtn }}
                                  onClick={() => setConfirmDelete(false)}
                              >
                                Cancel
                              </button>
                              <button
                                  style={{ ...s.confirmDeleteBtn, opacity: deleting ? 0.5 : 1 }}
                                  onClick={supprimerClient}
                                  disabled={deleting}
                              >
                                {deleting ? 'Deleting…' : 'Yes, delete'}
                              </button>
                            </div>
                          </div>
                      )}
                    </div>
                )}
              </div>
            </div>
        )}

        {/* ── Modal ajout client ── */}
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
  useCreditBtn: { width: '100%', padding: '11px', marginTop: '8px', background: '#E8F5EC', border: '1.5px solid #C8E6CF', borderRadius: '12px', fontSize: '13px', fontWeight: '500', color: '#2E7D42', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  surplusBanner: { background: '#FFF8E8', border: '1.5px solid #F5E0A8', borderRadius: '14px', padding: '14px 16px', marginBottom: '20px' },
  surplusText: { fontSize: '13px', color: '#1A1A1A', lineHeight: 1.5 },
  surplusDiscardBtn: { flex: 1, padding: '10px', background: '#F0F0F0', border: 'none', borderRadius: '12px', fontSize: '13px', fontWeight: '500', color: '#666', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  surplusConvertBtn: { flex: 1, padding: '10px', background: '#2E7D42', border: 'none', borderRadius: '12px', fontSize: '13px', fontWeight: '500', color: 'white', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  historiqueList: { background: '#FAFAFA', borderRadius: '14px', overflow: 'hidden', marginTop: '8px' },
  historiqueRow: { display: 'flex', alignItems: 'center', padding: '12px 14px', gap: '10px' },
  histEmoji: { width: '32px', height: '32px', borderRadius: '8px', background: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px', flexShrink: 0 },
  histNom: { fontSize: '13px', fontWeight: '500', color: '#1A1A1A' },
  histDate: { fontSize: '11px', color: '#BBB', marginTop: '1px' },
  histMontant: { fontSize: '13px', fontWeight: '600', color: '#1A1A1A' },
  badgeCash: { display: 'inline-block', padding: '2px 7px', borderRadius: '100px', fontSize: '10px', fontWeight: '500', background: '#E8F5EC', color: '#2E7D42' },
  badgeDette: { display: 'inline-block', padding: '2px 7px', borderRadius: '100px', fontSize: '10px', fontWeight: '500', background: '#FFF0E8', color: '#C45000' },
  badgeCancelled: { display: 'inline-block', padding: '2px 7px', borderRadius: '100px', fontSize: '10px', fontWeight: '500', background: '#F0F0F0', color: '#999' },
  emptySmall: { fontSize: '13px', color: '#BBB', padding: '16px 0' },
  loadMoreBtn: { padding: '9px 18px', borderRadius: '100px', border: '1.5px solid #EBEBEB', background: 'white', color: '#1A1A1A', fontFamily: "'DM Sans', sans-serif", fontSize: '12.5px', fontWeight: '500', cursor: 'pointer' },
  fieldGroup: { marginBottom: '16px' },
  input: { width: '100%', padding: '13px 16px', borderRadius: '12px', border: '1.5px solid #EBEBEB', fontSize: '15px', fontFamily: "'DM Sans', sans-serif", color: '#1A1A1A', outline: 'none', boxSizing: 'border-box' },
  submitBtn: { width: '100%', padding: '16px', background: '#1A1A1A', color: 'white', border: 'none', borderRadius: '16px', fontFamily: "'DM Sans', sans-serif", fontSize: '15px', fontWeight: '500', cursor: 'pointer', marginTop: '8px' },
  creditAmount: { fontSize: '12px', fontWeight: '600', color: '#2E7D42', marginTop: '2px' },
  // Nouveaux styles
  editPill: { fontSize: '11px', fontWeight: '500', color: '#999', background: '#F5F5F5', border: 'none', borderRadius: '100px', padding: '3px 10px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  iconBtn: { width: '32px', height: '32px', border: 'none', borderRadius: '8px', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'DM Sans', sans-serif", flexShrink: 0 },
  deleteBtn: { width: '100%', padding: '13px', background: 'none', border: '1.5px solid #FFE5E5', borderRadius: '14px', color: '#CC3333', fontSize: '13px', fontWeight: '500', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  confirmBox: { background: '#FFF5F5', borderRadius: '14px', padding: '16px' },
  confirmText: { fontSize: '13.5px', color: '#1A1A1A', lineHeight: 1.5 },
  confirmCancelBtn: { flex: 1, padding: '11px', background: '#F0F0F0', border: 'none', borderRadius: '12px', fontSize: '13px', fontWeight: '500', color: '#666', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  confirmDeleteBtn: { flex: 1, padding: '11px', background: '#CC3333', border: 'none', borderRadius: '12px', fontSize: '13px', fontWeight: '500', color: 'white', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
}