import { useOnlineStatus } from '../hooks/useOnlineStatus'

export default function OfflineBanner({ pendingCount = 0, syncing = false, onSyncNow }) {
  const isOnline = useOnlineStatus()

  if (isOnline && pendingCount === 0) return null

  return (
    <div style={{ ...styles.banner, background: isOnline ? '#2E7D42' : '#C45000' }}>
      {isOnline ? (
        <>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 12a9 9 0 11-3-6.7" /><polyline points="21 3 21 9 15 9" />
          </svg>
          {syncing
            ? `Syncing ${pendingCount} pending sale${pendingCount !== 1 ? 's' : ''}…`
            : `${pendingCount} sale${pendingCount !== 1 ? 's' : ''} waiting to sync`}
          {!syncing && (
            <button style={styles.syncBtn} onClick={onSyncNow}>Sync now</button>
          )}
        </>
      ) : (
        <>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="1" y1="1" x2="23" y2="23"/>
            <path d="M16.72 11.06A10.94 10.94 0 0119 12.55M5 12.55a10.94 10.94 0 015.17-2.39M10.71 5.05A16 16 0 0122.56 9M1.42 9a15.91 15.91 0 014.7-2.88M8.53 16.11a6 6 0 016.95 0M12 20h.01"/>
          </svg>
          Offline — sales are saved and will sync automatically
          {pendingCount > 0 ? ` (${pendingCount} pending)` : ''}
        </>
      )}
    </div>
  )
}

const styles = {
  banner: {
    position: 'fixed',
    top: 0,
    left: '50%',
    transform: 'translateX(-50%)',
    width: '100%',
    maxWidth: '430px',
    color: 'white',
    padding: '8px 16px',
    fontSize: '12.5px',
    fontWeight: '500',
    fontFamily: "'DM Sans', sans-serif",
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    zIndex: 999,
    textAlign: 'center',
  },
  syncBtn: {
    background: 'rgba(255,255,255,0.2)',
    border: 'none',
    borderRadius: '100px',
    color: 'white',
    fontSize: '11px',
    fontWeight: '600',
    padding: '3px 10px',
    cursor: 'pointer',
    marginLeft: '4px',
  },
}
