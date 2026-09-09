import * as Cesium from 'cesium';
import { createBasemap, resolveBasemapId } from './basemaps';

/**
 * Cesium ion token, read from .env (VITE_CESIUM_ION_TOKEN).
 * If it is absent we run fully off-ion: dark basemap imagery + ellipsoid terrain.
 * That keeps the app usable with no account, at the cost of world terrain.
 */
const ION_TOKEN = (import.meta.env.VITE_CESIUM_ION_TOKEN ?? '').trim();
export const USING_ION = ION_TOKEN.length > 0;

if (USING_ION) {
  Cesium.Ion.defaultAccessToken = ION_TOKEN;
}

export function createViewer(containerId: string): Cesium.Viewer {
  const viewer = new Cesium.Viewer(containerId, {
    // Dark basemap regardless of ion — the height ramp reads better on it.
    // See basemaps.ts; override at runtime with ?basemap=<id>.
    baseLayer: createBasemap(resolveBasemapId()) ?? false,
    terrain: USING_ION ? Cesium.Terrain.fromWorldTerrain() : undefined,

    // ion-backed widgets only make sense with a token. baseLayerPicker stays
    // off either way: it would replace our dark basemap with ion's defaults.
    geocoder: USING_ION,
    baseLayerPicker: false,

    animation: false,
    timeline: false,
    navigationHelpButton: false,
    homeButton: true,
    sceneModePicker: true,
    fullscreenButton: true,

    // We render our own attribute panel instead of the default InfoBox.
    infoBox: false,
    selectionIndicator: false,
  });

  const { scene } = viewer;

  // Dark globe under the imagery. This shows with basemap=none, in tile gaps,
  // and while tiles load — a default pale globe would flash white. It is also
  // what tints the basemap: the dark preset sits at alpha < 1, so this cool
  // near-black bleeds through and keeps the map from reading as flat grey.
  scene.globe.baseColor = Cesium.Color.fromCssColorString('#151b24');
  scene.backgroundColor = Cesium.Color.fromCssColorString('#0b0f16');
  // Atmosphere on: without it the globe at the start of the opening flight is
  // a bare sphere on black. Barely visible once the camera is down at street
  // level, so it costs nothing there. Set to false if you drop the intro.
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = true;

  // Extruded footprints must be occluded by terrain, not drawn through it.
  scene.globe.depthTestAgainstTerrain = true;

  // Cheap ambient contrast so flat-roofed boxes read as volumes.
  scene.globe.enableLighting = false;
  scene.light = new Cesium.DirectionalLight({
    direction: new Cesium.Cartesian3(0.35, -0.6, -0.7),
    intensity: 1.6,
  });

  // Logarithmic depth buffer avoids z-fighting between footprints and terrain.
  scene.logarithmicDepthBuffer = true;

  // Keep the camera from tunnelling under the ground while inspecting facades.
  scene.screenSpaceCameraController.enableCollisionDetection = true;

  return viewer;
}

/** Ease the camera to fit a data source, looking in at a workable pitch. */
export function frameDataSource(
  viewer: Cesium.Viewer,
  dataSource: Cesium.DataSource,
): Promise<boolean> {
  return viewer.flyTo(dataSource, {
    duration: 2.0,
    offset: new Cesium.HeadingPitchRange(
      Cesium.Math.toRadians(20),
      Cesium.Math.toRadians(-40),
    ),
  });
}

/* ------------------------------------------------------------------ */
/* Start-up camera position                                            */
/* ------------------------------------------------------------------ */

/**
 * The SHAPE of a camera view — these are types, not values. Keep them as
 * `number`; writing a specific number here makes it the only value the field
 * will accept. Actual coordinates go in HOME_VIEW below.
 */
export interface CameraView {
  /** Longitude of the point the camera sits above, degrees. */
  lon: number;
  /** Latitude, degrees. */
  lat: number;
  /** Camera altitude above the ellipsoid, metres. */
  height: number;
  /** Compass direction the camera faces, degrees. 0 = north, 90 = east. */
  heading?: number;
  /** Tilt, degrees. −90 looks straight down; −35 is a typical oblique view. */
  pitch?: number;
}

/**
 * EDIT HERE to control where the map opens.
 *
 * Leave it `undefined` to fit the camera to the loaded data instead, which is
 * what makes the app work unchanged when the AOI moves. Set a view when you
 * want every reload to land on the same spot — a demo, a screenshot, or a
 * particular building you keep coming back to.
 *
 * Press "c" in the running app to print the current camera as a ready-made
 * literal to the console, then paste it here. Beats guessing coordinates.
 */
export const HOME_VIEW: CameraView | undefined = {
  lon: 102.8613839,  
  lat: 16.4165918,
  height: 1200,
  heading: 0,
  pitch: -40,
};

// Set it to `undefined` instead to fit the camera to the loaded data:
// export const HOME_VIEW: CameraView | undefined = undefined;

export function flyToView(
  viewer: Cesium.Viewer,
  view: CameraView,
  options: { animate?: boolean; duration?: number } = {},
): Promise<void> {
  const destination = Cesium.Cartesian3.fromDegrees(view.lon, view.lat, view.height);
  const orientation = {
    heading: Cesium.Math.toRadians(view.heading ?? 0),
    pitch: Cesium.Math.toRadians(view.pitch ?? -40),
    roll: 0,
  };

  if (!options.animate) {
    viewer.camera.setView({ destination, orientation });
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    viewer.camera.flyTo({
      destination,
      orientation,
      duration: options.duration ?? 2.0,
      // Resolve on cancel too, so a skipped flight never leaves the caller
      // awaiting forever.
      complete: () => resolve(),
      cancel: () => resolve(),
    });
  });
}

/* ------------------------------------------------------------------ */
/* Opening flight: whole globe, then down to the AOI                   */
/* ------------------------------------------------------------------ */

/** Set false to land on HOME_VIEW immediately with no opening flight. */
export const INTRO_ENABLED = true;

/** Camera altitude the flight starts from, metres. ~20,000 km shows a full disc. */
const INTRO_START_HEIGHT = 20_000_000;

/** Seconds the descent takes. */
const INTRO_DURATION = 5.0;

/**
 * Park the camera in orbit above the target, looking straight down.
 *
 * Positioning it above the destination rather than at some arbitrary globe
 * view means the flight is one continuous descent — the viewer can see where
 * on Earth they are being taken, which is the point of showing the globe.
 */
export function setWorldView(viewer: Cesium.Viewer, target: CameraView): void {
  flyToView(viewer, {
    lon: target.lon,
    lat: target.lat,
    height: INTRO_START_HEIGHT,
    heading: target.heading ?? 0,
    pitch: -90,
  });
}

/**
 * Fly from the world view down to the target.
 *
 * Any click or key press cancels the flight and jumps to the destination —
 * an intro nobody can skip is an intro people resent on the second viewing.
 */
export function playIntro(viewer: Cesium.Viewer, target: CameraView): Promise<void> {
  const skip = (): void => {
    viewer.camera.cancelFlight();
    flyToView(viewer, target);
  };

  const canvas = viewer.scene.canvas;
  canvas.addEventListener('pointerdown', skip, { once: true });
  window.addEventListener('keydown', skip, { once: true });

  return flyToView(viewer, target, {
    animate: true,
    duration: INTRO_DURATION,
  }).finally(() => {
    canvas.removeEventListener('pointerdown', skip);
    window.removeEventListener('keydown', skip);
  });
}

/**
 * Point the Home button at HOME_VIEW instead of the whole globe.
 * Without this the button zooms out to the entire Earth, which is never what
 * you want in a single-AOI viewer.
 */
export function bindHomeButton(viewer: Cesium.Viewer, view: CameraView): void {
  const homeButton = viewer.homeButton;
  if (!homeButton) return;

  homeButton.viewModel.command.beforeExecute.addEventListener(
    (commandInfo: { cancel: boolean }) => {
      commandInfo.cancel = true;
      flyToView(viewer, view, { animate: true });
    },
  );
}

/**
 * Press "c" to log the current camera as a CameraView literal.
 * A development aid: fly somewhere you like, hit the key, paste the result
 * into HOME_VIEW above.
 */
export function enableCameraCapture(viewer: Cesium.Viewer): void {
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'c' || event.target instanceof HTMLInputElement) return;

    const { camera } = viewer;
    const carto = Cesium.Cartographic.fromCartesian(camera.positionWC);
    const round = (n: number, dp: number): number => Number(n.toFixed(dp));

    const view: CameraView = {
      lon: round(Cesium.Math.toDegrees(carto.longitude), 6),
      lat: round(Cesium.Math.toDegrees(carto.latitude), 6),
      height: round(carto.height, 1),
      heading: round(Cesium.Math.toDegrees(camera.heading), 1),
      pitch: round(Cesium.Math.toDegrees(camera.pitch), 1),
    };

    console.log(
      '[sar-building-3d] current view — paste into HOME_VIEW in viewer.ts:\n' +
        JSON.stringify(view, null, 2),
    );
  });
}