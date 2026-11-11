import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { formatPrice, round2 } from '../lib/format'
import { printReceipt } from '../lib/receipt'
import { enqueueSale } from '../lib/offlineQueue'
import { recordSale, newRequestId, adjustCachedMyStock } from '../lib/stockApi'
import { useMyStock } from '../hooks/useMyStock'
import { cacheClients, getCachedClients, cacheProducts, getCachedProducts, notifyCacheUpdated } from '../lib/offlineCache'

// Vente "panier" : plusieurs produits, un seul client, un seul paiement, un
// seul reçu — pour enregistrer en une fois un achat multi-produits.
//
// Phase 2 : le panier est enregistré par la fonction SQL record_sale, en UNE
// opération atomique (toutes les lignes, ou aucune) sur le stock détenu par le
// vendeur (FIFO sur ses lots). Toutes les lignes partagent un `group_id`
// commun ; la dette/l'avoir générés par le paiement sont répartis par ligne au
// prorata de leur montant côté base (pour que Dashboard, fiche client et
// VentesView restent corrects), et le solde du client est mis à jour une seule
// fois. Chaque ligne reste annulable seule ou avec tout le panier (cancel_sales).
export default function CartSaleModal({ cart, setCart, onClose, onSuccess }) {
  const { user } = useAuth()
  const { myStock } = useMyStock()
  // Identifiants stables pour CE panier (idempotence : un nouvel essai après une
  // réponse perdue ne duplique pas la vente ; group_id relie toutes les lignes).
  const requestIdRef = useRef(newRequestId())
  const groupIdRef = useRef(newRequestId())
  const [discounts, setDiscounts] = useState({}) // { [productId]: { isDiscounted, discountedPrice, discountReason } }
  const [selectedClient, setSelectedClient] = useState(null)
  const [paymentType, setPaymentType] = useState('cash')
  const [clients, setClients] = useState([])
  const [clientSearch, setClientSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadingClients, setLoadingClients] = useState(true)
  const [cashReceived, setCashReceived] = useState('')
  const [saveAsCredit, setSaveAsCredit] = useState(false)
  const [useCredit, setUseCredit] = useState(false)
  const [receiptData, setReceiptData] = useState(null)

  useEffect(() => { fetchClients() }, [])

  const fetchClients = async () => {
    if (!navigator.onLine) {
      setClients(getCachedClients())
      setLoadingClients(false)
      return
    }
    const { data } = await supabase.from('clients').select('*').order('name')
    setClients(data ?? [])
    cacheClients(data ?? [])
    setLoadingClients(false)
  }

  // -- Calculs par ligne (même formule que SaleModal, appliquée à chaque produit) --
  // `cart` (prop) reste la seule source de vérité pour "quels produits, quelle
  // quantité" — `discounts` ne fait qu'ajouter par-dessus la remise éventuelle
  // saisie dans ce formulaire, sans jamais dupliquer product/qty.
  const computedLines = cart.map(c => {
    const d = discounts[c.product.id] ?? { isDiscounted: false, discountedPrice: '', discountReason: '' }
    const parsedDiscountPrice = parseFloat(d.discountedPrice)
    const discountInvalid = d.isDiscounted && (
        d.discountedPrice === '' || isNaN(parsedDiscountPrice) || parsedDiscountPrice < 0 || parsedDiscountPrice >= c.product.price
    )
    const hasValidDiscount = d.isDiscounted && !discountInvalid
    const effectiveUnitPrice = hasValidDiscount ? parsedDiscountPrice : c.product.price
    const total = round2(effectiveUnitPrice * c.qty)
    const originalTotal = round2(c.product.price * c.qty)
    const insufficientStock = c.qty > (myStock[c.product.id] ?? 0)
    return {
      product: c.product, qty: c.qty,
      isDiscounted: d.isDiscounted, discountedPrice: d.discountedPrice, discountReason: d.discountReason,
      discountInvalid, hasValidDiscount, effectiveUnitPrice, total, originalTotal, insufficientStock,
    }
  })

  const cartTotal = round2(computedLines.reduce((sum, l) => sum + l.total, 0))
  const anyDiscountInvalid = computedLines.some(l => l.discountInvalid)
  const anyInsufficientStock = computedLines.some(l => l.insufficientStock)

  const clientCredit = selectedClient?.credit ?? 0
  const appliedCredit = useCredit && clientCredit > 0 ? Math.min(round2(clientCredit), cartTotal) : 0
  const amountDue = round2(cartTotal - appliedCredit)

  const received = parseFloat(cashReceived) || 0
  const changeDue = paymentType === 'cash' && received > amountDue ? round2(received - amountDue) : 0
  const creditNeedsClient = saveAsCredit && changeDue > 0 && !selectedClient
  const cashReceivedIsInsufficient = paymentType === 'cash' && cashReceived !== '' && received < amountDue

  const newCreditFromChange = (paymentType === 'cash' && saveAsCredit && changeDue > 0) ? changeDue : 0

  const filteredClients = clients.filter(c => c.name.toLowerCase().includes(clientSearch.toLowerCase()))

  // Quantité et suppression modifient directement `cart` (via la prop setCart) :
  // c'est ce qui garde la barre panier de App.jsx et ce modal synchronisés à
  // tout instant, y compris si l'utilisateur ferme le modal sans valider.
  const updateQty = (productId, qty) => setCart(cur => cur.map(c => c.product.id === productId ? { ...c, qty } : c))
  const removeLine = (productId) => setCart(cur => cur.filter(c => c.product.id !== productId))
  const updateDiscount = (productId, patch) => setDiscounts(cur => ({
    ...cur,
    [productId]: { isDiscounted: false, discountedPrice: '', discountReason: '', ...cur[productId], ...patch },
  }))

  const buildReceiptData = (offline) => ({
    lines: computedLines.map(l => ({
      productName: l.product.name, emoji: l.product.emoji, qty: l.qty, unitPrice: l.effectiveUnitPrice,
      amount: l.total, originalAmount: l.hasValidDiscount ? l.originalTotal : null,
      discountReason: l.hasValidDiscount ? (l.discountReason.trim() || null) : null,
    })),
    amount: cartTotal, type: paymentType, clientName: selectedClient?.name ?? null,
    appliedCredit, changeDue: paymentType === 'cash' ? changeDue : 0,
    newCredit: newCreditFromChange, created_at: new Date().toISOString(), offline,
  })

  const handleSubmit = async () => {
    if (anyInsufficientStock) {
      alert('Not enough stock in your holdings for one or more items — adjust the quantities.')
      return
    }
    if (computedLines.length === 0) {
      alert('Cart is empty.')
      return
    }

    setLoading(true)

    // Payload envoyé à la fonction SQL record_sale : le panier est enregistré
    // en UNE opération atomique (toutes les lignes, ou aucune). Prix, totaux,
    // répartition de la dette/de l'avoir par ligne et coût sont recalculés côté
    // base ; on n'envoie que les intentions.
    const payload = {
      request_id: requestIdRef.current,
      group_id: groupIdRef.current,
      client_id: selectedClient?.id ?? null,
      payment_type: paymentType,
      credit_applied: appliedCredit,
      cash_received: paymentType === 'cash' && cashReceived !== '' ? received : null,
      save_change_as_credit: saveAsCredit,
      lines: computedLines.map(l => ({
        product_id: l.product.id,
        qty: l.qty,
        unit_price: l.hasValidDiscount ? parseFloat(l.discountedPrice) : null,
        discount_reason: l.hasValidDiscount ? (l.discountReason.trim() || null) : null,
      })),
    }
    const stockDeltas = {}
    computedLines.forEach(l => { stockDeltas[l.product.id] = -l.qty })

    // ── Hors-ligne : le panier entier est mis en file (une seule entrée) et
    // rejoué par la même fonction au retour du réseau — voir offlineQueue.js.
    if (!navigator.onLine) {
      try {
        enqueueSale({
          v: 2,
          user_id: user?.id ?? null,
          payload: { ...payload, offline: true },
          summary: { amount: cartTotal, lines: computedLines.map(l => ({ name: l.product.name, qty: l.qty })) },
        })

        const cachedProducts = getCachedProducts().map(p => {
          const l = computedLines.find(x => x.product.id === p.id)
          return l ? { ...p, stock: p.stock - l.qty } : p
        })
        cacheProducts(cachedProducts)
        if (user?.id) adjustCachedMyStock(user.id, stockDeltas)

        if (selectedClient) {
          const creditDelta = round2(newCreditFromChange - appliedCredit)
          const cachedClients = getCachedClients().map(c => {
            if (c.id !== selectedClient.id) return c
            const updated = { ...c }
            if (paymentType === 'dette') updated.debt = round2((c.debt ?? 0) + amountDue)
            if (creditDelta !== 0) updated.credit = round2((c.credit ?? 0) + creditDelta)
            return updated
          })
          cacheClients(cachedClients)
        }
        notifyCacheUpdated()

        setReceiptData(buildReceiptData(true))
        setCart([])
        onSuccess(`📴 Sale saved offline — ${formatPrice(cartTotal)} GH₵ (will sync automatically)`)
      } catch (err) {
        console.error('Erreur mise en file hors-ligne (panier):', err)
        alert('Error while saving offline. Please try again.')
      } finally {
        setLoading(false)
      }
      return
    }

    try {
      const res = await recordSale(payload)
      const dup = !!res?.duplicate
      const serverCredit = dup ? appliedCredit : (res?.credit_applied ?? appliedCredit)
      const serverNewCredit = dup ? newCreditFromChange : (res?.credit_created ?? newCreditFromChange)

      if (!dup && user?.id) adjustCachedMyStock(user.id, stockDeltas)
      notifyCacheUpdated()

      const usedMsg = serverCredit > 0 ? ` · Credit used −${formatPrice(serverCredit)} GH₵` : ''
      const newMsg = (serverNewCredit > 0 && selectedClient) ? ` · Credit +${formatPrice(serverNewCredit)} GH₵` : ''
      setReceiptData({ ...buildReceiptData(false), appliedCredit: serverCredit, newCredit: serverNewCredit })
      setCart([])
      onSuccess(`✓ Sale recorded — ${formatPrice(cartTotal)} GH₵${usedMsg}${newMsg}`)
    } catch (err) {
      console.error('Erreur vente panier:', err)
      alert(err?.isNetwork
        ? 'Could not reach the server. Please try again — the sale will not be recorded twice.'
        : (err?.message || 'Error while saving. Please try again.'))
    } finally {
      setLoading(false)
    }
  }

  // Écran de confirmation (même pattern que SaleModal) : reste ouvert jusqu'à
  // ce que l'utilisateur clique "Done".
  if (receiptData) {
    return (
        <div style={styles.overlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
          <div style={styles.modal}>
            <div style={styles.handle} />
            <div style={{ textAlign: 'center', padding: '4px 0 20px' }}>
              <div style={{ fontSize: '40px' }}>{receiptData.offline ? '📴' : '✅'}</div>
              <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: '20px', color: '#1A1A1A', marginTop: '8px' }}>
                {receiptData.offline ? 'Sale saved offline' : 'Sale recorded'}
              </div>
              {receiptData.offline && (
                  <div style={{ fontSize: '12.5px', color: '#C45000', marginTop: '6px' }}>
                    Will sync automatically once back online
                  </div>
              )}
            </div>

            <div style={{ background: '#F9F9F9', borderRadius: '14px', padding: '16px', marginBottom: '20px', fontSize: '13px', color: '#1A1A1A' }}>
              {receiptData.lines.map((l, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <span>{l.emoji} {l.productName} × {l.qty}</span>
                    <span style={{ textAlign: 'right' }}>
                      {l.originalAmount != null && (
                          <div style={{ fontSize: '11px', color: '#BBB', textDecoration: 'line-through' }}>
                            {formatPrice(l.originalAmount)} GH₵
                          </div>
                      )}
                      <span style={{ fontWeight: '600' }}>{formatPrice(l.amount)} GH₵</span>
                    </span>
                  </div>
              ))}
              <div style={{ borderTop: '1px solid #EBEBEB', marginTop: '10px', paddingTop: '10px', display: 'flex', justifyContent: 'space-between', fontWeight: '600' }}>
                <span>Total</span><span>{formatPrice(receiptData.amount)} GH₵</span>
              </div>
              {receiptData.clientName && (
                  <div style={{ color: '#999', fontSize: '12px', marginTop: '6px' }}>Client: {receiptData.clientName}</div>
              )}
            </div>

            <button style={{ ...styles.submitBtn, marginBottom: '10px' }} onClick={() => printReceipt(receiptData)}>
              🖨️ Print receipt
            </button>
            <button style={{ ...styles.submitBtn, background: '#F5F5F5', color: '#1A1A1A' }} onClick={onClose}>
              Done
            </button>
          </div>
        </div>
    )
  }

  return (
      <div style={styles.overlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
        <div style={styles.modal}>
          <div style={styles.handle} />

          <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: '19px', color: '#1A1A1A', marginBottom: '18px' }}>
            🧺 Cart · {computedLines.length} item{computedLines.length !== 1 ? 's' : ''}
          </div>

          {/* Lignes du panier */}
          <div style={{ marginBottom: '20px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {computedLines.length === 0 && (
                <div style={{ fontSize: '13px', color: '#BBB', textAlign: 'center', padding: '20px 0' }}>Cart is empty</div>
            )}
            {computedLines.map((l, i) => (
                <div key={l.product.id} style={styles.cartLine}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div style={{ ...styles.productEmojiSm, background: (l.product.color ?? '#EEE') + '22' }}>
                      {l.product.emoji ?? '🍬'}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '13px', fontWeight: '500', color: '#1A1A1A' }}>{l.product.name}</div>
                      <div style={{ fontSize: '11.5px', color: '#999' }}>{formatPrice(l.effectiveUnitPrice)} GH₵ / unit</div>
                      {l.insufficientStock && (
                          <div style={{ fontSize: '11px', color: '#C45000' }}>⚠ You hold only {myStock[l.product.id] ?? 0}</div>
                      )}
                    </div>
                    <div style={styles.qtyControlSm}>
                      <button style={styles.qtyBtnSm} onClick={() => updateQty(l.product.id, Math.max(1, l.qty - 1))}>−</button>
                      <span style={styles.qtyValueSm}>{l.qty}</span>
                      <button style={styles.qtyBtnSm} onClick={() => updateQty(l.product.id, l.qty + 1)}>+</button>
                    </div>
                    <button onClick={() => removeLine(l.product.id)} style={styles.removeBtn} title="Remove from cart">✕</button>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '8px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11.5px', color: '#999', cursor: 'pointer' }}>
                      <input type="checkbox" checked={l.isDiscounted} onChange={e => updateDiscount(l.product.id, { isDiscounted: e.target.checked })} />
                      Discounted item
                    </label>
                    <span style={{ fontSize: '13px', fontWeight: '600', color: '#1A1A1A' }}>{formatPrice(l.total)} GH₵</span>
                  </div>

                  {l.isDiscounted && (
                      <div style={{ marginTop: '8px' }}>
                        <input
                            style={styles.inputSm}
                            type="number"
                            step="0.01"
                            inputMode="decimal"
                            placeholder={'New unit price (normally ' + formatPrice(l.product.price) + ')'}
                            value={l.discountedPrice}
                            onChange={e => updateDiscount(l.product.id, { discountedPrice: e.target.value })}
                        />
                        <input
                            style={{ ...styles.inputSm, marginTop: '6px' }}
                            placeholder="Reason (optional)"
                            value={l.discountReason}
                            onChange={e => updateDiscount(l.product.id, { discountReason: e.target.value })}
                        />
                        {l.discountInvalid && (
                            <div style={styles.warning}>⚠ Enter a price lower than {formatPrice(l.product.price)} GH₵</div>
                        )}
                      </div>
                  )}
                </div>
            ))}
          </div>

          {/* Client */}
          <div style={styles.fieldGroup}>
            <div style={styles.fieldLabel}>Client</div>
            {loadingClients ? (
                <div style={styles.loadingText}>Loading…</div>
            ) : (
                <>
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
            <span style={styles.totalValue}>{formatPrice(cartTotal)} GH₵</span>
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

          <button
              style={{
                ...styles.submitBtn,
                opacity: (loading || computedLines.length === 0 || (paymentType === 'dette' && !selectedClient) || creditNeedsClient || cashReceivedIsInsufficient || anyInsufficientStock || anyDiscountInvalid) ? 0.5 : 1,
                cursor: (loading || computedLines.length === 0 || (paymentType === 'dette' && !selectedClient) || creditNeedsClient || cashReceivedIsInsufficient || anyInsufficientStock || anyDiscountInvalid) ? 'not-allowed' : 'pointer',
              }}
              onClick={handleSubmit}
              disabled={loading || computedLines.length === 0 || (paymentType === 'dette' && !selectedClient) || creditNeedsClient || cashReceivedIsInsufficient || anyInsufficientStock || anyDiscountInvalid}
          >
            {loading ? 'Saving…' : anyInsufficientStock ? 'Not enough stock' : `Record sale · ${formatPrice(cartTotal)} GH₵`}
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
  cartLine: {
    background: '#FAFAFA', borderRadius: '14px', padding: '12px', border: '1px solid #F0F0F0',
  },
  productEmojiSm: {
    width: '38px', height: '38px', borderRadius: '10px',
    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px',
    flexShrink: 0,
  },
  qtyControlSm: {
    display: 'flex', alignItems: 'center',
    background: 'white', borderRadius: '10px', border: '1px solid #EBEBEB',
    overflow: 'hidden', flexShrink: 0,
  },
  qtyBtnSm: {
    width: '30px', height: '30px', border: 'none', background: 'none',
    fontSize: '16px', cursor: 'pointer', color: '#1A1A1A',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontWeight: '400', fontFamily: "'DM Sans', sans-serif",
  },
  qtyValueSm: {
    minWidth: '26px', textAlign: 'center',
    fontSize: '13px', fontWeight: '600', color: '#1A1A1A',
  },
  removeBtn: {
    background: 'none', border: 'none', color: '#CCC', fontSize: '13px',
    cursor: 'pointer', padding: '6px', flexShrink: 0,
  },
  fieldGroup: { marginBottom: '20px' },
  fieldLabel: {
    fontSize: '11.5px', fontWeight: '600', color: '#999',
    textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '8px',
  },
  loadingText: { fontSize: '13px', color: '#BBB' },
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
  inputSm: {
    width: '100%', padding: '10px 12px',
    borderRadius: '10px', border: '1.5px solid #EBEBEB',
    fontSize: '13px', fontFamily: "'DM Sans', sans-serif",
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
