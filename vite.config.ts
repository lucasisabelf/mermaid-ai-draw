import { defineConfig } from 'vite';
import { diagramApi } from './server/diagrams.ts';

export default defineConfig({
  // MERMAID_DRAW_DIR troca a pasta dos diagramas (padrão: diagrams/). MERMAID_DRAW_FILE é o diagrama
  // de antes dos vários diagramas: na primeira vez, ele vira o primeiro da lista.
  plugins: [diagramApi(process.env.MERMAID_DRAW_DIR, process.env.MERMAID_DRAW_FILE)],
  server: {
    // No WSL, arquivos em /mnt/c não geram eventos de mudança; polling resolve.
    watch: {
      usePolling: Boolean(process.env.WSL_DISTRO_NAME),
      ignored: ['**/diagram.json', '**/diagram.mmd', '**/diagrams/**'],
    },
  },
});
