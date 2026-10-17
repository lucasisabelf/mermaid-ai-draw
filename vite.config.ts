import { defineConfig } from 'vite';
import { diagramApi } from './server/api';

export default defineConfig({
  plugins: [diagramApi()],
  server: {
    // No WSL, arquivos em /mnt/c não geram eventos de mudança; polling resolve.
    watch: { usePolling: Boolean(process.env.WSL_DISTRO_NAME), ignored: ['**/diagram.mmd'] },
  },
});
