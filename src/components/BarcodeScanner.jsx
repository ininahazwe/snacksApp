import { useEffect, useRef, useState } from 'react'
import { BrowserMultiFormatReader } from '@zxing/browser'
import { NotFoundException } from '@zxing/library'

export default function BarcodeScanner({ onDetected, onClose }) {
  const videoRef = useRef(null)
  const readerRef = useRef(null)
  const [error, setError] = useState(null)
  const [scanning, setScanning] = useState(true)

  useEffect(() => {
    const codeReader = new BrowserMultiFormatReader()
    readerRef.current = codeReader

    codeReader.decodeFromVideoDevice(undefined, videoRef.current, (result, err) => {
      if (result && scanning) {
        setScanning(false)
        // Vibration tactile si supportée
        if (navigator.vibrate) navigator.vibrate(100)
        onDetected(result.getText())
      }
      if (err && !(err instanceof NotFoundException)) {
        console.error('Scanner error:', err)
      }
    }).catch(err => {
      if (err.name === 'NotAllowedError') {
        setError('Accès à la caméra refusé. Autorise la caméra dans les paramètres du navigateur.')
      } else {
        setError('Impossible d\'accéder à la caméra.')
      }
    })

    return () => {
      BrowserMultiFormatReader.releaseAllStreams()
    }
  }, [])

  return (
    <div style={styles.overlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={styles.modal}>
        <div style={styles.handle} />

        <div style={styles.header}>
          <span style={styles.title}>Scanner un produit</span>
          <button style={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        {error ? (
          <div style={styles.error}>
            <div style={{ fontSize: '32px', marginBottom: '12px' }}>📵</div>
            <div>{error}</div>
          </div>
        ) : (
          <>
            {/* Viewfinder */}
            <div style={styles.viewfinder}>
              <video ref={videoRef} style={styles.video} autoPlay playsInline muted />
              {/* Cadre de scan animé */}
              <div style={styles.scanFrame}>
                <div style={{ ...styles.corner, top: 0, left: 0, borderTop: '3px solid #E84B6E', borderLeft: '3px solid #E84B6E' }} />
                <div style={{ ...styles.corner, top: 0, right: 0, borderTop: '3px solid #E84B6E', borderRight: '3px solid #E84B6E' }} />
                <div style={{ ...styles.corner, bottom: 0, left: 0, borderBottom: '3px solid #E84B6E', borderLeft: '3px solid #E84B6E' }} />
                <div style={{ ...styles.corner, bottom: 0, right: 0, borderBottom: '3px solid #E84B6E', borderRight: '3px solid #E84B6E' }} />
                <div style={styles.scanLine} />
              </div>
            </div>

            <p style={styles.hint}>
              {scanning ? 'Place le code-barres dans le cadre' : '✓ Code détecté !'}
            </p>
          </>
        )}
      </div>

      <style>{`
        @keyframes scanMove {
          0%   { top: 10%; }
          50%  { top: 85%; }
          100% { top: 10%; }
        }
      `}</style>
    </div>
  )
}

const styles = {
  overlay: {
    position: 'fixed', inset: 0,
    background: 'rgba(0,0,0,0.7)',
    zIndex: 200,
    display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
  },
  modal: {
    background: 'white',
    borderRadius: '28px 28px 0 0',
    padding: '8px 24px 40px',
    width: '100%', maxWidth: '430px',
    fontFamily: "'DM Sans', sans-serif",
  },
  handle: {
    width: '36px', height: '4px',
    background: '#E0E0E0', borderRadius: '10px',
    margin: '10px auto 16px',
  },
  header: {
    display: 'flex', justifyContent: 'space-between',
    alignItems: 'center', marginBottom: '16px',
  },
  title: {
    fontFamily: "'DM Serif Display', serif",
    fontSize: '20px', color: '#1A1A1A',
  },
  closeBtn: {
    background: '#F5F5F5', border: 'none',
    borderRadius: '50%', width: '32px', height: '32px',
    cursor: 'pointer', fontSize: '14px', color: '#666',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  viewfinder: {
    position: 'relative',
    width: '100%', height: '240px',
    borderRadius: '16px', overflow: 'hidden',
    background: '#000', marginBottom: '16px',
  },
  video: {
    width: '100%', height: '100%', objectFit: 'cover',
  },
  scanFrame: {
    position: 'absolute',
    top: '15%', left: '10%',
    width: '80%', height: '70%',
  },
  corner: {
    position: 'absolute',
    width: '20px', height: '20px',
    borderRadius: '2px',
  },
  scanLine: {
    position: 'absolute',
    left: 0, right: 0,
    height: '2px',
    background: 'rgba(232,75,110,0.8)',
    animation: 'scanMove 2s ease-in-out infinite',
    boxShadow: '0 0 8px rgba(232,75,110,0.6)',
  },
  hint: {
    textAlign: 'center', fontSize: '14px',
    color: '#999', marginBottom: '8px',
  },
  error: {
    textAlign: 'center', padding: '32px 16px',
    fontSize: '14px', color: '#C45000', lineHeight: 1.5,
  },
}
