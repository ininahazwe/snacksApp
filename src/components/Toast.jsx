export default function Toast({ message }) {
  if (!message) return null
  return (
    <>
      <div style={styles.toast}>{message}</div>
      <style>{`
        @keyframes toastIn {
          from { transform: translateX(-50%) translateY(-20px); opacity: 0; }
          to   { transform: translateX(-50%) translateY(0); opacity: 1; }
        }
      `}</style>
    </>
  )
}

const styles = {
  toast: {
    position: 'fixed',
    top: '24px',
    left: '50%',
    transform: 'translateX(-50%)',
    background: '#1A1A1A',
    color: 'white',
    padding: '12px 20px',
    borderRadius: '100px',
    fontSize: '13.5px',
    fontWeight: '500',
    zIndex: 300,
    whiteSpace: 'nowrap',
    boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
    fontFamily: "'DM Sans', sans-serif",
    animation: 'toastIn 0.3s cubic-bezier(0.34,1.56,0.64,1)',
  },
}
