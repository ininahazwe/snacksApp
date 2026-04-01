import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import NewProductModal from '../components/NewProductModal'

export default function ProduitsView({ onProductTap }) {
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [showNewProduct, setShowNewProduct] = useState(false)
  const [selectedCategory, setSelectedCategory] = useState('Toutes')

  useEffect(() => { fetchProducts() }, [])

  const fetchProducts = async () => {
    const { data } = await supabase.from('products').select('*').order('name')
    setProducts(data ?? [])
    setLoading(false)
  }

  const handleProductCreated = (product) => {
    setProducts(ps => [...ps, product].sort((a, b) => a.name.localeCompare(b.name)))
    setShowNewProduct(false)
  }

  // Récupérer toutes les catégories uniques
  const categories = ['Toutes', ...new Set(products.map(p => p.category || 'Autre')).sort()]

  // Filtrer par catégorie + recherche
  const filtered = products.filter(p => {
    const matchCategory = selectedCategory === 'Toutes' || p.category === selectedCategory
    const matchSearch = p.name.toLowerCase().includes(search.toLowerCase())
    return matchCategory && matchSearch
  })

  if (loading) return <div style={{color:'#999',fontSize:'14px',paddingTop:'20px',fontFamily:"'DM Sans',sans-serif"}}>Loading…</div>

  return (
      <div style={{fontFamily:"'DM Sans',sans-serif"}}>

        {/* Header avec titre + bouton New */}
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'16px'}}>
          <p style={{fontFamily:"'DM Serif Display',serif",fontSize:'18px',color:'#1A1A1A',margin:0}}>Products</p>
          <button
              onClick={() => setShowNewProduct(true)}
              style={{background:'#1A1A1A',color:'white',border:'none',borderRadius:'100px',padding:'8px 18px',fontSize:'13px',fontWeight:'500',cursor:'pointer',fontFamily:"'DM Sans',sans-serif",display:'flex',alignItems:'center',gap:'6px'}}
          >
            <span style={{fontSize:'16px',lineHeight:1}}>+</span> New
          </button>
        </div>

        {/* Tabs de catégories */}
        <div style={{display:'flex',gap:'8px',marginBottom:'16px',overflowX:'auto',paddingBottom:'4px',WebkitOverflowScrolling:'touch'}}>
          {categories.map(cat => (
              <button
                  key={cat}
                  onClick={() => setSelectedCategory(cat)}
                  style={{
                    padding:'8px 14px',
                    borderRadius:'100px',
                    border:'none',
                    background:selectedCategory===cat?'#1A1A1A':'white',
                    color:selectedCategory===cat?'white':'#999',
                    fontFamily:"'DM Sans',sans-serif",
                    fontSize:'13px',
                    fontWeight:'500',
                    cursor:'pointer',
                    whiteSpace:'nowrap',
                    transition:'all 0.2s ease',
                    borderWidth:'1px',
                    borderStyle:'solid',
                    borderColor:selectedCategory===cat?'#1A1A1A':'#EBEBEB',
                  }}
              >
                {cat}
              </button>
          ))}
        </div>

        {/* Barre de recherche */}
        <input
            style={{width:'100%',padding:'12px 16px',borderRadius:'12px',border:'1.5px solid #EBEBEB',fontSize:'14px',fontFamily:"'DM Sans',sans-serif",color:'#1A1A1A',outline:'none',marginBottom:'16px',boxSizing:'border-box',background:'white'}}
            placeholder="Search products…"
            value={search}
            onChange={e => setSearch(e.target.value)}
        />

        {/* Grille produits */}
        {filtered.length === 0 ? (
            <div style={{textAlign:'center',padding:'48px 24px',color:'#BBB',fontSize:'14px'}}>
              <div style={{fontSize:'32px',marginBottom:'12px'}}>📦</div>No products found
            </div>
        ) : (
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'12px'}}>
              {filtered.map(p => (
                  <div
                      key={p.id}
                      onClick={() => onProductTap && onProductTap(p)}
                      style={{background:'white',borderRadius:'18px',border:'1px solid rgba(0,0,0,0.05)',boxShadow:'0 2px 12px rgba(0,0,0,0.04)',padding:'16px',cursor:'pointer',transition:'all 0.2s ease'}}
                  >
                    <div style={{width:'44px',height:'44px',borderRadius:'12px',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'22px',marginBottom:'12px',background:(p.color??'#EEE')+'22'}}>
                      {p.emoji ?? '🍬'}
                    </div>
                    <div style={{fontSize:'13px',fontWeight:'500',color:'#1A1A1A',marginBottom:'6px',lineHeight:1.3}}>{p.name}</div>
                    <div style={{fontFamily:"'DM Serif Display',serif",fontSize:'15px',color:'#1A1A1A'}}>{p.price?.toLocaleString()} F</div>
                    <div style={{fontSize:'11px',marginTop:'3px',color:p.stock<10?'#C45000':'#999'}}>
                      {p.stock < 10 ? '⚠ ' : ''}{p.stock} in stock
                    </div>
                  </div>
              ))}
            </div>
        )}

        {/* Modal création produit sans code-barres */}
        {showNewProduct && (
            <NewProductModal
                barcode={null}
                onClose={() => setShowNewProduct(false)}
                onCreated={handleProductCreated}
            />
        )}
      </div>
  )
}