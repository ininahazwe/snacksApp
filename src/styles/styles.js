// Styles du layout global : header, contenu, bottom nav
export const st = {
    app:       { maxWidth:'430px', margin:'0 auto', minHeight:'100vh', background:'#F7F6F3', display:'flex', flexDirection:'column', fontFamily:"'DM Sans',sans-serif", position:'relative' },
    header:    { padding:'20px 24px 16px', background:'#F7F6F3', position:'sticky', top:0, zIndex:10, borderBottom:'1px solid rgba(0,0,0,0.06)' },
    headerTop: { display:'flex', alignItems:'center', justifyContent:'space-between' },
    brand:     { fontFamily:"'DM Serif Display',serif", fontSize:'22px', color:'#1A1A1A', letterSpacing:'-0.3px' },
    brandDot:  { display:'inline-block', width:'7px', height:'7px', background:'#E84B6E', borderRadius:'50%', marginLeft:'3px', verticalAlign:'middle', marginBottom:'3px' },
    roleBadge: { fontSize:'11px', color:'#BBB', marginTop:'2px' },
    scanBtn:   { display:'flex', alignItems:'center', gap:'8px', background:'#1A1A1A', color:'white', border:'none', borderRadius:'100px', padding:'10px 18px', fontFamily:"'DM Sans',sans-serif", fontSize:'13.5px', fontWeight:'500', cursor:'pointer', transition:'all 0.2s ease' },
    logoutBtn: { background:'none', border:'none', cursor:'pointer', color:'#BBB', padding:'6px', borderRadius:'8px', display:'flex', alignItems:'center' },
    content:   { flex:1, padding:'20px 24px 100px', overflowY:'auto' },
    bottomNav: { position:'fixed', bottom:0, left:'50%', transform:'translateX(-50%)', width:'100%', maxWidth:'430px', background:'rgba(247,246,243,0.92)', backdropFilter:'blur(16px)', borderTop:'1px solid rgba(0,0,0,0.07)', display:'flex', padding:'10px 8px 20px', zIndex:20 },
    navItem:   { flex:1, display:'flex', flexDirection:'column', alignItems:'center', gap:'4px', padding:'6px 4px', cursor:'pointer', background:'none', border:'none', borderRadius:'12px', transition:'color 0.2s ease', fontFamily:"'DM Sans',sans-serif" },
    navLabel:  { fontSize:'10px', fontWeight:'500' },
    navDot:    { width:'4px', height:'4px', borderRadius:'50%', background:'#E84B6E' },
}