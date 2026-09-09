import type { ColorRamp } from './heightColor';
import { ERROR_RAMP, HEIGHT_RAMP, IOU_RAMP } from './heightColor';
import type { BuildingInfo } from './buildings';

export type ModeId = 'predicted' | 'reference' | 'error' | 'iou';

export interface Mode {
  id: ModeId;
  /** Button text. */
  label: string;
  /** Legend heading. */
  legendTitle: string;
  ramp: ColorRamp;
  /** Value driving the fill colour. */
  colorValue: (info: BuildingInfo) => number | undefined;
  /** Value driving the extrusion, in metres. */
  extrusion: (info: BuildingInfo) => number | undefined;
  /** Shown in the attribute panel as the headline figure. */
  readout: (info: BuildingInfo) => string;
}

export const MODES: Mode[] = [
  {
    id: 'predicted',
    label: 'Predicted',
    legendTitle: 'SAR predicted height',
    ramp: HEIGHT_RAMP,
    colorValue: (i) => i.predicted,
    extrusion: (i) => i.predicted,
    readout: (i) =>
      i.predicted !== undefined ? `${i.predicted.toFixed(2)} m predicted` : 'no prediction',
  },
  {
    id: 'reference',
    label: 'True',
    legendTitle: 'True height (height_true_m)',
    ramp: HEIGHT_RAMP,
    colorValue: (i) => i.reference,
    extrusion: (i) => i.reference,
    readout: (i) =>
      i.reference !== undefined ? `${i.reference.toFixed(2)} m true` : 'no true height',
  },
  {
    id: 'error',
    /**
     * Extrudes by true height but colours by the signed error, so the
     * geometry stays a recognisable city while colour carries the residual.
     * Extruding by the error itself would produce a meaningless skyline.
     */
    label: 'Error',
    legendTitle: 'Error (predicted − true)',
    ramp: ERROR_RAMP,
    colorValue: (i) => i.error,
    extrusion: (i) => i.reference ?? i.predicted,
    readout: (i) => {
      if (i.error === undefined) return 'no comparison';
      const sign = i.error > 0 ? '+' : '';
      const dir = i.error < 0 ? 'under' : 'over';
      return `${sign}${i.error.toFixed(2)} m (SAR ${dir}-predicts)`;
    },
  },
  {
    /**
     * Footprint agreement, not height. Kept in the same switcher because it
     * answers the obvious follow-up to a height error: is the outline even
     * the same building? Extrudes by true height so the city stays readable.
     */
    id: 'iou',
    label: 'IoU',
    legendTitle: 'Footprint IoU',
    ramp: IOU_RAMP,
    colorValue: (i) => i.iou,
    extrusion: (i) => i.reference ?? i.predicted,
    readout: (i) => (i.iou !== undefined ? `IoU ${i.iou.toFixed(3)}` : 'no IoU'),
  },
];

export const DEFAULT_MODE: ModeId = 'predicted';

export function getMode(id: ModeId): Mode {
  const mode = MODES.find((m) => m.id === id);
  if (!mode) throw new Error(`Unknown mode: ${id}`);
  return mode;
}
