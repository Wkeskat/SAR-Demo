import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';

export default defineConfig({
  /*
   * Must match the GitHub repository name EXACTLY, including case — Pages
   * serves a project site at https://<user>.github.io/<repo>/ and that path
   * is case-sensitive. Repo is github.com/Wkeskat/SAR-Demo, so '/SAR-Demo/'.
   * Get this wrong and the page loads but every asset 404s: blank screen,
   * no error.
   */
  base: '/SAR-Demo/',
  plugins: [cesium()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    open: true,
  },
});