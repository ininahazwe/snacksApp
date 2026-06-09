import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      devOptions: {
        enabled: true // PWA actif en dev pour tester
      },
      includeAssets: ['favicon.ico', 'logo192.png', 'logo512.png'],
      manifest: {
        name: 'Douceurs POS',
        short_name: 'Douceurs',
        description: 'Point of sale for sweet shop',
        theme_color: '#1A1A1A',
        background_color: '#F7F6F3',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        icons: [
          { src: 'logo192.png', sizes: '192x192', type: 'image/png' },
          { src: 'logo512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
        categories: ['business', 'productivity'],
      },
      workbox: {
        // Précache tous les assets compilés
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // Stratégies de cache réseau
        runtimeCaching: [
          {
            // Fonts Google → cache d'abord
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-cache',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
          {
            // Supabase Auth → réseau d'abord, fallback cache
            urlPattern: /^https:\/\/.*\.supabase\.co\/auth\/.*/i,
            handler: 'NetworkOnly', // L'auth doit toujours être en ligne
          },
          {
            // Supabase Data → réseau d'abord, cache si offline
            urlPattern: /^https:\/\/.*\.supabase\.co\/rest\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'supabase-data-cache',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 5 }, // 5 min
            },
          },
        ],
      },
    }),
  ],
})
