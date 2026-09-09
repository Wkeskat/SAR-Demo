# sar-building-3d

CesiumJS viewer for SAR-derived building footprints, extruded and coloured by height.

## Run

```bash
npm install
npm run dev
```

Optionally put a Cesium ion token in `.env` for world terrain and extra basemaps:

```
VITE_CESIUM_ION_TOKEN=eyJhbG...
```

Without a token the app runs off-ion: OpenStreetMap imagery, ellipsoid terrain. Nothing else changes.

## Basemap

Default is **`esri-dark`** — Esri Dark Gray Canvas pushed to near-black. No key, attribution required. Override at runtime without editing code:

| URL | Basemap |
|---|---|
| `?basemap=esri-dark` | Near-black (default, no key) |
| `?basemap=esri-dark-gray` | Esri Dark Gray Canvas unmodified, for comparison |
| `?basemap=osm-darkened` | Standard OSM tiles pushed dark and desaturated (no key) |
| `?basemap=none` | Flat dark globe, no imagery, no network |
| `?basemap=carto-dark` | CARTO Dark Matter — **needs `VITE_CARTO_API_KEY`** |

### Getting a true dark, not dark-grey

No key-free raster service ships a real Dark-Matter-style basemap. Esri's "Dark Gray Canvas" is mid-grey by design (land around `#303030`), which competes with the pale end of the height ramp. The `esri-dark` preset crushes it instead: `brightness 0.45`, `gamma 0.6`, `contrast 1.3` push land toward black while keeping roads as faint lines.

Dial it with **`?darkness=0..1`** — `0` is untouched Esri, `1` (default) is full crush, e.g. `?basemap=esri-dark&darkness=0.7`.

The cool cast is not from the tiles. `saturation` is 0 because the source is near-neutral and Cesium's `hue` knob does nothing to a desaturated image, so the layer sits at `alpha 0.88` over the dark blue globe `baseColor` in `viewer.ts` (`#070b12`) and is tinted from underneath. Change that colour to retint the whole basemap.

**CARTO is no longer key-free.** `basemaps.cartocdn.com` now stamps `API KEY REQUIRED` diagonally across every tile served without one. If you want it, get a key at <https://carto.com/basemaps/apikey> and put it in `.env`.

`osm-darkened` is the option that cannot stop being free — plain OSM tiles with Cesium's `brightness`/`saturation`/`gamma` adjustments. It reads charcoal-grey rather than true dark, because Cesium has no invert; there is no way to get a real dark cartographic style out of light tiles.

`none` is worth trying. At this footprint density the basemap is mostly hidden behind buildings anyway.

### If tiles don't load

Free tile endpoints change terms without notice, and Cesium logs nothing when tiles 404 — you get a blank dark globe. Check the Network tab for the tile requests. Two things that bite:

- **`{r}` is not a Cesium placeholder.** Leaflet's retina token is unsupported; leaving it in a template produces literal `.../123{r}.png` URLs that all 404 silently. Use `@2x` in the path with `tileWidth`/`tileHeight` of 512.
- **ArcGIS tile order is `{z}/{y}/{x}`** (level/row/col), not `{z}/{x}/{y}`.

## Input data

Current file: **`public/data/test_3d_map.geojson`** (5,582 polygons, Khon Kaen, CRS84). The path is set by `BUILDINGS_URL` at the top of `src/main.ts`.

Requirements for any replacement:

- **CRS: EPSG:4326** (lon/lat degrees). GeoJSON has no reprojection step — if your file is in UTM (e.g. EPSG:32647 for Thailand zone 47N) reproject first:
  `ogr2ogr -t_srs EPSG:4326 buildings.geojson input.shp`
- **Geometry: `Polygon` or `MultiPolygon`.** Points and lines are ignored; the app reports zero buildings if there are no polygons.
- 2D coordinates are fine. Z values in the ring are ignored (`perPositionHeight` is off); height comes from the attribute below.

### Height attributes

`buildings.ts` resolves each value from the first matching property, in order. Add your field to the relevant list at the top of that file rather than renaming your data.

| Value | Property names tried |
|---|---|
| predicted | `height_pred_m`, `predicted_height_m`, `predicted_height`, `pred_height`, `height_pred`, `h_pred` |
| true / reference | `height_true_m`, `BL_HEIGHT`, `bl_height`, `ref_height`, `height_ref`, `uav_height`, `height`, `Height`, `HEIGHT`, `height_m`, `mean_height` |
| storey fallback | `BL_NSTOREY`, `levels`, `building:levels`, `storeys`, `stories`, `floors`, `num_floors` — × `METRES_PER_LEVEL` (3.2 m), used only when no reference height exists |
| error | computed as `predicted − true`; falls back to `height_error_m`, `error_m`, `residual`, or negated `Diff_UAV_Prer` |
| IoU | `iou`, `IoU`, `iou_score`, `overlap` |

Values must be **metres**. Strings are coerced (`"12.5 m"` → `12.5`). Features with no usable value render grey at a 0.5 m minimum extrusion.

Error is recomputed from the two heights rather than read from the file, so it cannot go stale against them. The stored field is used only when one height is missing.

### Identifier

Optional. Read from the first of `id`, `ID`, `fid`, `FID`, `gid`, `building_id`, `bldg_id`, `osm_id`, `uid`. Shown in the attribute panel.

### Minimal example

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": { "building_id": "BKK-00412", "height": 27.4 },
      "geometry": {
        "type": "Polygon",
        "coordinates": [[
          [100.5010, 13.7560], [100.5013, 13.7560],
          [100.5013, 13.7563], [100.5010, 13.7563],
          [100.5010, 13.7560]
        ]]
      }
    }
  ]
}
```

## 2D / 3D

A **Buildings** panel, top-left, switches between extruded buildings and flat footprints. Colours are identical in both — only the extrusion changes.

These are two renderings of one dataset, not two layers, so they are mutually exclusive: flat polygons drawn under extrusions would z-fight with their own bases.

**Two traps in the 2D path, both already handled:**

- **`height = 0` z-fights.** A polygon at height zero is exactly coplanar with the globe surface, and with `depthTestAgainstTerrain` on the GPU picks a winner per pixel — footprints render torn and dithered. 2D uses `FLAT_OFFSET` (1.5 m) with `RELATIVE_TO_GROUND` instead: invisible at any real viewing distance, but enough to win the depth test.
- **Draping is slow.** Leaving `height` undefined with `classificationType: TERRAIN` makes Cesium build a `GroundPrimitive` — a classification shadow volume per footprint, far costlier than the polygon itself. Across 5,582 buildings that turned the toggle into a stall. The small offset avoids it entirely, and keeps outlines working, which GroundPrimitives cannot draw at all.

`applyMode` also brackets its entity writes in `suspendEvents()` / `resumeEvents()`. Without that, ~6 property writes × 5,582 entities fire roughly 33,000 individual change events, each prompting Cesium to re-evaluate geometry.

The two switchers are independent: 2D with error colouring is a perfectly good map, and often a clearer one for spotting spatial patterns in the residual.

Default is set by `DEFAULT_DIMENSION` in `src/buildings.ts`.

## View modes

Four modes, switched by the buttons top-left or the keys **1 / 2 / 3 / 4**:

| Mode | Extruded by | Coloured by |
|---|---|---|
| **Predicted** | `height_pred_m` | height, sequential ramp |
| **True** | `height_true_m` | height, **same** ramp |
| **Error** | `height_true_m` | `predicted − true`, diverging ramp |
| **IoU** | `height_true_m` | `iou`, sequential ramp |

Predicted and true deliberately share one ramp — switching modes must change the picture only because the data changed, not because the scale did.

Error and IoU extrude by *true* height and put the metric in colour only. Extruding by an error would produce a skyline that corresponds to nothing.

The panel under the buttons reports median / mean / range for the active mode.

### Sign convention

**Error is `predicted − true`, so negative means SAR under-predicted.** This matches the dataset's own `height_error_m` column (verified identical for all 5,582 features), so the map and the source data can never disagree about direction.

Note this is the *opposite* sign from the older GISTDA export's `Diff_UAV_Prer`, which stored `true − predicted`. `buildings.ts` negates that field on read so both files behave the same.

### Reading the error ramp

Breaks sit at ±1 m and ±3 m to match the dataset's `quality_flag` thresholds exactly — the grey centre band *is* the "good" class, so colour and flag always agree. Verified: `quality_flag` is derived from `abs(height_error_m)` at those thresholds for every feature.

| | share |
|---|---|
| under by > 5 m | 0.9 % |
| under by 3–5 m | 2.9 % |
| under by 1–3 m | 26.5 % |
| within ±1 m (good) | 53.8 % |
| over by 1–3 m | 14.4 % |
| over by > 3 m | 1.5 % |

RMSE is **1.62 m** with a mean bias of **−0.37 m** — near-unbiased. Predicted median 6.88 m against true median 7.38 m.

This is a large improvement over the earlier `predicted_building_heights_1.geojson`, where predicted median was 3.02 m against a reference median of 6.97 m — a systematic factor of ~2.3. If both files came from the same pipeline, whatever changed between them fixed a real calibration problem.

### Reading the IoU ramp

Footprint overlap between predicted and reference outlines, 0.27–0.99 (median 0.89). Only 20 of 5,582 features fall below 0.5, so a red building is worth looking at individually — it may be a merged or split footprint rather than a height error.

## Interaction

- **Hover** — footprint highlights yellow.
- **Click** — highlights cyan and opens the attribute panel: the active mode's readout, then predicted / reference / difference / ratio together, then every raw property. All three figures show regardless of mode, so you can read the residual without switching.
- **Escape** or the × — close the panel.
- **1 / 2 / 3** — switch mode.

### Choosing which attributes the popup shows

Edit **`ATTRIBUTE_FIELDS`** at the top of `src/interaction.ts` — an ordered allowlist of `{ key, label }`. `label` is optional; the raw key is used without it.

It is an allowlist because the source carries 30 properties and most hold nothing. Measured across all 8,440 features:

| Excluded | Fields |
|---|---|
| always null | `BL_HOUSENU`, `BL_VILLAGE`, `BL_SOI`, `BL_ROAD` |
| single value throughout | `BL_TYPE` (0), `BL_USE` (0), `BL_MATL` (0), `BL_POSTCOD` (0), `BL_DISTRIC`, `BL_CHANGWA`, `s2Id`, `quality_flag` (`ok`) |
| redundant identifiers | `fid`, `gid`, `gid2`, `objectid`, `globalId` — one ID row is enough |

That leaves 12–14 rows per building instead of 34. `HIDE_EMPTY` drops rows with no value, which is why the name fields appear only on the ~10% of buildings that have one.

Append **`?attrs=all`** to dump every property regardless — use it to inspect a new export before trimming the list again.

## Start-up camera position

By default the camera fits the loaded data's own extent, so there are no coordinates to change when the AOI moves.

To make it open at a fixed spot instead, set **`HOME_VIEW`** in `src/viewer.ts`:

```ts
export const HOME_VIEW: CameraView | undefined = {
  lon: 102.8611,   // degrees
  lat: 16.4273,
  height: 1200,    // metres above the ellipsoid
  heading: 20,     // 0 = north, 90 = east
  pitch: -40,      // -90 = straight down
};
```

Those numbers are the centre of the current AOI (span roughly 1.6 × 2.8 km, so `height` around 1200–2500 m frames it).

**Don't guess coordinates.** Run the app, fly to the view you want, press **`c`**, and a ready-made `HOME_VIEW` literal is printed to the console — paste it in.

Setting `HOME_VIEW` also points the Home button at that view instead of zooming out to the whole Earth.

Leave it `undefined` to go back to fitting the data.

### Opening flight

With `INTRO_ENABLED = true` (the default, in `viewer.ts`) the app opens on the whole globe and flies down to `HOME_VIEW` over 5 seconds.

The start position is directly above the target at 20,000 km looking straight down, not an arbitrary globe view — so the descent is one continuous move and the viewer can see where on Earth they are being taken.

- **Any click or key press skips it** and jumps straight to the destination.
- The flight runs *after* the GeoJSON has loaded, so the buildings are already in place when you arrive rather than popping in.
- `INTRO_START_HEIGHT` and `INTRO_DURATION` in `viewer.ts` control the altitude and pace.
- Set `INTRO_ENABLED = false` to land on `HOME_VIEW` immediately.

`scene.skyAtmosphere` is enabled for this — without it the opening frame is a bare sphere on black. It is barely visible at street level, so it costs nothing there; turn it off in `createViewer` if you drop the intro.

## Modules

| File | Role |
|---|---|
| `src/main.ts` | Entry point, load sequence, mode switcher, status messages |
| `src/viewer.ts` | Viewer construction, ion/off-ion switch, lighting, camera framing |
| `src/modes.ts` | The three view modes: value accessors, extrusion, ramp binding |
| `src/buildings.ts` | GeoJSON load, attribute resolution, `applyMode()` restyling |
| `src/heightColor.ts` | Colour ramps (sequential + diverging) and legend rendering |
| `src/interaction.ts` | Hover and click handling, attribute panel |

## Tuning

- **Colour bins** — `HEIGHT_RAMP` and `DIFF_RAMP` in `src/heightColor.ts`. Bin occupancy for this dataset is documented in the comments above each ramp.
- **Field names** — `PREDICTED_KEYS`, `REFERENCE_KEYS`, `LEVEL_KEYS`, `ID_KEYS` at the top of `src/buildings.ts`. Add your field there rather than renaming your data.
- **Floor height** — `METRES_PER_LEVEL` in `src/buildings.ts` (storey-count fallback when no reference height exists).
- **Minimum extrusion** — `MIN_EXTRUSION` in `src/buildings.ts`, 0.5 m. Only 2 features are clamped by it.

The difference is recomputed as `reference − predicted` rather than read from `Diff_UAV_Prer`, so it cannot go stale against the heights it came from. Verified identical to the stored field for all 8,440 features (max deviation 0.005 m).

## Performance note

`GeoJsonDataSource` builds one entity per feature, which is comfortable into the low tens of thousands of footprints. Past that, entity overhead dominates and the right move is converting to **3D Tiles** (`tilers` / `py3dtiles`, or Cesium ion's tiler) and loading via `Cesium3DTileset` with a styled `Cesium3DTileStyle` — the height ramp in `heightColor.ts` translates directly to a tile style expression.
