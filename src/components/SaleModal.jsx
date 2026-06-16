import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { formatPrice, round2 } from '../lib/format'

export default function SaleModal({ product, onClose, onSuccess }) {
  const { user } = useAuth()
  const [qty, setQty] = useState(1)
  const [selectedClient, setSelectedClient] = useState(null)
  const [paymentType, setPaymentType] = useState('cash')
  const [clients, setClients] = useState([])
  const [clientSearch, setClientSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadingClients, setLoadingClients] = useState(true)
  const [cashReceived, setCashReceived] = useState('')
  const [saveAsCredit, setSaveAsCredit] = useState(false)
  const [useCredit, setUseCredit] = useState(false)

  useEffect(() => {
    fetchClients()
  }, [])

  const fetchClients = async () => {
    const { data } = await supabase.from('clients').select('*').order('name')
    setClients(data ?? [])
    setLoadingClients(false)
  }

  const total = round2(product.price * qty)

  // Avoir disponible du client sélectionné
  const clientCredit = selectedClient?.credit ?? 0
  const appliedCredit = useCredit && clientCredit > 0 ? Math.min(round2(clientCredit), total) : 0
  const amountDue = round2(total - appliedCredit)

  const received = parseFloat(cashReceived) || 0
  // La monnaie se calcule sur le reste à payer, pas sur le total
  const changeDue = paymentType === 'cash' && received > amountDue ? round2(received - amountDue) : 0
  // L'avoir nécessite un client identifié
  const creditNeedsClient = saveAsCredit && changeDue > 0 && !selectedClient

  // NOUVEAU : Vérification si le cash reçu est insuffisant (uniquement si le champ n'est pas vide)
  const cashReceivedIsInsufficient = paymentType === 'cash' && cashReceived !== '' && received < amountDue

  // Filtrer les clients selon la recherche
  const filteredClients = clients.filter(c =>
      c.name.toLowerCase().includes(clientSearch.toLowerCase())
  )

  const handleSubmit = async () => {
    setLoading(true)
    try {
      // 1. Récupérer le batch ACTIF (le plus ancien non épuisé) - FIFO
      // On récupère aussi ses mouvements pour calculer dynamiquement son stock restant réel
      const { data: batches, error: batchError } = await supabase
          .from('stock_batches')
          .select(`
            *,
            stock_movements (delta)
          `)
          .eq('product_id', product.id)
          .is('exhausted_at', null)
          .order('received_at', { ascending: true })
          .limit(1)

      if (batchError) throw batchError
      const activeBatch = batches?.[0] ?? null

      // 2. Enregistrer la vente
      const { error: saleError } = await supabase.from('sales').insert({
        product_id: product.id,
        client_id: selectedClient?.id ?? null,
        user_id: user?.id ?? null,
        qty,
        amount: total,
        type: paymentType,
      })
      if (saleError) throw saleError

      // 3. Décrémenter le stock global du produit
      const newStock = product.stock - qty
      const { error: stockError } = await supabase
          .from('products')
          .update({ stock: newStock })
          .eq('id', product.id)
      if (stockError) throw stockError

      // 4. Enregistrer le mouvement de stock (batch_id null si aucun batch actif)
      const { error: movError } = await supabase.from('stock_movements').insert({
        product_id: product.id,
        batch_id: activeBatch?.id ?? null,
        delta: -qty,
        reason: 'vente',
      })
      if (movError) console.error('Erreur mouvement:', movError)

      // 5. Si le BATCH SPÉCIFIQUE est maintenant épuisé, marquer exhausted_at + duration_days
      if (activeBatch) {
        // Somme des deltas passés sur ce lot précis
        const pastDeltasSum = activeBatch.stock_movements?.reduce((sum, mov) => sum + mov.delta, 0) || 0
        // Stock restant dans ce lot APRÈS la vente actuelle
        const batchRemainingStock = activeBatch.received_qty + pastDeltasSum - qty

        if (batchRemainingStock <= 0) {
          const now = new Date()
          const receivedAt = new Date(activeBatch.received_at)
          const durationDays = Math.round((now - receivedAt) / (1000 * 60 * 60 * 24))

          const { error: batchUpdateError } = await supabase
              .from('stock_batches')
              .update({
                exhausted_at: now.toISOString(),
                duration_days: durationDays,
              })
              .eq('id', activeBatch.id)
          if (batchUpdateError) console.error('Erreur update batch:', batchUpdateError)
        }
      }

      // 6. Si dette, incrémenter la dette du client
      if (paymentType === 'dette' && selectedClient) {
        await supabase
            .from('clients')
            .update({ debt: round2((selectedClient.debt ?? 0) + amountDue) })
            .eq('id', selectedClient.id)
      }

      // 7. Mettre à jour l'avoir du client : consommation + éventuel nouvel avoir (monnaie non rendue)
      const newCreditFromChange = (paymentType === 'cash' && saveAsCredit && changeDue > 0) ? changeDue : 0
      const creditDelta = round2(newCreditFromChange - appliedCredit)
      if (selectedClient && creditDelta !== 0) {
        await supabase
            .from('clients')
            .update({ credit: round2((selectedClient.credit ?? 0) + creditDelta) })
            .eq('id', selectedClient.id)
      }

      const usedMsg = appliedCredit > 0 ? ` · Credit used −${formatPrice(appliedCredit)} GH₵` : ''
      const newMsg = (newCreditFromChange > 0 && selectedClient) ? ` · Credit +${formatPrice(newCreditFromChange)} GH₵` : ''
      onSuccess(`✓ Sale recorded — ${formatPrice(total)} GH₵${usedMsg}${newMsg}`)
    } catch (err) {
      console.error('Erreur vente:', err)
      alert('Error while saving. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
      <div style={styles.overlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
        <div style={styles.modal}>
          <div style={styles.handle} />

          {/* Produit */}
          <div style={styles.productHeader}>
            <div style={{ ...styles.productEmoji, background: (product.color ?? '#EEE') + '22' }}>
              {product.emoji ?? '🍬'}
            </div>
            <div>
              <div style={styles.productName}>{product.name}</div>
              <div style={styles.productPrice}>{formatPrice(product.price)} GH₵ · per unit</div>
            </div>
          </div>

          {/* Quantité */}
          <div style={styles.fieldGroup}>
            <div style={styles.fieldLabel}>Quantity</div>
            <div style={styles.qtyControl}>
              <button style={styles.qtyBtn} onClick={() => setQty(q => Math.max(1, q - 1))}>−</button>
              <span style={styles.qtyValue}>{qty}</span>
              <button style={styles.qtyBtn} onClick={() => setQty(q => q + 1)}>+</button>
            </div>
          </div>

          {/* Client */}
          <div style={styles.fieldGroup}>
            <div style={styles.fieldLabel}>Client</div>
            {loadingClients ? (
                <div style={styles.loadingText}>Loading…</div>
            ) : (
                <>
                  {/* Recherche client */}
                  <input
                      style={{ ...styles.input, marginBottom: '8px' }}
                      placeholder="Search clients…"
                      value={clientSearch}
                      onChange={e => setClientSearch(e.target.value)}
                  />
                  <div style={styles.clientList}>
                    {filteredClients.length === 0 ? (
                        <div style={styles.loadingText}>No client found</div>
                    ) : (
                        filteredClients.map(c => (
                            <div
                                key={c.id}
                                style={{
                                  ...styles.clientOption,
                                  borderColor: selectedClient?.id === c.id ? '#1A1A1A' : '#EBEBEB',
                                  background: selectedClient?.id === c.id ? '#FAFAFA' : 'white',
                                }}
                                onClick={() => { setSelectedClient(selectedClient?.id === c.id ? null : c); setUseCredit(false) }}
                            >
                              <div style={{
                                ...styles.checkCircle,
                                background: selectedClient?.id === c.id ? '#1A1A1A' : 'transparent',
                                borderColor: selectedClient?.id === c.id ? '#1A1A1A' : '#DDD',
                              }}>
                                {selectedClient?.id === c.id && (
                                    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="white" strokeWidth="2.5">
                                      <path d="M2 6l3 3 5-5" />
                                    </svg>
                                )}
                              </div>
                              <span style={styles.clientOptionName}>{c.name}</span>
                              {c.debt > 0 && (
                                  <span style={styles.debtBadge}>−{formatPrice(c.debt)} GH₵</span>
                              )}
                              {c.credit > 0 && (
                                  <span style={styles.creditBadge}>+{formatPrice(c.credit)} GH₵</span>
                              )}
                            </div>
                        ))
                    )}
                  </div>
                </>
            )}
          </div>

          {/* Mode de paiement */}
          <div style={styles.fieldGroup}>
            <div style={styles.fieldLabel}>Payment method</div>
            <div style={styles.paymentToggle}>
              <div
                  style={{
                    ...styles.paymentOption,
                    borderColor: paymentType === 'cash' ? '#2E7D42' : '#EBEBEB',
                    background: paymentType === 'cash' ? '#F0FBF3' : 'white',
                  }}
                  onClick={() => setPaymentType('cash')}
              >
                <div style={styles.paymentEmoji}>💵</div>
                <div style={styles.paymentLabel}>Cash payment</div>
              </div>
              <div
                  style={{
                    ...styles.paymentOption,
                    borderColor: paymentType === 'dette' ? '#C45000' : '#EBEBEB',
                    background: paymentType === 'dette' ? '#FFF5EE' : 'white',
                  }}
                  onClick={() => setPaymentType('dette')}
              >
                <div style={styles.paymentEmoji}>📋</div>
                <div style={styles.paymentLabel}>On credit</div>
              </div>
            </div>
            {paymentType === 'dette' && !selectedClient && (
                <div style={styles.warning}>⚠ Select a client to record a credit sale</div>
            )}
          </div>

          {/* Utiliser l'avoir du client */}
          {selectedClient && clientCredit > 0 && (
              <div style={styles.fieldGroup}>
                <div style={styles.fieldLabel}>Store credit</div>
                <div
                    style={{
                      ...styles.creditToggle,
                      marginTop: 0,
                      borderColor: useCredit ? '#2E7D42' : '#EBEBEB',
                      background: useCredit ? '#F0FBF3' : 'white',
                    }}
                    onClick={() => setUseCredit(v => !v)}
                >
                  <div style={{
                    ...styles.checkCircle,
                    background: useCredit ? '#2E7D42' : 'transparent',
                    borderColor: useCredit ? '#2E7D42' : '#DDD',
                  }}>
                    {useCredit && (
                        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="white" strokeWidth="2.5">
                          <path d="M2 6l3 3 5-5" />
                        </svg>
                    )}
                  </div>
                  <span style={{ fontSize: '13px', fontWeight: '500', color: '#1A1A1A', flex: 1 }}>
                    Apply store credit
                  </span>
                  <span style={styles.creditBadge}>{formatPrice(clientCredit)} GH₵ available</span>
                </div>
              </div>
          )}

          {/* Cash reçu + avoir */}
          {paymentType === 'cash' && (
              <div style={styles.fieldGroup}>
                <div style={styles.fieldLabel}>Cash received (optional)</div>
                <input
                    style={styles.input}
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    placeholder={formatPrice(amountDue)}
                    value={cashReceived}
                    onChange={e => setCashReceived(e.target.value)}
                />

                {/* NOUVEAU : Message d'erreur si le montant est insuffisant */}
                {cashReceivedIsInsufficient && (
                    <div style={styles.warning}>
                      ⚠ The amount received is less than the total due. Please correct the amount or select "On credit" payment method.
                    </div>
                )}

                {changeDue > 0 && (
                    <>
                      <div style={styles.changeRow}>
                        Change due: <strong>{formatPrice(changeDue)} GH₵</strong>
                      </div>
                      <div
                          style={{
                            ...styles.creditToggle,
                            borderColor: saveAsCredit ? '#2E7D42' : '#EBEBEB',
                            background: saveAsCredit ? '#F0FBF3' : 'white',
                          }}
                          onClick={() => setSaveAsCredit(v => !v)}
                      >
                        <div style={{
                          ...styles.checkCircle,
                          background: saveAsCredit ? '#2E7D42' : 'transparent',
                          borderColor: saveAsCredit ? '#2E7D42' : '#DDD',
                        }}>
                          {saveAsCredit && (
                              <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="white" strokeWidth="2.5">
                                <path d="M2 6l3 3 5-5" />
                              </svg>
                          )}
                        </div>
                        <span style={{ fontSize: '13px', fontWeight: '500', color: '#1A1A1A' }}>
                          No change available — save as store credit
                        </span>
                      </div>
                      {creditNeedsClient && (
                          <div style={styles.warning}>⚠ Select a client to save a store credit</div>
                      )}
                    </>
                )}
              </div>
          )}

          {/* Total */}
          <div style={styles.totalLine}>
            <span style={styles.totalLabel}>Total</span>
            <span style={styles.totalValue}>{formatPrice(total)} GH₵</span>
          </div>

          {appliedCredit > 0 && (
              <div style={styles.dueBreakdown}>
                <div style={styles.dueRow}>
                  <span>Store credit applied</span>
                  <span style={{ color: '#2E7D42', fontWeight: '600' }}>−{formatPrice(appliedCredit)} GH₵</span>
                </div>
                <div style={styles.dueRow}>
                  <span>To pay</span>
                  <span style={{ color: '#1A1A1A', fontWeight: '600' }}>{formatPrice(amountDue)} GH₵</span>
                </div>
              </div>
          )}

          {/* Bouton de soumission mis à jour avec le blocage si montant insuffisant */}
          <button
              style={{
                ...styles.submitBtn,
                opacity: (loading || (paymentType === 'dette' && !selectedClient) || creditNeedsClient || cashReceivedIsInsufficient) ? 0.5 : 1,
                cursor: (loading || (paymentType === 'dette' && !selectedClient) || creditNeedsClient || cashReceivedIsInsufficient) ? 'not-allowed' : 'pointer',
              }}
              onClick={handleSubmit}
              disabled={loading || (paymentType === 'dette' && !selectedClient) || creditNeedsClient || cashReceivedIsInsufficient}
          >
            {loading ? 'Saving…' : 'Record sale'}
          </button>
        </div>
      </div>
  )
}

const styles = {
  overlay: {
    position: 'fixed', inset: 0,
    background: 'rgba(0,0,0,0.35)',
    backdropFilter: 'blur(4px)',
    zIndex: 100,
    display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    animation: 'overlayIn 0.2s ease',
  },
  modal: {
    background: 'white',
    borderRadius: '28px 28px 0 0',
    padding: '8px 24px 40px',
    width: '100%', maxWidth: '430px',
    maxHeight: '90vh', overflowY: 'auto',
    animation: 'modalUp 0.3s cubic-bezier(0.34,1.56,0.64,1)',
    fontFamily: "'DM Sans', sans-serif",
  },
  handle: {
    width: '36px', height: '4px',
    background: '#E0E0E0', borderRadius: '10px',
    margin: '10px auto 20px',
  },
  productHeader: {
    display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '24px',
  },
  productEmoji: {
    width: '56px', height: '56px', borderRadius: '16px',
    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '28px',
    flexShrink: 0,
  },
  productName: {
    fontFamily: "'DM Serif Display', serif",
    fontSize: '20px', color: '#1A1A1A', letterSpacing: '-0.3px',
  },
  productPrice: { fontSize: '14px', color: '#999', marginTop: '2px' },
  fieldGroup: { marginBottom: '20px' },
  fieldLabel: {
    fontSize: '11.5px', fontWeight: '600', color: '#999',
    textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '8px',
  },
  loadingText: { fontSize: '13px', color: '#BBB' },
  qtyControl: {
    display: 'flex', alignItems: 'center',
    background: '#F5F5F5', borderRadius: '14px',
    overflow: 'hidden', width: 'fit-content',
  },
  qtyBtn: {
    width: '48px', height: '48px', border: 'none', background: 'none',
    fontSize: '22px', cursor: 'pointer', color: '#1A1A1A',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontWeight: '300', fontFamily: "'DM Sans', sans-serif",
  },
  qtyValue: {
    minWidth: '52px', textAlign: 'center',
    fontFamily: "'DM Serif Display', serif",
    fontSize: '22px', color: '#1A1A1A',
  },
  clientList: { display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '180px', overflowY: 'auto' },
  clientOption: {
    display: 'flex', alignItems: 'center', gap: '10px',
    padding: '10px 14px', borderRadius: '12px',
    border: '1.5px solid #EBEBEB', cursor: 'pointer',
    transition: 'all 0.15s',
  },
  checkCircle: {
    width: '18px', height: '18px', borderRadius: '50%',
    border: '1.5px solid #DDD',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, transition: 'all 0.15s',
  },
  clientOptionName: { fontSize: '13.5px', fontWeight: '500', color: '#1A1A1A', flex: 1 },
  debtBadge: {
    fontSize: '11px', fontWeight: '500',
    background: '#FFF0E8', color: '#C45000',
    padding: '2px 8px', borderRadius: '100px',
  },
  paymentToggle: { display: 'flex', gap: '10px' },
  paymentOption: {
    flex: 1, padding: '12px', borderRadius: '14px',
    border: '1.5px solid #EBEBEB', cursor: 'pointer',
    textAlign: 'center', transition: 'all 0.15s',
  },
  paymentEmoji: { fontSize: '20px', marginBottom: '4px' },
  paymentLabel: { fontSize: '12.5px', fontWeight: '500', color: '#1A1A1A' },
  warning: {
    fontSize: '12px', color: '#C45000',
    background: '#FFF5EE', borderRadius: '8px',
    padding: '8px 12px', marginTop: '8px',
  },
  totalLine: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '16px 0', borderTop: '1px solid #F0F0F0', margin: '4px 0 20px',
  },
  totalLabel: { fontSize: '13px', color: '#999' },
  totalValue: {
    fontFamily: "'DM Serif Display', serif",
    fontSize: '24px', color: '#1A1A1A',
  },
  submitBtn: {
    width: '100%', padding: '16px',
    background: '#1A1A1A', color: 'white',
    border: 'none', borderRadius: '16px',
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '15px', fontWeight: '500',
    transition: 'all 0.2s ease',
  },
  input: {
    width: '100%', padding: '13px 16px',
    borderRadius: '12px', border: '1.5px solid #EBEBEB',
    fontSize: '15px', fontFamily: "'DM Sans', sans-serif",
    color: '#1A1A1A', outline: 'none', boxSizing: 'border-box',
  },
  changeRow: {
    fontSize: '13px', color: '#1A1A1A', marginTop: '10px',
    padding: '10px 14px', background: '#F9F9F9', borderRadius: '10px',
  },
  creditToggle: {
    display: 'flex', alignItems: 'center', gap: '10px',
    padding: '12px 14px', borderRadius: '12px',
    border: '1.5px solid #EBEBEB', cursor: 'pointer',
    marginTop: '8px', transition: 'all 0.15s',
  },
  creditBadge: {
    fontSize: '11px', fontWeight: '500',
    background: '#E8F5EC', color: '#2E7D42',
    padding: '2px 8px', borderRadius: '100px',
  },
  dueBreakdown: {
    marginTop: '-12px', marginBottom: '20px',
    background: '#F9F9F9', borderRadius: '12px', padding: '10px 14px',
  },
  dueRow: {
    display: 'flex', justifyContent: 'space-between',
    fontSize: '13px', color: '#999', padding: '3px 0',
  },
}
