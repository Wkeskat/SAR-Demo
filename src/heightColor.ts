import * as Cesium from 'cesium';

export interface RampClass {
  /** Inclusive lower bound. -Infinity for the open-ended bottom class. */
  min: number;
  /** Exclusive upper bound. Infinity for the open-ended top class. */
  max: number;
  color: Cesium.Color;
  label: string;
}

export interface ColorRamp {
  classes: RampClass[];
  /** Fill used when a feature carries no usable value for this ramp. */
  noDataColor: Cesium.Color;
  /** Optional note rendered under the legend rows. */
  note?: string;
}

/** Alpha applied to every footprint fill. */
export const FILL_ALPHA = 1 ;

const NO_DATA = Cesium.Color.fromCssColorString('#9e9e9e');

const c = (hex: string): Cesium.Color => Cesium.Color.fromCssColorString(hex);

/**
 * Sequential ramp for absolute height, shared by the predicted and reference
 * modes so the two are directly comparable by eye — switching modes must
 * change the picture only because the data changed, not the scale.
 *
 * Bins are tuned to the test_3d_map dataset: predicted heights run
 * 0.76–29.6 m (median 6.9) and true heights 3.0–49.4 m (median 7.4).
 * City-scale breaks at 24/45/80 m would flatten nearly every footprint into
 * one colour.
 *
 * Occupancy across the 5,582 features, predicted / true (%):
 *   14.3/11.8 · 23.9/23.0 · 26.0/24.1 · 22.0/25.0 · 10.0/11.5 · 3.5/4.2 · 0.3/0.3
 * The two distributions track each other closely — which is itself the
 * headline: unlike the earlier export, this model is not systematically
 * biased. Both modes share this ramp so that similarity is visible.
 */
export const HEIGHT_RAMP: ColorRamp = {
  noDataColor: NO_DATA,
  classes: [
    { min: -Infinity, max: 2, color: c('#fef0d9'), label: '< 2 m' },
    { min: 2, max: 4, color: c('#fdd8a4'), label: '2 – 4 m' },
    { min: 4, max: 6, color: c('#fdb77a'), label: '4 – 6 m' },
    { min: 6, max: 9, color: c('#fc8d59'), label: '6 – 9 m' },
    { min: 9, max: 14, color: c('#eb6040'), label: '9 – 14 m' },
    { min: 14, max: 20, color: c('#d33122'), label: '14 – 20 m' },
    { min: 20, max: Infinity, color: c('#b30000'), label: '≥ 20 m' },
  ],
};

/**
 * Diverging ramp for signed error, predicted − true, in metres.
 *
 * SIGN CONVENTION follows the dataset's own `height_error_m` field
 * (verified as predicted − true for all 5,582 features), so the map and the
 * source column never disagree. Negative means SAR under-predicted.
 *
 * Breaks are at ±1 m and ±3 m to match the dataset's `quality_flag`
 * thresholds exactly — the centre band is precisely the "good" class, so
 * colour and flag cannot tell different stories.
 *
 * Occupancy: 0.9 / 2.9 / 26.5 / 53.8 / 14.4 / 1.5 %.
 */
export const ERROR_RAMP: ColorRamp = {
  noDataColor: NO_DATA,
  note: '− = SAR under-predicts',
  classes: [
    { min: -Infinity, max: -5, color: c('#2166ac'), label: '< −5 m' },
    { min: -5, max: -3, color: c('#67a9cf'), label: '−5 – −3 m' },
    { min: -3, max: -1, color: c('#a8cee3'), label: '−3 – −1 m' },
    { min: -1, max: 1, color: c('#d8d8d8'), label: '±1 m (good)' },
    { min: 1, max: 3, color: c('#f4a582'), label: '1 – 3 m' },
    { min: 3, max: Infinity, color: c('#b2182b'), label: '≥ 3 m' },
  ],
};

/**
 * Sequential ramp for footprint IoU — how well the predicted outline agrees
 * with the reference one. Runs 0.27–0.99 (median 0.89), so the useful
 * resolution is all above 0.7 and the bins are weighted there.
 *
 * Occupancy: 0.4 / 4.7 / 10.7 / 43.1 / 33.9 / 7.3 %.
 */
export const IOU_RAMP: ColorRamp = {
  noDataColor: NO_DATA,
  note: 'footprint overlap',
  classes: [
    { min: -Infinity, max: 0.5, color: c('#a50026'), label: '< 0.50' },
    { min: 0.5, max: 0.7, color: c('#f46d43'), label: '0.50 – 0.70' },
    { min: 0.7, max: 0.8, color: c('#fee08b'), label: '0.70 – 0.80' },
    { min: 0.8, max: 0.9, color: c('#d9ef8b'), label: '0.80 – 0.90' },
    { min: 0.9, max: 0.95, color: c('#66bd63'), label: '0.90 – 0.95' },
    { min: 0.95, max: Infinity, color: c('#1a9850'), label: '≥ 0.95' },
  ],
};

export function colorFromRamp(ramp: ColorRamp, value: number | undefined): Cesium.Color {
  if (value === undefined || !Number.isFinite(value)) {
    return ramp.noDataColor.withAlpha(FILL_ALPHA);
  }
  const cls = ramp.classes.find((k) => value >= k.min && value < k.max);
  const base = cls ? cls.color : ramp.classes[ramp.classes.length - 1].color;
  return base.withAlpha(FILL_ALPHA);
}

/** Render legend rows for a ramp into #legend-items and reveal the panel. */
export function renderLegend(
  ramp: ColorRamp,
  title: string,
  options: { includeNoData?: boolean } = {},
): void {
  const panel = document.getElementById('legend');
  const host = document.getElementById('legend-items');
  const titleEl = document.getElementById('legend-title');
  if (!panel || !host) return;

  if (titleEl) titleEl.textContent = title;
  host.textContent = '';

  // Tallest / most-positive first, so the legend reads the way the scene does.
  const rows: Array<{ color: Cesium.Color; label: string }> = [...ramp.classes].reverse();
  if (options.includeNoData) {
    rows.push({ color: ramp.noDataColor, label: 'no value' });
  }

  for (const row of rows) {
    const el = document.createElement('div');
    el.className = 'legend-row';

    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    const solid = row.color.withAlpha(1);
    swatch.style.background = solid.toCssColorString();
    // Faint outer glow in the swatch's own colour — the design system's
    // "light emission" treatment. It also lifts the darker end of the ramp,
    // which otherwise sinks into the dark panel background.
    swatch.style.boxShadow = `0 0 6px ${row.color.withAlpha(0.55).toCssColorString()}`;

    const label = document.createElement('span');
    label.className = 'legend-label';
    label.textContent = row.label;

    el.append(swatch, label);
    host.append(el);
  }

  if (ramp.note) {
    const note = document.createElement('div');
    note.className = 'legend-note';
    note.textContent = ramp.note;
    host.append(note);
  }

  panel.hidden = false;
}
