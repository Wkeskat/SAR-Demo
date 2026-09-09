import * as Cesium from 'cesium';

/**
 * Dark basemap options.
 *
 * PLACEHOLDERS: Cesium's UrlTemplateImageryProvider understands
 * {z} {x} {y} {s} {reverseX} {reverseY} {reverseZ} {width} {height} and the
 * *Degrees/*Projected bounds tokens. It does NOT understand Leaflet's {r}
 * retina token — leaving {r} in a template yields literal ".../123{r}.png"
 * URLs and every tile 404s silently. For retina use "@2x" in the path and
 * set tileWidth/tileHeight to 512.
 *
 * KEYS: CARTO's basemaps.cartocdn.com now stamps "API KEY REQUIRED" across
 * tiles served without one, so it is no longer a key-free option. Presets
 * below are marked with what they actually require.
 */

export type BasemapId =
  | 'esri-dark'
  | 'esri-dark-gray'
  | 'osm-darkened'
  | 'none'
  | 'carto-dark';

export interface BasemapPreset {
  id: BasemapId;
  label: string;
  /** True when the tiles need an account or key to render unwatermarked. */
  needsKey: boolean;
  create: () => Cesium.ImageryLayer | undefined;
}

/**
 * Post-render adjustments applied to an imagery layer.
 * Cesium exposes brightness / contrast / hue / saturation / gamma on
 * ImageryLayer — there is no invert, so a light basemap can be pushed dark
 * and grey but never truly inverted.
 */
function adjust(
  layer: Cesium.ImageryLayer,
  values: Partial<
    Pick<
      Cesium.ImageryLayer,
      'brightness' | 'contrast' | 'saturation' | 'gamma' | 'hue' | 'alpha'
    >
  >,
): Cesium.ImageryLayer {
  Object.assign(layer, values);
  return layer;
}

/**
 * Esri's legacy ArcGIS Online MapServer tiles are open without a key;
 * attribution is a licence condition. Addressed through
 * UrlTemplateImageryProvider rather than ArcGisMapServerImageryProvider
 * because the latter is async-only (fromUrl) in current Cesium and its
 * constructor signature has churned across releases.
 *
 * ArcGIS tile paths are /{level}/{row}/{col}, i.e. {z}/{y}/{x}.
 */
function esriDarkGrayLayer(): Cesium.ImageryLayer {
  return new Cesium.ImageryLayer(
    new Cesium.UrlTemplateImageryProvider({
      url:
        'https://services.arcgisonline.com/ArcGIS/rest/services/' +
        'Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      credit: new Cesium.Credit('© Esri, HERE, Garmin, FAO, NOAA', false),
      maximumLevel: 16,
    }),
  );
}

/**
 * Crush Esri Dark Gray down to near-black, i.e. a Dark Matter look.
 *
 * "Dark Gray Canvas" is mid-grey by design (land around #303030), which
 * competes with the pale end of the height ramp. Dropping brightness and
 * gamma pushes land toward black while contrast keeps roads legible as
 * faint lines.
 *
 * saturation 0 is deliberate: the source is already near-neutral, and
 * Cesium's hue knob does nothing to a desaturated image, so the cool cast is
 * added underneath instead — the layer sits at alpha < 1 over the dark blue
 * globe baseColor set in viewer.ts, which tints the whole thing.
 */
interface LayerAdjust {
  brightness: number;
  contrast: number;
  saturation: number;
  gamma: number;
  alpha: number;
}

const DARK_ADJUST: LayerAdjust = {
    brightness: 0.65,
    gamma: 0.85,
    contrast: 1.15,
    saturation: 0,
    alpha: 0.92,
};

/** `?darkness=0..1` scales the effect — 0 leaves Esri as-is, 1 is full crush. */
function darkAdjustScaled(amount: number): LayerAdjust {
  const t = Math.min(Math.max(amount, 0), 1);
  const lerp = (from: number, to: number): number => from + (to - from) * t;
  return {
    brightness: lerp(1, DARK_ADJUST.brightness),
    contrast: lerp(1, DARK_ADJUST.contrast),
    saturation: lerp(1, DARK_ADJUST.saturation),
    gamma: lerp(1, DARK_ADJUST.gamma),
    alpha: lerp(1, DARK_ADJUST.alpha),
  };
}

export const BASEMAPS: BasemapPreset[] = [
  {
    /** Default: near-black. */
    id: 'esri-dark',
    label: 'Dark (Esri, crushed)',
    needsKey: false,
    create: () => {
      const requested = new URLSearchParams(window.location.search).get('darkness');
      const amount = requested === null ? 1 : Number(requested);
      return adjust(
        esriDarkGrayLayer(),
        darkAdjustScaled(Number.isFinite(amount) ? amount : 1),
      );
    },
  },
  {
    /** The unmodified Esri style, for comparison. */
    id: 'esri-dark-gray',
    label: 'Esri Dark Gray Canvas (unmodified)',
    needsKey: false,
    create: () => esriDarkGrayLayer(),
  },
  {
    /**
     * Fallback that cannot stop being free: standard OSM tiles pushed dark
     * and desaturated. Reads as charcoal-grey rather than true dark, but it
     * has no key, no watermark and no vendor to change terms.
     * Respect the OSM tile usage policy — fine for development and light use.
     */
    id: 'osm-darkened',
    label: 'OSM (darkened)',
    needsKey: false,
    create: () =>
      adjust(
        new Cesium.ImageryLayer(
          new Cesium.OpenStreetMapImageryProvider({
            url: 'https://tile.openstreetmap.org/',
          }),
        ),
        { brightness: 0.32, contrast: 1.35, saturation: 0.15, gamma: 0.7 },
      ),
  },
  {
    /**
     * No imagery at all — buildings over a flat dark globe. Zero network,
     * zero licensing. On a scene this dense the basemap is mostly hidden
     * behind footprints anyway, so this is a real option, not a degraded one.
     */
    id: 'none',
    label: 'No basemap',
    needsKey: false,
    create: () => undefined,
  },
  {
    /** Requires a CARTO key; tiles are watermarked without one. */
    id: 'carto-dark',
    label: 'CARTO Dark Matter (key required)',
    needsKey: true,
    create: () => {
      const key = (import.meta.env.VITE_CARTO_API_KEY ?? '').trim();
      if (!key) {
        console.warn(
          '[sar-building-3d] carto-dark needs VITE_CARTO_API_KEY in .env; falling back to the crushed Esri dark basemap.',
        );
        return adjust(esriDarkGrayLayer(), DARK_ADJUST);
      }
      return new Cesium.ImageryLayer(
        new Cesium.UrlTemplateImageryProvider({
          url: `https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}@2x.png?api_key=${key}`,
          subdomains: ['a', 'b', 'c', 'd'],
          credit: new Cesium.Credit('© OpenStreetMap contributors, © CARTO', false),
          tileWidth: 512,
          tileHeight: 512,
          maximumLevel: 20,
        }),
      );
    },
  },
];

export const DEFAULT_BASEMAP: BasemapId = 'esri-dark';

/**
 * Resolve the basemap to use. A `?basemap=` query param overrides the
 * default, so alternatives can be tried without editing code — useful given
 * that free tile endpoints change terms without notice.
 */
export function resolveBasemapId(): BasemapId {
  const requested = new URLSearchParams(window.location.search).get('basemap');
  const match = BASEMAPS.find((b) => b.id === requested);
  return match ? match.id : DEFAULT_BASEMAP;
}

export function createBasemap(id: BasemapId): Cesium.ImageryLayer | undefined {
  const preset = BASEMAPS.find((b) => b.id === id) ?? BASEMAPS[0];
  return preset.create();
}
