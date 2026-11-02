import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig(({ mode }) => {
  const isProduction = mode === 'production';

  return {
    root: 'src',
    base: './',
    publicDir: path.resolve(__dirname, 'src/public'),
    server: {
      open: true,
      port: 8888,
    },
    build: {
      outDir: path.resolve(__dirname, 'dist'),
      emptyOutDir: true,
      target: "es2015",
      minify: 'terser',
      terserOptions: {
        format: { comments: false },
        compress: { drop_console: isProduction },
      },

      rollupOptions: {
        output: {
          entryFileNames: 'assets/js/[name]-[hash].js',
          chunkFileNames: 'assets/js/[name]-[hash].js',
          assetFileNames: (assetInfo) => {
            const name = assetInfo.name || '';
            if (name.endsWith('.css')) {
              return 'assets/css/[name]-[hash].[ext]';
            }
            if (name.endsWith('.mp4')) {
              return 'assets/video/[name]-[hash].[ext]';
            }
            return 'assets/[name]-[hash].[ext]';
          },
          manualChunks (id) {
            if (id.includes('node_modules')) {
              if (id.includes('three')) {
                return 'vendor-three';
              }
              if (id.includes('@dimforge/rapier3d-compat')) {
                return 'vendor-physics';
              }
              if (id.includes('gsap')) {
                return 'vendor-animation';
              }
              return 'vendor-utils';
            }
          }
        },
      },
    },
  };
});