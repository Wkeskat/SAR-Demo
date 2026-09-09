import * as Cesium from 'cesium';
import { colorFromRamp, FILL_ALPHA } from './heightColor';
import type { Mode, ModeId } from './modes';
import { DEFAULT_MODE, getMode } from './modes';

/**
 * Property names accepted for the SAR-predicted height, in priority order.
 * Resolved rather than hardcoded because SAR toolchains name this differently.
 */
const PREDICTED_KEYS = [
  'height_pred_m',
  'predicted_height_m',
  'predicted_height',
  'pred_height',
  'height_pred',
  'h_pred',
];

/** Property names accepted for the reference/ground-truth height. */
const REFERENCE_KEYS = [
  'height_true_m',
  'BL_HEIGHT',
  'bl_height',
  'ref_height',
  'height_ref',
  'uav_height',
  'height',
  'Height',
  'HEIGHT',
  'height_m',
  'mean_height',
];

/**
 * Pre-computed error field, used only when one of the heights is missing.
 *
 * SIGN: this project's convention is predicted − true, matching
 * `height_error_m`. Note that the older `Diff_UAV_Prer` field used the
 * opposite sign (true − predicted), so it is negated on read.
 */
const ERROR_KEYS = ['height_error_m', 'error_m', 'residual'];
const NEGATED_ERROR_KEYS = ['Diff_UAV_Prer'];

/** Footprint agreement between predicted and reference outlines, 0–1. */
const IOU_KEYS = ['iou', 'IoU', 'iou_score', 'overlap'];

/** Fallback for reference height: storey count × floor-to-floor height. */
const LEVEL_KEYS = [
  'BL_NSTOREY',
  'levels',
  'building:levels',
  'storeys',
  'stories',
  'floors',
  'num_floors',
];
const METRES_PER_LEVEL = 3.2;

/** Property names accepted as a stable feature identifier. */
const ID_KEYS = [
  'building_id',
  'bldg_id',
  'serial',
  'objectid',
  'gid',
  'fid',
  'FID',
  'id',
  'ID',
  'serial',
  'osm_id',
  'uid',
];

/**
 * Minimum extrusion so a near-zero-height footprint stays visible.
 * Kept small because predictions in this dataset go down to ~0.4 m — a
 * larger floor would silently inflate the shortest buildings.
 */
const MIN_EXTRUSION = 0.5;

/**
 * Edge colour. A light translucent line rather than black: on a dark basemap
 * black outlines read as gaps between buildings, and across thousands of
 * small footprints they add up to a muddy grey wash.
 */
const OUTLINE_COLOR = Cesium.Color.BLACK.withAlpha(0.18);

/**
 * Height, metres, at which 2D footprints float above the ground.
 *
 * Enough to win the depth test against the globe surface, small enough to be
 * invisible at any sane viewing distance. Zero would put the polygon exactly
 * coplanar with the globe and z-fight.
 */
const FLAT_OFFSET = 1.5;

export interface BuildingInfo {
  /** SAR-predicted height, metres. */
  predicted?: number;
  /** Reference height, metres. */
  reference?: number;
  /** predicted − true, metres. Negative means SAR under-predicted. */
  error?: number;
  /** Footprint IoU between predicted and reference outlines, 0–1. */
  iou?: number;
  /** Which property each value came from, for traceability in the panel. */
  sources: { predicted?: string; reference?: string; error?: string };
  id?: string;
  /** Every raw GeoJSON property, for the attribute table. */
  raw: Record<string, unknown>;
}

/**
 * How footprints are drawn.
 *  '3d' — extruded by the active mode's height field.
 *  '2d' — flat polygons clamped to the ground, same fill colours.
 *
 * These are two renderings of one dataset rather than two layers, so they
 * cannot be shown together (the flat polygons would z-fight with the base of
 * the extrusions) and there is nothing to keep in sync between them.
 */
export type Dimension = '2d' | '3d';

export const DEFAULT_DIMENSION: Dimension = '2d';

const infoByEntity = new WeakMap<Cesium.Entity, BuildingInfo>();
let styledEntities: Cesium.Entity[] = [];
/** Held so applyMode can batch its entity writes into one visualizer update. */
let currentDataSource: Cesium.GeoJsonDataSource | undefined;
let currentMode: Mode = getMode(DEFAULT_MODE);
let currentDimension: Dimension = DEFAULT_DIMENSION;
/** Buildings shorter than this are hidden. 0 = show everything. */
let minHeightFilter = 0;
/** Master visibility for the whole building layer. */
let buildingsVisible = true;

export function getCurrentDimension(): Dimension {
  return currentDimension;
}

export function getBuildingInfo(entity: Cesium.Entity): BuildingInfo | undefined {
  return infoByEntity.get(entity);
}

export function getCurrentMode(): Mode {
  return currentMode;
}

export interface ModeStats {
  /** Features with a usable value in the active mode. */
  withValue: number;
  /**
   * Features with no usable value for the mode's COLOUR field — these render
   * in the ramp's noDataColor. Drives whether the legend shows a "no value"
   * swatch at all; showing one for a category that cannot occur invites the
   * reader to go looking for grey buildings that aren't there.
   */
  missingColor: number;
  /** Buildings currently visible, i.e. passing the height filter. */
  visible: number;
  /** Total buildings loaded, filter ignored. */
  total: number;
  min: number;
  max: number;
  mean: number;
  median: number;
}

export interface LoadResult {
  dataSource: Cesium.GeoJsonDataSource;
  count: number;
}

function firstNumber(
  props: Record<string, unknown>,
  keys: string[],
): { value: number; key: string } | undefined {
  for (const key of keys) {
    const raw = props[key];
    if (raw === null || raw === undefined || raw === '') continue;
    const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[^\d.\-+eE]/g, ''));
    if (Number.isFinite(n)) return { value: n, key };
  }
  return undefined;
}

function firstString(props: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const raw = props[key];
    if (raw === null || raw === undefined || raw === '') continue;
    return String(raw);
  }
  return undefined;
}

function resolveInfo(props: Record<string, unknown>): BuildingInfo {
  const predicted = firstNumber(props, PREDICTED_KEYS);

  let reference = firstNumber(props, REFERENCE_KEYS);
  let referenceSource = reference?.key;
  if (!reference || reference.value <= 0) {
    const levels = firstNumber(props, LEVEL_KEYS);
    if (levels && levels.value > 0) {
      reference = { value: levels.value * METRES_PER_LEVEL, key: levels.key };
      referenceSource = `${levels.key} × ${METRES_PER_LEVEL} m`;
    }
  }

  // Prefer computing the residual ourselves — a stored error field can be
  // stale relative to the heights it was derived from.
  let error: number | undefined;
  let errorSource: string | undefined;
  if (predicted && reference) {
    error = predicted.value - reference.value;
    errorSource = 'computed';
  } else {
    const stored = firstNumber(props, ERROR_KEYS);
    if (stored) {
      error = stored.value;
      errorSource = stored.key;
    } else {
      const flipped = firstNumber(props, NEGATED_ERROR_KEYS);
      if (flipped) {
        error = -flipped.value;
        errorSource = `−${flipped.key}`;
      }
    }
  }

  return {
    predicted: predicted?.value,
    reference: reference?.value,
    error,
    iou: firstNumber(props, IOU_KEYS)?.value,
    sources: {
      predicted: predicted?.key,
      reference: referenceSource,
      error: errorSource,
    },
    id: firstString(props, ID_KEYS),
    raw: props,
  };
}

/** Restyle and re-extrude every footprint for the given mode. */
export function applyMode(modeId: ModeId): ModeStats | undefined {
  currentMode = getMode(modeId);
  const values: number[] = [];
  let missingColor = 0;

  // Batch the whole restyle into one visualizer update. Without this, each of
  // the ~6 property writes per entity fires its own change event — roughly
  // 33,000 events across 5,582 buildings, each one nudging Cesium to
  // re-evaluate geometry. This is the difference between a pause and a stall.
  currentDataSource?.entities.suspendEvents();

  for (const entity of styledEntities) {
    const polygon = entity.polygon;
    const info = infoByEntity.get(entity);
    if (!polygon || !info) continue;

    const colorValue = currentMode.colorValue(info);
    const height = currentMode.extrusion(info);

    /*
     * The filter always tests PREDICTED height, not the active mode's value.
     * "Show buildings over 12 m" has to mean the same set of buildings
     * whichever colouring is on screen — filtering by the error value in
     * error mode would silently change what "over 12" selects.
     */
    const filterValue = info.predicted ?? info.reference;
    const passesFilter =
      minHeightFilter <= 0 || (filterValue !== undefined && filterValue >= minHeightFilter);

    entity.show = buildingsVisible && passesFilter;

    if (!passesFilter) continue;

    if (height !== undefined && Number.isFinite(height)) values.push(height);
    if (colorValue === undefined || !Number.isFinite(colorValue)) missingColor += 1;

    polygon.material = new Cesium.ColorMaterialProperty(
      colorFromRamp(currentMode.ramp, colorValue),
    );

    if (currentDimension === '3d') {
      polygon.height = new Cesium.ConstantProperty(0);
      polygon.heightReference = new Cesium.ConstantProperty(
        Cesium.HeightReference.CLAMP_TO_GROUND,
      );
      polygon.extrudedHeight = new Cesium.ConstantProperty(
        Math.max(height ?? 0, MIN_EXTRUSION),
      );
      polygon.outline = new Cesium.ConstantProperty(true);
    } else {
      // Flat, but lifted FLAT_OFFSET above the ground rather than draped on it.
      //
      // Draping (height undefined + classificationType TERRAIN) makes Cesium
      // build a GroundPrimitive, which means generating a classification
      // shadow volume per footprint — far more expensive than the polygon
      // itself, and the reason switching to 2D stalled. A small vertical
      // offset clears the depth conflict just as well for a fraction of the
      // cost, keeps outlines working (GroundPrimitives cannot draw them), and
      // still follows terrain correctly via RELATIVE_TO_GROUND.
      polygon.height = new Cesium.ConstantProperty(FLAT_OFFSET);
      polygon.heightReference = new Cesium.ConstantProperty(
        Cesium.HeightReference.RELATIVE_TO_GROUND,
      );
      polygon.extrudedHeight = undefined;
      polygon.outline = new Cesium.ConstantProperty(true);
    }
  }

  currentDataSource?.entities.resumeEvents();

  if (values.length === 0) {
    return {
      withValue: 0,
      missingColor,
      visible: 0,
      total: styledEntities.length,
      min: 0,
      max: 0,
      mean: 0,
      median: 0,
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    withValue: values.length,
    missingColor,
    visible: values.length,
    total: styledEntities.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    median:
      sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid],
  };
}

/**
 * Hide buildings shorter than `metres`. 0 shows everything.
 * Tests predicted height regardless of the active colour mode.
 */
export function setMinHeight(metres: number): ModeStats | undefined {
  minHeightFilter = metres;
  return applyMode(currentMode.id);
}

/** Show or hide the entire building layer. */
export function setBuildingsVisible(visible: boolean): ModeStats | undefined {
  buildingsVisible = visible;
  return applyMode(currentMode.id);
}

/** Largest predicted height in the dataset — used to size the filter slider. */
export function getMaxPredictedHeight(): number {
  let max = 0;
  for (const entity of styledEntities) {
    const info = infoByEntity.get(entity);
    const value = info?.predicted ?? info?.reference;
    if (value !== undefined && value > max) max = value;
  }
  return max;
}

/**
 * Load building footprints and extrude them by height.
 * Footprints are clamped to terrain and extruded relative to ground so the
 * result is correct whether or not world terrain is enabled.
 */
export async function loadBuildings(
  viewer: Cesium.Viewer,
  url: string,
): Promise<LoadResult> {
  const dataSource = await Cesium.GeoJsonDataSource.load(url, {
    clampToGround: false,
  });

  const now = Cesium.JulianDate.now();
  styledEntities = [];
  currentDataSource = dataSource;

  // Suspend change events so thousands of entities mutate in one batch.
  dataSource.entities.suspendEvents();

  for (const entity of dataSource.entities.values) {
    const polygon = entity.polygon;
    if (!polygon) continue;

    const props =
      (entity.properties?.getValue(now) as Record<string, unknown> | undefined) ?? {};
    infoByEntity.set(entity, resolveInfo(props));

    // Geometry setup that does not change between modes or dimensions.
    // height / heightReference / extrudedHeight / outline / classificationType
    // are all owned by applyMode, because 2D and 3D need different values.
    polygon.extrudedHeightReference = new Cesium.ConstantProperty(
      Cesium.HeightReference.RELATIVE_TO_GROUND,
    );
    polygon.perPositionHeight = new Cesium.ConstantProperty(false);
    polygon.outlineColor = new Cesium.ConstantProperty(OUTLINE_COLOR);
    polygon.outlineWidth = new Cesium.ConstantProperty(1);
    polygon.closeTop = new Cesium.ConstantProperty(true);
    polygon.closeBottom = new Cesium.ConstantProperty(false);
    polygon.shadows = new Cesium.ConstantProperty(Cesium.ShadowMode.ENABLED);

    // GeoJsonDataSource attaches billboards/labels on some inputs; drop them
    // so the scene is footprints only.
    entity.billboard = undefined;
    entity.label = undefined;
    entity.point = undefined;

    styledEntities.push(entity);
  }

  dataSource.entities.resumeEvents();
  await viewer.dataSources.add(dataSource);

  return { dataSource, count: styledEntities.length };
}

/**
 * Switch between flat footprints and extruded buildings.
 * Re-runs applyMode so fills and extrusions stay consistent in one pass.
 */
export function setDimension(dimension: Dimension): ModeStats | undefined {
  currentDimension = dimension;
  return applyMode(currentMode.id);
}

/** Restore an entity's fill for the active mode, after a highlight. */
export function resetFill(entity: Cesium.Entity): void {
  if (!entity.polygon) return;
  const info = infoByEntity.get(entity);
  const value = info ? currentMode.colorValue(info) : undefined;
  entity.polygon.material = new Cesium.ColorMaterialProperty(
    colorFromRamp(currentMode.ramp, value),
  );
}

/** Apply the hover/selection highlight fill. */
export function highlightFill(entity: Cesium.Entity, color: Cesium.Color): void {
  if (!entity.polygon) return;
  entity.polygon.material = new Cesium.ColorMaterialProperty(color.withAlpha(FILL_ALPHA));
}
