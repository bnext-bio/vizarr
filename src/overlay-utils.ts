import { Matrix4 } from "math.gl";

/** Metric OME-NGFF (UDUNITS-2) length units, in meters. Others are displayed as-is. */
const METERS_PER_UNIT: Record<string, number> = {
  kilometer: 1e3,
  hectometer: 1e2,
  decameter: 1e1,
  meter: 1,
  decimeter: 1e-1,
  centimeter: 1e-2,
  millimeter: 1e-3,
  micrometer: 1e-6,
  nanometer: 1e-9,
  angstrom: 1e-10,
  picometer: 1e-12,
  femtometer: 1e-15,
};

/** Units the scale bar may switch between as the zoom changes, largest first. */
const DISPLAY_UNITS: Array<[symbol: string, meters: number]> = [
  ["km", 1e3],
  ["m", 1],
  ["mm", 1e-3],
  ["µm", 1e-6],
  ["nm", 1e-9],
  ["pm", 1e-12],
];

/** Largest "nice" number (1, 2 or 5 × 10ⁿ) that is ≤ `value`. */
export function niceNumber(value: number): number {
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const fraction = value / base;
  const nice = fraction >= 5 ? 5 : fraction >= 2 ? 2 : 1;
  return nice * base;
}

export interface ScaleBar {
  /** Bar length in screen pixels. */
  width: number;
  /** Bar label, e.g. "50 µm". */
  label: string;
}

/**
 * Picks a scale bar no longer than `maxWidth` screen pixels.
 *
 * @param unitsPerScreenPixel - Size of one screen pixel in `unit`.
 * @param unit - An OME-NGFF unit name (e.g. "micrometer"). Unknown units (and "px")
 *   are shown as-is; known length units switch prefix to keep the label readable.
 */
export function computeScaleBar(unitsPerScreenPixel: number, unit: string, maxWidth = 120): ScaleBar | undefined {
  if (!Number.isFinite(unitsPerScreenPixel) || unitsPerScreenPixel <= 0) return undefined;
  const metersPerUnit = METERS_PER_UNIT[unit];
  if (metersPerUnit === undefined) {
    const length = niceNumber(unitsPerScreenPixel * maxWidth);
    return { width: length / unitsPerScreenPixel, label: `${formatNumber(length)} ${unit}` };
  }
  const maxMeters = unitsPerScreenPixel * maxWidth * metersPerUnit;
  const [symbol, metersPerSymbol] =
    DISPLAY_UNITS.find(([, m]) => maxMeters >= m) ?? (DISPLAY_UNITS.at(-1) as [string, number]);
  const length = niceNumber(maxMeters / metersPerSymbol);
  const width = (length * metersPerSymbol) / metersPerUnit / unitsPerScreenPixel;
  return { width, label: `${formatNumber(length)} ${symbol}` };
}

function formatNumber(n: number): string {
  // Avoid float noise like 0.30000000000000004 from 10ⁿ arithmetic.
  return String(Number(n.toPrecision(6)));
}

/** Uniform scale factor of a model matrix along x (world units per model unit). */
export function getMatrixScaleX(matrix: Matrix4 | undefined): number {
  if (!matrix) return 1;
  return Math.hypot(matrix[0], matrix[1], matrix[2]);
}

/**
 * Finds the grid cell (if any) under a world-space point.
 *
 * @param point - World coordinates (e.g. the view state's target).
 * @param cell - Base-resolution size of each grid cell, in pixels.
 */
export function getGridCellAt(
  point: [number, number],
  options: { modelMatrix?: Matrix4; cell: { width: number; height: number }; spacer: number },
): { row: number; column: number } | undefined {
  const { modelMatrix, cell, spacer } = options;
  const inverse = (modelMatrix ?? new Matrix4()).clone().invert();
  const [x, y] = inverse.transformAsPoint([point[0], point[1], 0]);
  const column = Math.floor(x / (cell.width + spacer));
  const row = Math.floor(y / (cell.height + spacer));
  // Ignore points that fall into the gap between cells.
  if (x - column * (cell.width + spacer) > cell.width || y - row * (cell.height + spacer) > cell.height) {
    return undefined;
  }
  return { row, column };
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("niceNumber", () => {
    it("rounds down to 1, 2 or 5 × 10ⁿ", () => {
      expect(niceNumber(1)).toBe(1);
      expect(niceNumber(1.9)).toBe(1);
      expect(niceNumber(4.99)).toBe(2);
      expect(niceNumber(73)).toBe(50);
      expect(niceNumber(0.031)).toBeCloseTo(0.02);
    });
  });

  describe("computeScaleBar", () => {
    it("picks a nice length in the source unit", () => {
      // 1 µm per screen pixel → at most 120 µm → 100 µm, 100px wide
      expect(computeScaleBar(1, "micrometer")).toEqual({ width: 100, label: "100 µm" });
    });

    it("switches to a larger unit when zoomed out", () => {
      // 20 µm per screen pixel → at most 2.4 mm → 2 mm, 100px wide
      const bar = computeScaleBar(20, "micrometer");
      expect(bar?.label).toBe("2 mm");
      expect(bar?.width).toBeCloseTo(100);
    });

    it("switches to a smaller unit when zoomed in", () => {
      // 0.002 µm per screen pixel → at most 240 nm → 200 nm
      const bar = computeScaleBar(0.002, "micrometer");
      expect(bar?.label).toBe("200 nm");
      expect(bar?.width).toBeCloseTo(100);
    });

    it("keeps unknown units as-is", () => {
      const bar = computeScaleBar(3, "px");
      expect(bar?.label).toBe("200 px");
      expect(bar?.width).toBeCloseTo(200 / 3);
    });

    it("returns undefined for degenerate input", () => {
      expect(computeScaleBar(0, "micrometer")).toBeUndefined();
      expect(computeScaleBar(Number.NaN, "micrometer")).toBeUndefined();
    });
  });

  describe("getGridCellAt", () => {
    const cell = { width: 100, height: 50 };

    it("finds the cell under a point", () => {
      expect(getGridCellAt([250, 60], { cell, spacer: 5 })).toEqual({ row: 1, column: 2 });
    });

    it("returns undefined in the gap between cells", () => {
      expect(getGridCellAt([102, 10], { cell, spacer: 5 })).toBeUndefined();
    });

    it("accounts for the model matrix", () => {
      const modelMatrix = new Matrix4().scale([2, 2, 1]);
      expect(getGridCellAt([250, 60], { modelMatrix, cell, spacer: 5 })).toEqual({ row: 0, column: 1 });
      expect(getMatrixScaleX(modelMatrix)).toBe(2);
    });
  });
}
