import { defineConfig } from 'vite'
import path from "path"
import { fileURLToPath } from 'url';
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'src'),
    },
  },
  plugins: [react()],
})
