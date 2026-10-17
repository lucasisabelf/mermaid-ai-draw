import { defineConfig } from 'vite';
import { diagramApi } from './server/api.ts';

export default defineConfig({
  // MERMAID_DRAW_FILE troca o arquivo onde a API guarda o diagrama (padrão: diagram.json).
  plugins: [diagramApi(process.env.MERMAID_DRAW_FILE)],
  server: {
    // No WSL, arquivos em /mnt/c não geram eventos de mudança; polling resolve.
    watch: { usePolling: Boolean(process.env.WSL_DISTRO_NAME), ignored: ['**/diagram.json', '**/diagram.mmd'] },
  },
});
