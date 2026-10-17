import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // No WSL, arquivos em /mnt/c não geram eventos de mudança; polling resolve.
    watch: { usePolling: Boolean(process.env.WSL_DISTRO_NAME) },
  },
});
