import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { formatPrice } from '../lib/format'

/**
 * EditProductModal
 * Utilisé par StocksView (ajout batch) ET ProduitsView (via long-press ou bouton dédié).
 *
 * Props :
 *   product    – objet produit complet
 *   onClose    – fermer sans changement
 *   onUpdated  – (updatedProduct) => void  appelé après modif stock
 *   onDeleted  – (productId) => void       appelé après suppression (optionnel)
 */
export default function EditProductModal({ product, onClose, onUpdated, onDeleted }) {
    // ── Ajout batch (usage StocksView) ──────────────────────────────────────────
    const [nouvelleQte, setNouvelleQte] = useState('')
    const [savingBatch, setSavingBatch] = useState(false)

    // ── Ajustement stock direct ──────────────────────────────────────────────────
    const [stockValue, setStockValue] = useState(String(product.stock))
    const [savingStock, setSavingStock] = useState(false)

    // ── Suppression ──────────────────────────────────────────────────────────────
    const [nbVentes, setNbVentes] = useState(null)
    const [loadingVentes, setLoadingVentes] = useState(true)
    const [confirmDelete, setConfirmDelete] = useState(false)
    const [deleting, setDeleting] = useState(false)

    // ── Toast ────────────────────────────────────────────────────────────────────
    const [toast, setToast] = useState(null) // { msg, type: 'success'|'danger' }

    useEffect(() => {
        supabase
            .from('sales')
            .select('id', { count: 'exact', head: true })
            .eq('product_id', product.id)
            .then(({ count }) => {
                setNbVentes(count ?? 0)
                setLoadingVentes(false)
            })
    }, [product.id])

    const afficherToast = (msg, type = 'success') => {
        setToast({ msg, type })
        setTimeout(() => setToast(null), 2500)
    }

    // ── Enregistrer un batch de réception ───────────────────────────────────────
    const enregistrerBatch = async () => {
        const qty = parseInt(nouvelleQte)
        if (!qty || qty <= 0) return
        setSavingBatch(true)
        try {
            const { data: newBatch, error: batchError } = await supabase
                .from('stock_batches')
                .insert({
                    product_id: product.id,
                    received_qty: qty,
                    received_at: new Date().toISOString(),
                })
                .select()
                .single()
            if (batchError) throw batchError

            const nouveauStock = product.stock + qty
            const { error: stockError } = await supabase
                .from('products')
                .update({ stock: nouveauStock })
                .eq('id', product.id)
            if (stockError) throw stockError

            await supabase.from('stock_movements').insert({
                product_id: product.id,
                batch_id: newBatch.id,
                delta: qty,
                reason: 'reception_carton',
            })

            afficherToast(`+${qty} units added ✓`)
            setNouvelleQte('')
            onUpdated({ ...product, stock: nouveauStock })
        } catch (err) {
            console.error(err)
            afficherToast('Error saving batch', 'danger')
        } finally {
            setSavingBatch(false)
        }
    }

    // ── Ajuster le stock directement ────────────────────────────────────────────
    const ajusterStock = async () => {
        const nouveau = parseInt(stockValue, 10)
        if (isNaN(nouveau) || nouveau < 0 || nouveau === product.stock) return
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
            afficherToast('Stock updated ✓')
            onUpdated({ ...product, stock: nouveau })
        } else {
            afficherToast('Error updating stock', 'danger')
        }
        setSavingStock(false)
    }

    // ── Supprimer le produit ─────────────────────────────────────────────────────
    const supprimerProduit = async () => {
        setDeleting(true)
        const { error } = await supabase
            .from('products')
            .delete()
            .eq('id', product.id)
        if (!error) {
            afficherToast('Product deleted', 'danger')
            setTimeout(() => {
                onDeleted?.(product.id)
                onClose()
            }, 1400)
        } else {
            afficherToast('Error deleting product', 'danger')
            setDeleting(false)
        }
    }

    const stockModifie = parseInt(stockValue, 10) !== product.stock && !isNaN(parseInt(stockValue, 10))

    return (
        <div style={s.overlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
            <div style={s.modal}>
                <div style={s.handle} />

                {/* Toast */}
                {toast && (
                    <div style={{
                        background: toast.type === 'danger' ? '#CC3333' : '#2E7D42',
                        color: 'white', borderRadius: '12px', padding: '11px 16px',
                        fontSize: '13.5px', fontWeight: '500', marginBottom: '16px',
                        textAlign: 'center', fontFamily: "'DM Sans', sans-serif",
                    }}>
                        {toast.msg}
                    </div>
                )}

                {/* En-tête */}
                <div style={s.modalHeader}>
                    <div style={{ ...s.prodEmoji, background: (product.color ?? '#EEE') + '22' }}>
                        {product.emoji ?? '🍬'}
                    </div>
                    <div>
                        <div style={s.modalNom}>{product.name}</div>
                        <div style={s.modalStock}>
                            {formatPrice(product.price)} GH₵ · <strong>{product.stock}</strong> in stock
                        </div>
                    </div>
                </div>

                {/* ── Section 1 : ajout batch ── */}
                <div style={s.section}>
                    <div style={s.fieldLabel}>Receive a new box</div>
                    <input
                        style={s.input}
                        type="number"
                        inputMode="numeric"
                        placeholder="Ex: 100"
                        value={nouvelleQte}
                        onChange={e => setNouvelleQte(e.target.value)}
                        onClick={e => e.stopPropagation()}
                        autoFocus
                    />
                    {nouvelleQte && parseInt(nouvelleQte) > 0 && (
                        <div style={s.preview}>
                            New total: <strong>{product.stock + parseInt(nouvelleQte)} units</strong>
                        </div>
                    )}
                    <div style={s.shortcutRow}>
                        {[50, 100, 150, 200].map(n => (
                            <button
                                key={n}
                                style={s.shortcut}
                                onClick={e => { e.stopPropagation(); setNouvelleQte(String(n)) }}
                            >
                                +{n}
                            </button>
                        ))}
                    </div>
                    <button
                        style={{ ...s.submitBtn, opacity: (!nouvelleQte || parseInt(nouvelleQte) <= 0 || savingBatch) ? 0.4 : 1 }}
                        onClick={e => { e.stopPropagation(); enregistrerBatch() }}
                        disabled={!nouvelleQte || parseInt(nouvelleQte) <= 0 || savingBatch}
                    >
                        {savingBatch ? 'Saving…' : 'Register batch'}
                    </button>
                </div>

                {/* ── Section 2 : ajustement stock direct ── */}
                <div style={{ ...s.section, borderTop: '1px solid #F0F0F0', paddingTop: '20px' }}>
                    <div style={s.fieldLabel}>Adjust current stock</div>
                    <div style={{ display: 'flex', gap: '10px', marginBottom: '12px' }}>
                        <button
                            style={s.stepBtn}
                            onClick={() => setStockValue(v => String(Math.max(0, parseInt(v || '0', 10) - 1)))}
                        >−</button>
                        <input
                            style={{ ...s.input, flex: 1, fontSize: '20px', fontFamily: "'DM Serif Display', serif", textAlign: 'center', marginBottom: 0 }}
                            type="number"
                            inputMode="numeric"
                            min="0"
                            value={stockValue}
                            onChange={e => setStockValue(e.target.value)}
                        />
                        <button
                            style={s.stepBtn}
                            onClick={() => setStockValue(v => String(parseInt(v || '0', 10) + 1))}
                        >+</button>
                    </div>
                    <button
                        style={{ ...s.submitBtn, background: '#555', opacity: (!stockModifie || savingStock) ? 0.4 : 1 }}
                        onClick={ajusterStock}
                        disabled={!stockModifie || savingStock}
                    >
                        {savingStock ? 'Saving…' : 'Update stock'}
                    </button>
                </div>

                {/* ── Section 3 : suppression ── */}
                <div style={{ borderTop: '1px solid #F0F0F0', paddingTop: '20px', marginTop: '4px' }}>
                    {loadingVentes ? (
                        <div style={{ fontSize: '12px', color: '#CCC', textAlign: 'center' }}>Checking sales…</div>
                    ) : nbVentes > 0 ? (
                        <div style={{ fontSize: '12px', color: '#BBB', textAlign: 'center', padding: '4px 0' }}>
                            {nbVentes} sale{nbVentes > 1 ? 's' : ''} recorded — this product cannot be deleted.
                        </div>
                    ) : !confirmDelete ? (
                        <button style={s.deleteBtn} onClick={() => setConfirmDelete(true)}>
                            🗑 Delete product
                        </button>
                    ) : (
                        <div style={s.confirmBox}>
                            <div style={s.confirmText}>
                                Delete <strong>{product.name}</strong>? This cannot be undone.
                            </div>
                            <div style={{ display: 'flex', gap: '10px', marginTop: '12px' }}>
                                <button style={s.confirmCancelBtn} onClick={() => setConfirmDelete(false)}>Cancel</button>
                                <button
                                    style={{ ...s.confirmDeleteBtn, opacity: deleting ? 0.5 : 1 }}
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

const s = {
    overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(4px)', zIndex: 100, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
    modal: { background: 'white', borderRadius: '28px 28px 0 0', padding: '8px 24px 48px', width: '100%', maxWidth: '430px', maxHeight: '90vh', overflowY: 'auto', fontFamily: "'DM Sans', sans-serif" },
    handle: { width: '36px', height: '4px', background: '#E0E0E0', borderRadius: '10px', margin: '10px auto 20px' },
    modalHeader: { display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '20px' },
    prodEmoji: { width: '52px', height: '52px', borderRadius: '14px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '26px', flexShrink: 0 },
    modalNom: { fontFamily: "'DM Serif Display', serif", fontSize: '20px', color: '#1A1A1A' },
    modalStock: { fontSize: '13px', color: '#999', marginTop: '2px' },
    section: { marginBottom: '20px' },
    fieldLabel: { fontSize: '11.5px', fontWeight: '600', color: '#999', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '10px' },
    input: { width: '100%', padding: '13px 16px', borderRadius: '12px', border: '1.5px solid #EBEBEB', fontSize: '15px', fontFamily: "'DM Sans', sans-serif", color: '#1A1A1A', outline: 'none', boxSizing: 'border-box', marginBottom: '8px' },
    preview: { fontSize: '13px', color: '#999', marginBottom: '12px', padding: '8px 12px', background: '#F9F9F9', borderRadius: '8px' },
    shortcutRow: { display: 'flex', gap: '8px', marginBottom: '12px' },
    shortcut: { flex: 1, padding: '10px', background: '#F5F5F5', border: 'none', borderRadius: '10px', fontSize: '13px', fontWeight: '500', color: '#1A1A1A', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
    submitBtn: { width: '100%', padding: '15px', background: '#1A1A1A', color: 'white', border: 'none', borderRadius: '16px', fontFamily: "'DM Sans', sans-serif", fontSize: '15px', fontWeight: '500', cursor: 'pointer' },
    stepBtn: { width: '50px', height: '50px', background: '#F5F5F5', border: 'none', borderRadius: '12px', fontSize: '22px', color: '#1A1A1A', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'DM Sans', sans-serif", flexShrink: 0 },
    deleteBtn: { width: '100%', padding: '13px', background: 'none', border: '1.5px solid #FFE5E5', borderRadius: '14px', color: '#CC3333', fontSize: '13px', fontWeight: '500', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
    confirmBox: { background: '#FFF5F5', borderRadius: '14px', padding: '16px' },
    confirmText: { fontSize: '13.5px', color: '#1A1A1A', lineHeight: 1.5 },
    confirmCancelBtn: { flex: 1, padding: '11px', background: '#F0F0F0', border: 'none', borderRadius: '12px', fontSize: '13px', fontWeight: '500', color: '#666', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
    confirmDeleteBtn: { flex: 1, padding: '11px', background: '#CC3333', border: 'none', borderRadius: '12px', fontSize: '13px', fontWeight: '500', color: 'white', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
}