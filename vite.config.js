import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon-192.png', 'icon-512.png', 'logo.png'],
      // 客服推播：把 push / notificationclick 的處理掛進 workbox 產生的 sw.js。
      // 沿用 generateSW 策略（不改成 injectManifest），既有的離線快取行為不受影響。
      workbox: {
        importScripts: ['push-sw.js'],
      },
      manifest: {
        name: 'Daigogo 庫存管理系統',
        short_name: 'Daigogo',
        theme_color: '#1a1a1a',
        background_color: '#f5f5f0',
        display: 'standalone',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      }
    })
  ]
})
