import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

const EMOJIS = ['🍬', '🍫', '🍭', '🍡', '🍩', '🧁', '🍪', '🍓', '🍋', '🥭', '🍑', '🍇']
const COLORS = ['#F5C842', '#E84B6E', '#5BAD72', '#C4A8E0', '#8B5E3C', '#F4845F', '#4ECDC4', '#2D2D2D']

export default function EditProductModal({ product, onClose, onUpdated, onDeleted }) {
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

    // Ajustement stock
    const [stockValue, setStockValue] = useState(String(product.stock))
    const [savingStock, setSavingStock] = useState(false)
    const [toastStock, setToastStock] = useState(null)

    // Suppression
    const [nbVentes, setNbVentes] = useState(null)
    const [loadingVentes, setLoadingVentes] = useState(true)
    const [confirmDelete, setConfirmDelete] = useState(false)
    const [deleting, setDeleting] = useState(false)

    useEffect(() => {
        fetchCategories()
        supabase
            .from('sales')
            .select('id', { count: 'exact', head: true })
            .eq('product_id', product.id)
            .then(({ count }) => { setNbVentes(count ?? 0); setLoadingVentes(false) })
    }, [])

    const fetchCategories = async () => {
        const { data } = await supabase.from('products').select('category')
        if (data) {
            const cats = Array.from(new Set(data.map(p => p.category || 'Autre'))).sort()
            setAllCategories(cats)
        }
    }

    const catSuggestions = allCategories.filter(c =>
        c.toLowerCase().includes(category.toLowerCase()) &&
        c.toLowerCase() !== category.toLowerCase()
    )
    const isNewCategory = category.trim() &&
        !allCategories.some(c => c.toLowerCase() === category.trim().toLowerCase())

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

    // ── Ajustement stock direct ──────────────────────────────────────────────
    const stockModifie = parseInt(stockValue, 10) !== product.stock && !isNaN(parseInt(stockValue, 10))

    const ajusterStock = async () => {
        const nouveau = parseInt(stockValue, 10)
        if (isNaN(nouveau) || nouveau < 0 || !stockModifie) return
        setSavingStock(true)
        const delta = nouveau - product.stock
        const { error } = await supabase
            .from('products')
            .update({ stock: nouveau })
            .eq('id', product.id)
        if (!error) {
            await supabase.from('stock_movements').insert({
                product_id: product.id,
                delta,
                reason: 'Manual adjustment',
            })
            setToastStock({ msg: 'Stock updated ✓', type: 'success' })
            setTimeout(() => setToastStock(null), 2500)
            // Mettre à jour le produit local sans fermer le modal
            product = { ...product, stock: nouveau }
            onUpdated({ ...product, stock: nouveau })
        } else {
            setToastStock({ msg: 'Error updating stock', type: 'danger' })
            setTimeout(() => setToastStock(null), 2500)
        }
        setSavingStock(false)
    }

    // ── Suppression ──────────────────────────────────────────────────────────
    const supprimerProduit = async () => {
        setDeleting(true)
        const { error } = await supabase.from('products').delete().eq('id', product.id)
        if (!error) {
            setToastStock({ msg: 'Product deleted', type: 'danger' })
            setTimeout(() => { onDeleted?.(product.id); onClose() }, 1400)
        } else {
            setToastStock({ msg: 'Error deleting product', type: 'danger' })
            setDeleting(false)
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

                {/* Toast */}
                {toastStock && (
                    <div style={{
                        background: toastStock.type === 'danger' ? '#CC3333' : '#2E7D42',
                        color: 'white', borderRadius: '12px', padding: '11px 16px',
                        fontSize: '13.5px', fontWeight: '500', marginBottom: '16px',
                        textAlign: 'center', fontFamily: "'DM Sans', sans-serif",
                    }}>
                        {toastStock.msg}
                    </div>
                )}

                {/* ── Section stock actuel ── */}
                <div style={styles.stockSection}>
                    <div style={styles.stockSectionLabel}>Current stock</div>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <button
                            style={styles.stepBtn}
                            onClick={() => setStockValue(v => String(Math.max(0, parseInt(v || '0', 10) - 1)))}
                        >−</button>
                        <input
                            style={{ ...styles.input, flex: 1, textAlign: 'center', fontSize: '18px', fontFamily: "'DM Serif Display', serif", padding: '10px 8px' }}
                            type="number"
                            inputMode="numeric"
                            min="0"
                            value={stockValue}
                            onChange={e => setStockValue(e.target.value)}
                        />
                        <button
                            style={styles.stepBtn}
                            onClick={() => setStockValue(v => String(parseInt(v || '0', 10) + 1))}
                        >+</button>
                        <button
                            style={{ ...styles.stockSaveBtn, opacity: (!stockModifie || savingStock) ? 0.4 : 1 }}
                            onClick={ajusterStock}
                            disabled={!stockModifie || savingStock}
                        >
                            {savingStock ? '…' : 'Save'}
                        </button>
                    </div>
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

                {/* ── Suppression ── */}
                <div style={{ marginTop: '20px', borderTop: '1px solid #F0F0F0', paddingTop: '20px' }}>
                    {loadingVentes ? (
                        <div style={{ fontSize: '12px', color: '#CCC', textAlign: 'center' }}>Checking sales…</div>
                    ) : nbVentes > 0 ? (
                        <div style={{ fontSize: '12px', color: '#BBB', textAlign: 'center', padding: '4px 0' }}>
                            {nbVentes} sale{nbVentes > 1 ? 's' : ''} recorded — this product cannot be deleted.
                        </div>
                    ) : !confirmDelete ? (
                        <button style={styles.deleteBtn} onClick={() => setConfirmDelete(true)}>
                            🗑 Delete product
                        </button>
                    ) : (
                        <div style={styles.confirmBox}>
                            <div style={styles.confirmText}>
                                Delete <strong>{product.name}</strong>? This cannot be undone.
                            </div>
                            <div style={{ display: 'flex', gap: '10px', marginTop: '12px' }}>
                                <button style={styles.confirmCancelBtn} onClick={() => setConfirmDelete(false)}>Cancel</button>
                                <button
                                    style={{ ...styles.confirmDeleteBtn, opacity: deleting ? 0.5 : 1 }}
                                    onClick={supprimerProduit}
                                    disabled={deleting}
                                >
                                    {deleting ? 'Deleting…' : 'Yes, delete'}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
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
    handle: { width: '36px', height: '4px', background: '#E0E0E0', borderRadius: '10px', margin: '10px auto 20px' },
    header: { marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' },
    title: { fontFamily: "'DM Serif Display', serif", fontSize: '20px', color: '#1A1A1A' },
    barcode: { fontSize: '12px', color: '#BBB', marginTop: '4px', fontFamily: 'monospace' },
    cancelBtn: { background: 'none', border: 'none', fontSize: '14px', fontWeight: '500', color: '#999', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", padding: '4px 0', flexShrink: 0 },
    stockSection: { background: '#F9F9F9', borderRadius: '14px', padding: '14px 14px 12px', marginBottom: '20px' },
    stockSectionLabel: { fontSize: '11px', fontWeight: '600', color: '#999', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '10px' },
    stepBtn: { width: '44px', height: '44px', background: 'white', border: '1.5px solid #EBEBEB', borderRadius: '10px', fontSize: '20px', color: '#1A1A1A', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
    stockSaveBtn: { padding: '0 16px', height: '44px', background: '#1A1A1A', color: 'white', border: 'none', borderRadius: '10px', fontSize: '13px', fontWeight: '500', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", flexShrink: 0 },
    fieldGroup: { marginBottom: '16px' },
    fieldLabel: { fontSize: '11.5px', fontWeight: '600', color: '#999', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '8px' },
    input: { width: '100%', padding: '13px 16px', borderRadius: '12px', border: '1.5px solid #EBEBEB', fontSize: '15px', fontFamily: "'DM Sans', sans-serif", color: '#1A1A1A', outline: 'none', boxSizing: 'border-box' },
    catDropdown: { position: 'absolute', top: '100%', left: 0, right: 0, background: 'white', borderRadius: '12px', border: '1.5px solid #EBEBEB', boxShadow: '0 8px 24px rgba(0,0,0,0.1)', zIndex: 10, marginTop: '4px', maxHeight: '160px', overflowY: 'auto' },
    catOption: { padding: '11px 16px', fontSize: '14px', color: '#1A1A1A', cursor: 'pointer', borderBottom: '1px solid rgba(0,0,0,0.04)' },
    catNewHint: { fontSize: '12px', color: '#2E7D42', marginTop: '6px', padding: '6px 10px', background: '#F0FBF3', borderRadius: '8px' },
    emojiGrid: { display: 'flex', flexWrap: 'wrap', gap: '8px' },
    emojiBtn: { width: '40px', height: '40px', border: 'none', borderRadius: '10px', fontSize: '20px', cursor: 'pointer', transition: 'all 0.15s' },
    colorGrid: { display: 'flex', gap: '10px', flexWrap: 'wrap' },
    colorBtn: { width: '28px', height: '28px', borderRadius: '50%', cursor: 'pointer', transition: 'all 0.15s' },
    preview: { display: 'flex', alignItems: 'center', gap: '14px', background: '#F9F9F9', borderRadius: '16px', padding: '14px', marginBottom: '20px' },
    previewEmoji: { width: '48px', height: '48px', borderRadius: '14px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '24px', flexShrink: 0 },
    previewName: { fontWeight: '500', fontSize: '15px', color: '#1A1A1A' },
    previewPrice: { fontSize: '13px', color: '#999', marginTop: '2px' },
    submitBtn: { width: '100%', padding: '16px', background: '#1A1A1A', color: 'white', border: 'none', borderRadius: '16px', fontFamily: "'DM Sans', sans-serif", fontSize: '15px', fontWeight: '500', cursor: 'pointer' },
    deleteBtn: { width: '100%', padding: '13px', background: 'none', border: '1.5px solid #FFE5E5', borderRadius: '14px', color: '#CC3333', fontSize: '13px', fontWeight: '500', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
    confirmBox: { background: '#FFF5F5', borderRadius: '14px', padding: '16px' },
    confirmText: { fontSize: '13.5px', color: '#1A1A1A', lineHeight: 1.5 },
    confirmCancelBtn: { flex: 1, padding: '11px', background: '#F0F0F0', border: 'none', borderRadius: '12px', fontSize: '13px', fontWeight: '500', color: '#666', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
    confirmDeleteBtn: { flex: 1, padding: '11px', background: '#CC3333', border: 'none', borderRadius: '12px', fontSize: '13px', fontWeight: '500', color: 'white', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
}