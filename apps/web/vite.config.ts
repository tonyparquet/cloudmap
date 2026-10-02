import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Le serveur remplace __CSP_NONCE__ par le nonce de la requête (CSP stricte, section 4.2).
export default defineConfig({
  plugins: [react()],
  html: { cspNonce: '__CSP_NONCE__' },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
  },
});
