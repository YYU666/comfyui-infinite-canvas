import { defineConfig } from 'vite';
import { loadLocalNodeTools } from './scripts/local-node-tools-config.mjs';

export default defineConfig(({ mode }) => ({
  // Release/dev builds never read machine-specific tools. Local testing requires
  // an explicit mode, and the manifest lives outside version control.
  define: { __H3_LOCAL_NODE_TOOLS__: JSON.stringify(loadLocalNodeTools(mode)) },
}));
