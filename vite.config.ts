import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// The UI is loaded by Electron: from this dev server in `npm run dev`,
// from dist/ (via the app:// protocol) in a packaged build.
export default defineConfig({
  plugins: [solid()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/core/**", "**/release/**"] },
  },
});
