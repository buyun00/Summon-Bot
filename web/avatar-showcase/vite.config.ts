import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import solid from '@solidjs/vite-plugin'
import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  plugins: [solid(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    outDir: '../frontend/avatar-showcase',
    emptyOutDir: false,
    rolldownOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]'
      }
    }
  }
})
