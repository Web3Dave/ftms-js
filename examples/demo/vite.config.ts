import { defineConfig } from 'vite'

// base './' keeps asset URLs relative so the build works under any path (GitHub Pages serves /ftms-js/).
// Web Bluetooth needs https or http://localhost. allowedHosts lets dev proxies through.
export default defineConfig({
  base: './',
  server: { allowedHosts: true },
  preview: { allowedHosts: true },
})
