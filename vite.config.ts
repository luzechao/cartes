import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  // GitHub Pages serves a project site under /<repo>/; the Pages workflow sets this. Locally, '/'.
  base: process.env.CARTES_BASE ?? '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // Pyodide loads its runtime from public/sim-engine/pyodide at run time; pre-bundling it breaks that lookup.
  optimizeDeps: {
    exclude: ['pyodide'],
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
  },
})
