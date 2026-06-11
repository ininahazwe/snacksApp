import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

const EMOJIS = ['🍬', '🍫', '🍭', '🍡', '🍩', '🧁', '🍪', '🍓', '🍋', '🥭', '🍑', '🍇']
const COLORS = ['#F5C842', '#E84B6E', '#5BAD72', '#C4A8E0', '#8B5E3C', '#F4845F', '#4ECDC4', '#2D2D2D']

export default function EditProductModal({ product, onClose, onUpdated }) {
    // Champs pré-remplis avec les valeurs actuelles du produit
    const [name, setName] = useState(product.name ?? '')
    const [price, setPrice] = useState(product.price != null ? String(product.price) : '')
    const [cost, setCost] = useState(product.cost != null && product.cost !== 0 ? String(product.cost) : '')
    const [category, setCategory] = useState(product.category ?? 'Autre')
    const [emoji, setEmoji] = useState(product.emoji ?? '🍬')
    const [color, setColor] = useState(product.color ?? '#F5C842')
    const [loading, setLoading] = useState(false)

    // Autocomplete catégories
    const [allCategories, setAllCategories] = useState([])
    const [showCatSuggestions, setShowCatSuggestions] = useState(false)

    useEffect(() => {
        fetchCategories()
    }, [])

    const fetchCategories = async () => {
        const { data } = await supabase.from('products').select('category')
        if (data) {
            const cats = Array.from(new Set(data.map(p => p.category || 'Autre'))).sort()
            setAllCategories(cats)
        }
    }

    // Suggestions : catégories existantes qui matchent la saisie
    const catSuggestions = allCategories.filter(c =>
        c.toLowerCase().includes(category.toLowerCase()) &&
        c.toLowerCase() !== category.toLowerCase()
    )
    const isNewCategory = category.trim() &&
        !allCategories.some(c => c.toLowerCase() === category.trim().toLowerCase())

    // Détecter si quelque chose a changé (pour désactiver le bouton sinon)
    const hasChanges =
        name.trim() !== product.name ||
        parseFloat(price) !== product.price ||
        (parseFloat(cost) || 0) !== (product.cost ?? 0) ||
        category.trim() !== (product.category ?? 'Autre') ||
        emoji !== (product.emoji ?? '🍬') ||
        color !== (product.color ?? '#F5C842')

    const handleSubmit = async () => {
        if (!name || !price) return
        setLoading(true)
        try {
            const { data, error } = await supabase
                .from('products')
                .update({
                    name: name.trim(),
                    price: parseFloat(price),
                    cost: parseFloat(cost) || 0,
                    category: category.trim() || 'Autre',
                    emoji,
                    color,
                })
                .eq('id', product.id)
                .select()
                .single()

            if (error) throw error
            onUpdated(data)
        } catch (err) {
            console.error('Erreur mise à jour produit:', err)
            alert('Erreur lors de la mise à jour du produit.')
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
                        <div style={styles.title}>Edit product</div>
                        {product.barcode && <div style={styles.barcode}>Barcode: {product.barcode}</div>}
                    </div>
                    <button style={styles.cancelBtn} onClick={onClose}>Cancel</button>
                </div>

                {/* Note : le stock ne s'édite pas ici — il se gère via les batchs */}
                <div style={styles.stockNote}>
                    📦 Current stock: <strong>{product.stock}</strong> units — managed via batches
                </div>

                {/* Nom */}
                <div style={styles.fieldGroup}>
                    <div style={styles.fieldLabel}>Name *</div>
                    <input
                        style={styles.input}
                        placeholder="Ex : Caramel Fleur de Sel"
                        value={name}
                        onChange={e => setName(e.target.value)}
                    />
                </div>

                {/* Catégorie avec autocomplete */}
                <div style={{ ...styles.fieldGroup, position: 'relative' }}>
                    <div style={styles.fieldLabel}>Category</div>
                    <input
                        style={styles.input}
                        placeholder="Ex : Bonbons, Chocolats, Caramels, etc."
                        value={category}
                        onChange={e => { setCategory(e.target.value); setShowCatSuggestions(true) }}
                        onFocus={() => setShowCatSuggestions(true)}
                        onBlur={() => setShowCatSuggestions(false)}
                    />
                    {showCatSuggestions && catSuggestions.length > 0 && (
                        <div style={styles.catDropdown}>
                            {catSuggestions.map(c => (
                                <div
                                    key={c}
                                    style={styles.catOption}
                                    // onMouseDown (pas onClick) : se déclenche AVANT le blur de l'input
                                    onMouseDown={e => { e.preventDefault(); setCategory(c); setShowCatSuggestions(false) }}
                                >
                                    {c}
                                </div>
                            ))}
                        </div>
                    )}
                    {isNewCategory && (
                        <div style={styles.catNewHint}>✨ New category "{category.trim()}" will be created</div>
                    )}
                </div>

                {/* Prix vente + Prix achat */}
                <div style={{ display: 'flex', gap: '12px' }}>
                    <div style={{ ...styles.fieldGroup, flex: 1 }}>
                        <div style={styles.fieldLabel}>Selling price (GH₵) *</div>
                        <input
                            style={styles.input}
                            type="number"
                            step="0.01"
                            inputMode="decimal"
                            placeholder="3.50"
                            value={price}
                            onChange={e => setPrice(e.target.value)}
                        />
                    </div>
                    <div style={{ ...styles.fieldGroup, flex: 1 }}>
                        <div style={styles.fieldLabel}>Buying price (GH₵)</div>
                        <input
                            style={styles.input}
                            type="number"
                            step="0.01"
                            inputMode="decimal"
                            placeholder="3.10"
                            value={cost}
                            onChange={e => setCost(e.target.value)}
                        />
                    </div>
                </div>

                {/* Emoji */}
                <div style={styles.fieldGroup}>
                    <div style={styles.fieldLabel}>Icon</div>
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
                    <div style={styles.fieldLabel}>Colour</div>
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
                        <div style={styles.previewName}>{name || 'Product name'}</div>
                        <div style={styles.previewPrice}>
                            {price ? parseFloat(price).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' GH₵' : '— GH₵'}
                        </div>
                    </div>
                </div>

                <button
                    style={{
                        ...styles.submitBtn,
                        opacity: (!name || !price || loading || !hasChanges) ? 0.5 : 1,
                    }}
                    onClick={handleSubmit}
                    disabled={!name || !price || loading || !hasChanges}
                >
                    {loading ? 'Saving…' : 'Save changes'}
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
        animation: 'overlayIn 0.2s ease',
    },
    modal: {
        background: 'white', borderRadius: '28px 28px 0 0',
        padding: '8px 24px 40px',
        width: '100%', maxWidth: '430px',
        maxHeight: '92vh', overflowY: 'auto',
        fontFamily: "'DM Sans', sans-serif",
        animation: 'modalUp 0.3s cubic-bezier(0.34,1.56,0.64,1)',
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
    stockNote: {
        fontSize: '13px', color: '#999', background: '#F9F9F9',
        borderRadius: '10px', padding: '10px 14px', marginBottom: '16px',
    },
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
    catDropdown: {
        position: 'absolute', top: '100%', left: 0, right: 0,
        background: 'white', borderRadius: '12px',
        border: '1.5px solid #EBEBEB',
        boxShadow: '0 8px 24px rgba(0,0,0,0.1)',
        zIndex: 10, marginTop: '4px',
        maxHeight: '160px', overflowY: 'auto',
    },
    catOption: {
        padding: '11px 16px', fontSize: '14px', color: '#1A1A1A',
        cursor: 'pointer', borderBottom: '1px solid rgba(0,0,0,0.04)',
    },
    catNewHint: {
        fontSize: '12px', color: '#2E7D42', marginTop: '6px',
        padding: '6px 10px', background: '#F0FBF3', borderRadius: '8px',
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