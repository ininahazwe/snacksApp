import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export default function ProduitsView({ onProductTap }) {
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  useEffect(() => { fetchProducts() }, [])

  const fetchProducts = async () => {
    const { data } = await supabase.from('products').select('*').order('name')
    setProducts(data ?? [])
    setLoading(false)
  }

  const filtered = products.filter(p => p.name.toLowerCase().includes(search.toLowerCase()))

  if (loading) return <div style={{color:'#999',fontSize:'14px',paddingTop:'20px',fontFamily:"'DM Sans',sans-serif"}}>Chargement…</div>

  return (
    <div style={{fontFamily:"'DM Sans',sans-serif"}}>
      <p style={{fontFamily:"'DM Serif Display',serif",fontSize:'18px',color:'#1A1A1A',marginBottom:'16px'}}>Produits</p>

      <input
        style={{width:'100%',padding:'12px 16px',borderRadius:'12px',border:'1.5px solid #EBEBEB',fontSize:'14px',fontFamily:"'DM Sans',sans-serif",color:'#1A1A1A',outline:'none',marginBottom:'16px',boxSizing:'border-box',background:'white'}}
        placeholder="Rechercher un produit…"
        value={search}
        onChange={e => setSearch(e.target.value)}
      />

      {filtered.length === 0 ? (
        <div style={{textAlign:'center',padding:'48px 24px',color:'#BBB',fontSize:'14px'}}>
          <div style={{fontSize:'32px',marginBottom:'12px'}}>📦</div>Aucun produit trouvé
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
                {p.stock < 10 ? '⚠ ' : ''}{p.stock} en stock
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
