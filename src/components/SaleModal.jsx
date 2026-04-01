import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

export default function SaleModal({ product, onClose, onSuccess }) {
  const [qty, setQty] = useState(1)
  const [selectedClient, setSelectedClient] = useState(null)
  const [paymentType, setPaymentType] = useState('cash')
  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(false)
  const [loadingClients, setLoadingClients] = useState(true)

  useEffect(() => {
    fetchClients()
  }, [])

  const fetchClients = async () => {
    const { data } = await supabase.from('clients').select('*').order('name')
    setClients(data ?? [])
    setLoadingClients(false)
  }

  const total = product.price * qty

  const handleSubmit = async () => {
    setLoading(true)
    try {
      // 1. Enregistrer la vente
      const { error: saleError } = await supabase.from('sales').insert({
        product_id: product.id,
        client_id: selectedClient?.id ?? null,
        qty,
        amount: total,
        type: paymentType,
      })
      if (saleError) throw saleError

      // 2. Décrémenter le stock du produit
      const { error: stockError } = await supabase
        .from('products')
        .update({ stock: product.stock - qty })
        .eq('id', product.id)
      if (stockError) throw stockError

      // 3. Enregistrer le mouvement de stock
      await supabase.from('stock_movements').insert({
        product_id: product.id,
        delta: -qty,
        reason: 'vente',
      })

      // 4. Si dette, incrémenter la dette du client
      if (paymentType === 'dette' && selectedClient) {
        await supabase
          .from('clients')
          .update({ debt: (selectedClient.debt ?? 0) + total })
          .eq('id', selectedClient.id)
      }

      onSuccess(`✓ Vente enregistrée — ${total.toLocaleString()} F CFA`)
    } catch (err) {
      console.error('Erreur vente:', err)
      alert('Erreur lors de l\'enregistrement. Réessaie.')
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
            <div style={styles.productPrice}>{product.price.toLocaleString()} F CFA · unité</div>
          </div>
        </div>

        {/* Quantité */}
        <div style={styles.fieldGroup}>
          <div style={styles.fieldLabel}>Quantité</div>
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
            <div style={styles.loadingText}>Chargement…</div>
          ) : (
            <div style={styles.clientList}>
              {clients.map(c => (
                <div
                  key={c.id}
                  style={{
                    ...styles.clientOption,
                    borderColor: selectedClient?.id === c.id ? '#1A1A1A' : '#EBEBEB',
                    background: selectedClient?.id === c.id ? '#FAFAFA' : 'white',
                  }}
                  onClick={() => setSelectedClient(selectedClient?.id === c.id ? null : c)}
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
                    <span style={styles.debtBadge}>−{c.debt.toLocaleString()} F</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Mode de paiement */}
        <div style={styles.fieldGroup}>
          <div style={styles.fieldLabel}>Mode de paiement</div>
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
              <div style={styles.paymentLabel}>Paiement direct</div>
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
              <div style={styles.paymentLabel}>Mettre en dette</div>
            </div>
          </div>
          {paymentType === 'dette' && !selectedClient && (
            <div style={styles.warning}>⚠ Sélectionne un client pour enregistrer une dette</div>
          )}
        </div>

        {/* Total */}
        <div style={styles.totalLine}>
          <span style={styles.totalLabel}>Total</span>
          <span style={styles.totalValue}>{total.toLocaleString()} F CFA</span>
        </div>

        {/* Bouton */}
        <button
          style={{
            ...styles.submitBtn,
            opacity: (loading || (paymentType === 'dette' && !selectedClient)) ? 0.5 : 1,
            cursor: (loading || (paymentType === 'dette' && !selectedClient)) ? 'not-allowed' : 'pointer',
          }}
          onClick={handleSubmit}
          disabled={loading || (paymentType === 'dette' && !selectedClient)}
        >
          {loading ? 'Enregistrement…' : 'Enregistrer la vente'}
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
}
