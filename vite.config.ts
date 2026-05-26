import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'

// When deploying to GitHub Pages (schardosin.github.io/weblooper),
// Vite must know the correct base path so assets load from /weblooper/ instead of /
const isGitHubPages = process.env.GITHUB_PAGES === 'true'

export default defineConfig({
  base: isGitHubPages ? '/weblooper/' : '/',

  plugins: [
    tailwindcss(),

    // NOTE: Cross-origin isolation (COOP/COEP) headers are NO LONGER NEEDED.
    // demucs-rs uses WebGPU compute shaders (single-threaded WASM), not SharedArrayBuffer/threads.
    // This means the YouTube iframe player works alongside stem separation on the same page.
  ],

  // Optimize for large WASM model files (demucs models are 80-300MB)
  optimizeDeps: {
    exclude: ['@demucs/web', '@xenova/transformers'],
  },

  build: {
    chunkSizeWarningLimit: 2000,
  },

  // Proxy for YouTube API calls during development.
  // YouTube's internal Innertube API is very aggressive about blocking non-browser requests.
  // The proxy helps with CORS and allows us to spoof headers that YouTube expects.
  server: {
    proxy: {
      '/yt-api': {
        target: 'https://www.youtube.com',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/yt-api/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            // Remove browser-injected headers that reveal we're a localhost proxy
            proxyReq.removeHeader('Origin');
            proxyReq.removeHeader('X-Forwarded-For');
            proxyReq.removeHeader('X-Forwarded-Host');
            proxyReq.removeHeader('X-Forwarded-Proto');

            // Spoof realistic browser headers
            proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
            proxyReq.setHeader('Accept', '*/*');
            proxyReq.setHeader('Accept-Language', 'en-US,en;q=0.9');
            proxyReq.setHeader('Referer', 'https://www.youtube.com/');
            // X-YouTube headers help identify us as a legitimate client
            proxyReq.setHeader('X-YouTube-Client-Name', '1');
            proxyReq.setHeader('X-YouTube-Client-Version', '2.20250601.01.00');
          });
        },
      },
    },
  },
})
