import 'cesium/Build/Cesium/Widgets/widgets.css';
import './style.css';

import {
  HOME_VIEW,
  INTRO_ENABLED,
  bindHomeButton,
  createViewer,
  enableCameraCapture,
  flyToView,
  frameDataSource,
  playIntro,
  setWorldView,
  USING_ION,
} from './viewer';
import {
  DEFAULT_DIMENSION,
  applyMode,
  getMaxPredictedHeight,
  loadBuildings,
  setBuildingsVisible,
  setDimension,
  setMinHeight,
} from './buildings';
import type { Dimension, ModeStats } from './buildings';
import { renderLegend } from './heightColor';
import { setupInteraction } from './interaction';
import type { ModeId } from './modes';
import { DEFAULT_MODE, MODES, getMode } from './modes';

/*
 * Prefixed with Vite's BASE_URL rather than written as a root-absolute path.
 *
 * The app is served from a subdirectory on GitHub Pages, so a leading "/"
 * would resolve to the server root — /data/... — which is not where the file
 * is. BASE_URL carries whatever `base` is set to and always ends in a slash,
 * so this holds for '/' in dev, './' on Pages, or any subpath.
 */
const BUILDINGS_URL = `${import.meta.env.BASE_URL}data/test_3d_map.geojson`;

/**
 * Which view modes to offer. Predicted only, so the map shows one thing.
 * When a single mode is listed the switcher panel is hidden entirely and
 * that mode is simply applied — no buttons, no keyboard shortcuts.
 *
 * The other modes are still defined in modes.ts; add their ids back here to
 * bring the switcher out again, e.g.
 *   ['predicted', 'reference', 'error', 'iou']
 */
const ENABLED_MODES: ModeId[] = ['predicted'];

/** Colour schemes offered as radios in the sidebar. */
const COLOUR_MODES: ModeId[] = ['predicted', 'error'];

const statusEl = document.getElementById('status');

function setStatus(message: string, kind: 'info' | 'error' = 'info'): void {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.classList.toggle('is-error', kind === 'error');
  statusEl.classList.add('is-visible');
}

function clearStatus(delayMs = 3000): void {
  if (!statusEl) return;
  window.setTimeout(() => statusEl.classList.remove('is-visible'), delayMs);
}

function formatStats(stats: ModeStats | undefined): string {
  if (!stats) return 'no values in this mode';
  return [
    `median ${stats.median.toFixed(2)} m`,
    `mean ${stats.mean.toFixed(2)} m`,
    `range ${stats.min.toFixed(2)} – ${stats.max.toFixed(2)} m`,
  ].join(' · ');
}

/* ------------------------------------------------------------------ */
/* Sidebar controls                                                     */
/* ------------------------------------------------------------------ */

/** Repaint the Statistics list. Reflects the height filter, not the raw file. */
function renderStats(stats: ModeStats | undefined): void {
  const host = document.getElementById('stats');
  if (!host) return;
  host.textContent = '';

  const rows: Array<[string, string]> = stats
    ? [
        ['Avg height', `${stats.mean.toFixed(1)} m`],
        ['Median', `${stats.median.toFixed(1)} m`],
        ['Max height', `${stats.max.toFixed(1)} m`],
      ]
    : [['Avg height', '—']];

  for (const [label, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    host.append(dt, dd);
  }
}

/** Slider that hides buildings below a minimum predicted height. */
function setupHeightFilter(onChange: (stats: ModeStats | undefined) => void): void {
  const slider = document.getElementById('height-filter') as HTMLInputElement | null;
  const valueEl = document.getElementById('height-filter-value');
  const countEl = document.getElementById('height-filter-count');
  if (!slider) return;

  // Size the track to the data instead of a guessed constant, so the far end
  // of the slider is always reachable and never dead travel.
  const max = Math.ceil(getMaxPredictedHeight());
  if (max > 0) slider.max = String(max);

  const update = (): void => {
    const metres = Number(slider.value);
    const stats = setMinHeight(metres);

    if (valueEl) {
      valueEl.textContent = metres <= 0 ? 'All heights' : `≥ ${metres.toFixed(1)} m`;
    }
    if (countEl && stats) {
      countEl.textContent =
        metres <= 0 ? '' : `${stats.visible.toLocaleString()} shown`;
    }
    onChange(stats);
  };

  slider.addEventListener('input', update);
  update();
}

/** Buildings on/off, and the Height/Error colour radios. */
function setupLayers(
  activateMode: (id: ModeId) => void,
  onChange: (stats: ModeStats | undefined) => void,
): void {
  const buildingsToggle = document.getElementById(
    'layer-buildings',
  ) as HTMLInputElement | null;

  buildingsToggle?.addEventListener('change', () => {
    onChange(setBuildingsVisible(buildingsToggle.checked));
  });

  const host = document.getElementById('colour-radios');
  if (!host) return;

  /*
   * Radios, not checkboxes. Only one colour scheme can be on the fill at a
   * time, and a checkbox that silently unticks its neighbour is a worse lie
   * than a control that looks single-choice from the start.
   */
  for (const id of COLOUR_MODES) {
    const mode = getMode(id);

    const label = document.createElement('label');
    label.className = 'radio';

    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'colour-mode';
    input.value = id;
    input.checked = id === (ENABLED_MODES[0] ?? DEFAULT_MODE);
    input.addEventListener('change', () => {
      if (input.checked) activateMode(id);
    });

    const text = document.createElement('span');
    text.textContent = mode.label === 'Predicted' ? 'Height' : mode.label;

    label.append(input, text);
    host.append(label);
  }
}

const DIMENSIONS: Array<{ id: Dimension; label: string; title: string }> = [
  { id: '2d', label: '2D', title: 'Flat footprints on the ground' },
  { id: '3d', label: '3D', title: 'Extruded by predicted height' },

];

/**
 * Build the 2D / 3D switcher.
 *
 * Separate from the mode switcher because it answers a different question:
 * modes choose *which value* is shown, this chooses *how* it is drawn. Both
 * stay usable together — 2D + error colouring is a perfectly good map.
 */
function setupLayerSwitcher(): void {
  const panel = document.getElementById('layers');
  const host = document.getElementById('layer-buttons');
  if (!panel || !host) return;

  const buttons = new Map<Dimension, HTMLButtonElement>();

  const activate = (id: Dimension): void => {
    setDimension(id);
    for (const [buttonId, button] of buttons) {
      const active = buttonId === id;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    // Selection highlight is overwritten by the restyle; let interaction.ts
    // put it back, same as after a mode change.
    window.dispatchEvent(new CustomEvent('sar:modechange', { detail: { dimension: id } }));
  };

  for (const dimension of DIMENSIONS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mode-button';
    button.textContent = dimension.label;
    button.title = dimension.title;
    button.addEventListener('click', () => activate(dimension.id));
    host.append(button);
    buttons.set(dimension.id, button);
  }

  activate(DEFAULT_DIMENSION);
  panel.hidden = false;
}

/** Build the mode switcher and return a function that activates a mode. */
function setupModeSwitcher(): (id: ModeId) => void {
  const panel = document.getElementById('modes');
  const host = document.getElementById('mode-buttons');

  const buttons = new Map<ModeId, HTMLButtonElement>();

  const activate = (id: ModeId): void => {
    const mode = getMode(id);
    // Stats are still computed but no longer shown in the panel — they go to
    // the console so the numbers stay available without taking up UI space.
    const stats = applyMode(id);
    console.debug(`[sar-building-3d] ${mode.label}: ${formatStats(stats)}`);
    renderStats(stats);

    for (const [buttonId, button] of buttons) {
      const active = buttonId === id;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }

    // Only offer a "no value" swatch when some feature actually has none.
    renderLegend(mode.ramp, mode.legendTitle, {
      includeNoData: (stats?.missingColor ?? 0) > 0,
    });

    // Let interaction.ts re-apply the selection highlight and readout.
    window.dispatchEvent(new CustomEvent('sar:modechange', { detail: { id } }));
  };

  const enabled = MODES.filter((mode) => ENABLED_MODES.includes(mode.id));

  // With a single mode there is nothing to switch between, so the panel and
  // its shortcuts are skipped entirely rather than rendered as one dead button.
  if (enabled.length < 2) {
    if (panel) panel.hidden = true;
    return activate;
  }

  if (host) {
    enabled.forEach((mode, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mode-button';
      button.textContent = mode.label;
      button.title = `${mode.legendTitle}  (${index + 1})`;
      button.addEventListener('click', () => activate(mode.id));
      host.append(button);
      buttons.set(mode.id, button);
    });
  }

  // Number keys switch modes; ignore while typing in a field.
  window.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement) return;
    const index = Number(event.key) - 1;
    if (Number.isInteger(index) && index >= 0 && index < enabled.length) {
      activate(enabled[index].id);
    }
  });

  if (panel) panel.hidden = false;
  return activate;
}

async function main(): Promise<void> {
  const viewer = createViewer('cesiumContainer');
  setupInteraction(viewer);
  enableCameraCapture(viewer);

  // With the intro on, start in orbit above the target; the descent runs once
  // the buildings are loaded, so they are already there on arrival. Without
  // it, land on HOME_VIEW immediately. The Home button returns here either way.
  if (HOME_VIEW) {
    bindHomeButton(viewer, HOME_VIEW);
    if (INTRO_ENABLED) {
      setWorldView(viewer, HOME_VIEW);
    } else {
      flyToView(viewer, HOME_VIEW);
    }
  }

  if (!USING_ION) {
    console.info(
      '[sar-building-3d] No VITE_CESIUM_ION_TOKEN set — using OpenStreetMap imagery and ellipsoid terrain.',
    );
  }

  setStatus('Loading buildings…');

  try {
    const result = await loadBuildings(viewer, BUILDINGS_URL);

    if (result.count === 0) {
      setStatus(
        'GeoJSON loaded but contained no polygon features. Footprints must be Polygon or MultiPolygon.',
        'error',
      );
      return;
    }

    const activate = setupModeSwitcher();
    activate(ENABLED_MODES[0] ?? DEFAULT_MODE);
    setupLayerSwitcher();
    setupLayers(activate, renderStats);
    setupHeightFilter(renderStats);

    // No success toast — the buildings appearing is confirmation enough, and
    // a banner over the map on every load is noise. Errors still surface,
    // because a blank map with no message is the case that needs explaining.
    clearStatus(0);

    // Camera last, so the buildings are in place before the descent begins.
    if (HOME_VIEW) {
      if (INTRO_ENABLED) await playIntro(viewer, HOME_VIEW);
    } else {
      await frameDataSource(viewer, result.dataSource);
    }
  } catch (error) {
    console.error(error);
    setStatus(
      `Could not load ${BUILDINGS_URL}. Check the file exists in public/data/ and is EPSG:4326 GeoJSON — see README.`,
      'error',
    );
  }
}

void main();
