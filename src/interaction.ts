import * as Cesium from 'cesium';
import { getBuildingInfo, getCurrentMode, highlightFill, resetFill } from './buildings';

const HOVER_COLOR = Cesium.Color.fromCssColorString('#ffe066');
const SELECT_COLOR = Cesium.Color.fromCssColorString('#4dd2ff');

/** Raw properties already surfaced as headline rows — not repeated below. */
const PROMOTED_KEYS = new Set([
  'height_pred_m',
  'height_true_m',
  'height_error_m',
  'iou',
  // older schema
  'predicted_height_m',
  'BL_HEIGHT',
  'Diff_UAV_Prer',
]);

/**
 * EDIT HERE to change which raw attributes the popup lists, and in what order.
 *
 * An allowlist rather than a blocklist: the source has 30 properties and most
 * carry no information, so dumping all of them buries the few that matter.
 * `label` is optional — the raw key is used when it is omitted.
 *
 * Current schema (test_3d_map.geojson) carries 8 properties, 4 of which are
 * already headline rows. `abs_error_m` is omitted because it is just
 * |height_error_m|, which the error row shows with its sign intact.
 *
 * Excluded from the older GISTDA schema, measured across its 8,440 features:
 *   always null      BL_HOUSENU, BL_VILLAGE, BL_SOI, BL_ROAD
 *   single value     BL_TYPE (0), BL_USE (0), BL_MATL (0), BL_POSTCOD (0),
 *                    BL_DISTRIC, BL_CHANGWA, s2Id, quality_flag ('ok')
 *   redundant IDs    fid, gid, gid2, objectid, globalId — one ID row is enough
 * Those entries stay below, commented, so loading that export again is a
 * matter of uncommenting rather than rediscovering the field names.
 *
 * Append `?attrs=all` to the URL to bypass this list and dump every property
 * — useful when checking a new export before trimming the list again.
 */
const ATTRIBUTE_FIELDS: Array<{ key: string; label?: string }> = [
  { key: 'quality_flag', label: 'quality' },

  // Older GISTDA schema (predicted_building_heights_*.geojson)
  // { key: 'BL_NAME', label: 'name (TH)' },
  // { key: 'BL_NAM_E', label: 'name (EN)' },
  // { key: 'BL_NSTOREY', label: 'storeys' },
  // { key: 'BL_SUB_DIS', label: 'subdistrict' },
  // { key: 'BL_YEAR', label: 'survey year (BE)' },
  // { key: 'sources', label: 'source' },
  // { key: 'zone' },
  // { key: 'BL_LOD', label: 'LOD' },
  // { key: 'theta_deg_used', label: 'incidence θ (°)' },
];

/** Rows whose value is null/empty are skipped — most name fields are unset. */
const HIDE_EMPTY = true;

const SHOW_ALL_ATTRIBUTES = new URLSearchParams(window.location.search).get('attrs') === 'all';

function pickEntity(picked: unknown): Cesium.Entity | undefined {
  if (Cesium.defined(picked) && picked instanceof Object && 'id' in picked) {
    const id = (picked as { id: unknown }).id;
    if (id instanceof Cesium.Entity && id.polygon) return id;
  }
  return undefined;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function addRow(
  table: HTMLTableElement,
  label: string,
  value: string,
  primary = false,
): void {
  const tr = table.insertRow();
  if (primary) tr.className = 'is-primary';
  const th = document.createElement('th');
  th.textContent = label;
  const td = document.createElement('td');
  td.textContent = value;
  tr.append(th, td);
}

function positionPanel(
  viewer: Cesium.Viewer,
  panel: HTMLElement,
  entity: Cesium.Entity,
): void {
  if (!entity.polygon) return;

  const time = viewer.clock.currentTime;
  const hierarchy = entity.polygon.hierarchy?.getValue(time);

  if (!hierarchy || hierarchy.positions.length === 0) return;

  const center = Cesium.BoundingSphere.fromPoints(
    hierarchy.positions,
  ).center;

  const windowPosition =
    Cesium.SceneTransforms.worldToWindowCoordinates(
      viewer.scene,
      center,
    );

  if (!windowPosition) return;

  const margin = 16;
  const gap = 24 ;

  const panelWidth = panel.offsetWidth;
  const panelHeight = panel.offsetHeight;

  const canvasWidth = viewer.scene.canvas.clientWidth;
  const canvasHeight = viewer.scene.canvas.clientHeight;

  // Default: popup อยู่ด้านขวาของอาคาร
  let left = windowPosition.x + gap;
  let top = windowPosition.y - panelHeight / 2;

  // ถ้าพื้นที่ด้านขวาไม่พอ → ย้ายไปด้านซ้าย
  if (left + panelWidth > canvasWidth - margin) {
    left = windowPosition.x - panelWidth - gap;
  }

  // ป้องกัน Popup หลุดด้านบน/ล่าง
  top = Math.max(
    margin,
    Math.min(
      top,
      canvasHeight - panelHeight - margin,
    ),
  );

  // ป้องกัน Popup หลุดด้านซ้าย/ขวา
  left = Math.max(
    margin,
    Math.min(
      left,
      canvasWidth - panelWidth - margin,
    ),
  );

  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
  panel.style.transform = 'none';
}

export function setupInteraction(viewer: Cesium.Viewer): void {
  const panel = document.getElementById('info') as HTMLElement | null;
  const table = document.getElementById('info-table') as HTMLTableElement | null;
  const closeBtn = document.getElementById('info-close');

  let hovered: Cesium.Entity | undefined;
  let selected: Cesium.Entity | undefined;

  const clearSelection = (): void => {
    if (selected) {
      resetFill(selected);
      selected = undefined;
    }
    if (panel) panel.hidden = true;
  };

  /** Repopulate the panel — also called after a mode switch. */
  const renderPanel = (entity: Cesium.Entity): void => {
    if (!panel || !table) return;
    table.textContent = '';

    const info = getBuildingInfo(entity);
    if (!info) return;

    const mode = getCurrentMode();

    // Headline figure follows the active mode.
    addRow(table, mode.label, mode.readout(info), true);

    // All three comparison figures, always — the point of the panel is that
    // you can read the residual without switching modes.
    // addRow(
    //   table,
    //   'predicted',
    //   info.predicted !== undefined ? `${info.predicted.toFixed(2)} m` : '—',
    // );
    addRow(
      table,
      'reference',
      info.reference !== undefined ? `${info.reference.toFixed(2)} m` : '—',
    );
    addRow(
      table,
      'difference',
      info.error !== undefined
        ? `${info.error > 0 ? '+' : ''}${info.error.toFixed(2)} m`
        : '—',
    );
    // if (info.reference && info.predicted) {
    //   addRow(table, 'ratio pred/ref', (info.predicted / info.reference).toFixed(2));
    // }
    // if (info.id) addRow(table, 'ID', info.id);

    if (SHOW_ALL_ATTRIBUTES) {
      for (const [key, value] of Object.entries(info.raw)) {
        if (PROMOTED_KEYS.has(key)) continue;
        addRow(table, key, formatValue(value));
      }
    } else {
      for (const field of ATTRIBUTE_FIELDS) {
        if (PROMOTED_KEYS.has(field.key)) continue;
        const value = info.raw[field.key];
        const isEmpty = value === null || value === undefined || value === '';
        if (HIDE_EMPTY && isEmpty) continue;
        addRow(table, field.label ?? field.key, formatValue(value));
      }
    }

    panel.hidden = false;

    requestAnimationFrame(() => {
      positionPanel(viewer, panel, entity);
    });
  };

  closeBtn?.addEventListener('click', clearSelection);

  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

  handler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
    const entity = pickEntity(viewer.scene.pick(movement.endPosition));
    if (hovered === entity) return;

    if (hovered && hovered !== selected) resetFill(hovered);
    hovered = entity;
    if (hovered && hovered !== selected) highlightFill(hovered, HOVER_COLOR);

    viewer.canvas.style.cursor = entity ? 'pointer' : '';
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  handler.setInputAction((click: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
    const entity = pickEntity(viewer.scene.pick(click.position));
    if (selected) resetFill(selected);

    if (!entity) {
      clearSelection();
      return;
    }

    selected = entity;
    highlightFill(selected, SELECT_COLOR);
    renderPanel(selected);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') clearSelection();
  });

  viewer.camera.changed.addEventListener(() => {
  if (!selected || !panel || panel.hidden) return;

  positionPanel(viewer, panel, selected);
});

  /**
   * After a mode switch, applyMode() has overwritten every fill including
   * the selected building's. Re-apply the highlight and refresh the readout.
   */
  window.addEventListener('sar:modechange', () => {
    if (!selected) return;
    highlightFill(selected, SELECT_COLOR);
    renderPanel(selected);
  });
}
