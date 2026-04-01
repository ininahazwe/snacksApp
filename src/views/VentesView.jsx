import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export default function VentesView() {
  const [sales, setSales] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')

  useEffect(() => { fetchSales() }, [])

  const fetchSales = async () => {
    const { data } = await supabase
      .from('sales')
      .select('*, products(name, emoji), clients(name)')
      .order('created_at', { ascending: false })
      .limit(100)
    setSales(data ?? [])
    setLoading(false)
  }

  const filtered = filter === 'all' ? sales : sales.filter(s => s.type === filter)
  const totalCash = filtered.filter(s => s.type === 'cash').reduce((sum, s) => sum + s.amount, 0)

  const formatDate = (iso) => new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

  if (loading) return <div style={{color:'#999',fontSize:'14px',paddingTop:'20px',fontFamily:"'DM Sans',sans-serif"}}>Chargement…</div>

  return (
    <div style={{fontFamily:"'DM Sans',sans-serif"}}>
      <p style={{fontFamily:"'DM Serif Display',serif",fontSize:'18px',color:'#1A1A1A',marginBottom:'16px'}}>Ventes</p>

      <div style={{display:'flex',gap:'8px',marginBottom:'16px'}}>
        {[['all','Toutes'],['cash','Payées'],['dette','Dettes']].map(([val,label]) => (
          <button key={val} onClick={() => setFilter(val)} style={{padding:'8px 16px',borderRadius:'100px',border:'1.5px solid',borderColor:filter===val?'#1A1A1A':'#EBEBEB',background:filter===val?'#1A1A1A':'white',color:filter===val?'white':'#999',fontSize:'13px',fontWeight:'500',cursor:'pointer',fontFamily:"'DM Sans',sans-serif"}}>
            {label}
          </button>
        ))}
      </div>

      {filter !== 'dette' && (
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',background:'white',borderRadius:'14px',padding:'14px 18px',marginBottom:'16px',border:'1px solid rgba(0,0,0,0.05)',boxShadow:'0 2px 12px rgba(0,0,0,0.04)'}}>
          <span style={{fontSize:'13px',color:'#999'}}>Total encaissé</span>
          <span style={{fontFamily:"'DM Serif Display',serif",fontSize:'20px',color:'#1A1A1A'}}>{totalCash.toLocaleString()} F CFA</span>
        </div>
      )}

      {filtered.length === 0 ? (
        <div style={{textAlign:'center',padding:'48px 24px',color:'#BBB',fontSize:'14px'}}>
          <div style={{fontSize:'32px',marginBottom:'12px'}}>🛒</div>Aucune vente
        </div>
      ) : (
        <div style={{background:'white',borderRadius:'18px',border:'1px solid rgba(0,0,0,0.05)',boxShadow:'0 2px 12px rgba(0,0,0,0.04)',overflow:'hidden'}}>
          {filtered.map((s, i) => (
            <div key={s.id} style={{display:'flex',alignItems:'center',padding:'13px 18px',gap:'12px',borderBottom:i<filtered.length-1?'1px solid rgba(0,0,0,0.04)':'none'}}>
              <div style={{width:'36px',height:'36px',borderRadius:'10px',background:'#F5F5F5',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'18px',flexShrink:0}}>{s.products?.emoji ?? '🍬'}</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:'13.5px',fontWeight:'500',color:'#1A1A1A',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{s.products?.name ?? '—'}</div>
                <div style={{fontSize:'11px',color:'#BBB',marginTop:'2px'}}>{s.clients?.name ?? 'Client inconnu'} · ×{s.qty} · {formatDate(s.created_at)}</div>
              </div>
              <div style={{textAlign:'right',flexShrink:0}}>
                <div style={{fontSize:'14px',fontWeight:'600',color:'#1A1A1A'}}>{s.amount?.toLocaleString()} F</div>
                <span style={{display:'inline-block',padding:'2px 8px',borderRadius:'100px',fontSize:'10.5px',fontWeight:'500',background:s.type==='cash'?'#E8F5EC':'#FFF0E8',color:s.type==='cash'?'#2E7D42':'#C45000'}}>
                  {s.type === 'cash' ? 'Payé' : 'Dette'}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
