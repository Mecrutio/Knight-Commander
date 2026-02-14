import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: '/Knight-Commander/',
  plugins: [react(), VitePWA({ registerType: "autoUpdate", includeAssets: ["favicon.svg","pwa-192x192.png","pwa-512x512.png"], manifest: { name: "Knight Commander", short_name: "KnightCmdr", theme_color: "#111827", background_color: "#ffffff", display: "standalone", scope: "/Knight-Commander/", start_url: "/Knight-Commander/", icons: [{src:"/Knight-Commander/pwa-192x192.png", sizes:"192x192", type:"image/png"},{src:"/Knight-Commander/pwa-512x512.png", sizes:"512x512", type:"image/png"}] }, workbox: { globPatterns: ["**/*.{js,css,html,svg,png,ico,json,txt}"] } }) ],
})
