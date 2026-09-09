import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';

export default defineConfig({
  /*
   * Relative base, NOT '/SAR-Demo/'.
   *
   * A subpath base breaks vite-plugin-cesium: it builds CESIUM_BASE_URL as
   * '/SAR-Demo/cesium/' for the <script src>, then reuses that same absolute
   * string as a copy destination — path.join('dist', '/SAR-Demo/cesium/')
   * lands the Cesium runtime in dist/SAR-Demo/cesium/, one level below where
   * the script tag looks for it. Result: Cesium 404s, the page renders its
   * shell, and the map is silently black.
   *
   * './' makes CESIUM_BASE_URL just 'cesium/', so the copy target and the
   * script src agree, and both resolve against whatever URL the page is
   * served from. Also means this works unchanged if the repo is renamed or
   * served from a different path.
   */
  base: './',
  plugins: [cesium()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    open: true,
  },
});