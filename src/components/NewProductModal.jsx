import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

const EMOJIS = ['🍬', '🍫', '🍭', '🍡', '🍩', '🧁', '🍪', '🍓', '🍋', '🥭', '🍑', '🍇']
const COLORS = ['#F5C842', '#E84B6E', '#5BAD72', '#C4A8E0', '#8B5E3C', '#F4845F', '#4ECDC4', '#2D2D2D']

export default function NewProductModal({ barcode, onClose, onCreated }) {
  const [name, setName] = useState('')
  const [price, setPrice] = useState('')
  const [stock, setStock] = useState('')
  const [emoji, setEmoji] = useState('🍬')
  const [color, setColor] = useState('#F5C842')
  const [loading, setLoading] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [offResult, setOffResult] = useState(null) // Open Food Facts result

  // Chercher automatiquement sur Open Food Facts au montage
  useEffect(() => {
    if (barcode) fetchFromOpenFoodFacts(barcode)
  }, [barcode])

  const fetchFromOpenFoodFacts = async (code) => {
    setFetching(true)
    try {
      const res = await fetch(`https://world.openfoodfacts.org/api/v0/product/${code}.json`)
      const data = await res.json()
      if (data.status === 1 && data.product) {
        const p = data.product
        const productName = p.product_name_fr || p.product_name || p.abbreviated_product_name || ''
        if (productName) {
          setName(productName)
          setOffResult({ name: productName, brand: p.brands })
        }
      }
    } catch (e) {
      // Pas grave si l'API échoue — l'utilisateur saisit manuellement
    } finally {
      setFetching(false)
    }
  }

  const handleSubmit = async () => {
    if (!name || !price) return
    setLoading(true)
    try {
      const { data, error } = await supabase.from('products').insert({
        name: name.trim(),
        price: parseInt(price),
        stock: parseInt(stock) || 0,
        barcode: barcode || null,
        emoji,
        color,
      }).select().single()

      if (error) throw error
      onCreated(data)
    } catch (err) {
      console.error('Erreur création produit:', err)
      alert('Erreur lors de la création du produit.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={styles.overlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={styles.modal}>
        <div style={styles.handle} />

        <div style={styles.header}>
          <div>
            <div style={styles.title}>New product</div>
            {barcode && <div style={styles.barcode}>Barcode: {barcode}</div>}
          </div>
          <button style={styles.cancelBtn} onClick={onClose}>Cancel</button>
        </div>

        {/* Résultat Open Food Facts */}
        {fetching && (
          <div style={styles.offLoading}>🔍 Recherche sur Open Food Facts…</div>
        )}
        {offResult && !fetching && (
          <div style={styles.offResult}>
            ✓ Trouvé sur Open Food Facts
            {offResult.brand && <span style={styles.offBrand}> · {offResult.brand}</span>}
          </div>
        )}

        {/* Nom */}
        <div style={styles.fieldGroup}>
          <div style={styles.fieldLabel}>Nom du produit *</div>
          <input
            style={styles.input}
            placeholder="Ex : Caramel Fleur de Sel"
            value={name}
            onChange={e => setName(e.target.value)}
          />
        </div>

        {/* Prix + Stock */}
        <div style={{ display: 'flex', gap: '12px' }}>
          <div style={{ ...styles.fieldGroup, flex: 1 }}>
            <div style={styles.fieldLabel}>Prix (F CFA) *</div>
            <input
              style={styles.input}
              type="number"
              placeholder="500"
              value={price}
              onChange={e => setPrice(e.target.value)}
            />
          </div>
          <div style={{ ...styles.fieldGroup, flex: 1 }}>
            <div style={styles.fieldLabel}>Stock initial</div>
            <input
              style={styles.input}
              type="number"
              placeholder="0"
              value={stock}
              onChange={e => setStock(e.target.value)}
            />
          </div>
        </div>

        {/* Emoji */}
        <div style={styles.fieldGroup}>
          <div style={styles.fieldLabel}>Icône</div>
          <div style={styles.emojiGrid}>
            {EMOJIS.map(e => (
              <button
                key={e}
                style={{
                  ...styles.emojiBtn,
                  background: emoji === e ? '#1A1A1A' : '#F5F5F5',
                  transform: emoji === e ? 'scale(1.15)' : 'scale(1)',
                }}
                onClick={() => setEmoji(e)}
              >
                {e}
              </button>
            ))}
          </div>
        </div>

        {/* Couleur */}
        <div style={styles.fieldGroup}>
          <div style={styles.fieldLabel}>Couleur</div>
          <div style={styles.colorGrid}>
            {COLORS.map(c => (
              <button
                key={c}
                style={{
                  ...styles.colorBtn,
                  background: c,
                  border: color === c ? '2.5px solid #1A1A1A' : '2.5px solid transparent',
                  transform: color === c ? 'scale(1.2)' : 'scale(1)',
                }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
        </div>

        {/* Aperçu */}
        <div style={styles.preview}>
          <div style={{ ...styles.previewEmoji, background: color + '22' }}>{emoji}</div>
          <div>
            <div style={styles.previewName}>{name || 'Nom du produit'}</div>
            <div style={styles.previewPrice}>{price ? parseInt(price).toLocaleString() + ' F CFA' : '— F CFA'}</div>
          </div>
        </div>

        <button
          style={{
            ...styles.submitBtn,
            opacity: (!name || !price || loading) ? 0.5 : 1,
          }}
          onClick={handleSubmit}
          disabled={!name || !price || loading}
        >
          {loading ? 'Enregistrement…' : 'Créer le produit'}
        </button>
      </div>
    </div>
  )
}

const styles = {
  overlay: {
    position: 'fixed', inset: 0,
    background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)',
    zIndex: 200, display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
  },
  modal: {
    background: 'white', borderRadius: '28px 28px 0 0',
    padding: '8px 24px 40px',
    width: '100%', maxWidth: '430px',
    maxHeight: '92vh', overflowY: 'auto',
    fontFamily: "'DM Sans', sans-serif",
  },
  handle: {
    width: '36px', height: '4px', background: '#E0E0E0',
    borderRadius: '10px', margin: '10px auto 20px',
  },
  header: { marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' },
  title: {
    fontFamily: "'DM Serif Display', serif",
    fontSize: '20px', color: '#1A1A1A',
  },
  barcode: { fontSize: '12px', color: '#BBB', marginTop: '4px', fontFamily: 'monospace' },
  cancelBtn: {
    background: 'none', border: 'none', fontSize: '14px', fontWeight: '500',
    color: '#999', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
    padding: '4px 0', flexShrink: 0,
  },
  offLoading: {
    fontSize: '13px', color: '#999', background: '#F9F9F9',
    borderRadius: '10px', padding: '10px 14px', marginBottom: '16px',
  },
  offResult: {
    fontSize: '13px', color: '#2E7D42', background: '#F0FBF3',
    borderRadius: '10px', padding: '10px 14px', marginBottom: '16px',
    fontWeight: '500',
  },
  offBrand: { color: '#5BAD72', fontWeight: '400' },
  fieldGroup: { marginBottom: '16px' },
  fieldLabel: {
    fontSize: '11.5px', fontWeight: '600', color: '#999',
    textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '8px',
  },
  input: {
    width: '100%', padding: '13px 16px',
    borderRadius: '12px', border: '1.5px solid #EBEBEB',
    fontSize: '15px', fontFamily: "'DM Sans', sans-serif",
    color: '#1A1A1A', outline: 'none', boxSizing: 'border-box',
  },
  emojiGrid: { display: 'flex', flexWrap: 'wrap', gap: '8px' },
  emojiBtn: {
    width: '40px', height: '40px', border: 'none', borderRadius: '10px',
    fontSize: '20px', cursor: 'pointer', transition: 'all 0.15s',
  },
  colorGrid: { display: 'flex', gap: '10px', flexWrap: 'wrap' },
  colorBtn: {
    width: '28px', height: '28px', borderRadius: '50%',
    cursor: 'pointer', transition: 'all 0.15s',
  },
  preview: {
    display: 'flex', alignItems: 'center', gap: '14px',
    background: '#F9F9F9', borderRadius: '16px',
    padding: '14px', marginBottom: '20px',
  },
  previewEmoji: {
    width: '48px', height: '48px', borderRadius: '14px',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: '24px', flexShrink: 0,
  },
  previewName: { fontWeight: '500', fontSize: '15px', color: '#1A1A1A' },
  previewPrice: { fontSize: '13px', color: '#999', marginTop: '2px' },
  submitBtn: {
    width: '100%', padding: '16px', background: '#1A1A1A', color: 'white',
    border: 'none', borderRadius: '16px', fontFamily: "'DM Sans', sans-serif",
    fontSize: '15px', fontWeight: '500', cursor: 'pointer',
  },
}
