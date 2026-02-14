import type { Vec2 } from "./execute-turn";

export type TerrainType = "HARD" | "SOFT";

export type Rect = { x: number; y: number; w: number; h: number };

// L-shaped terrain is represented as the union of two axis-aligned rectangles.
export type TerrainPiece = {
  id: string;
  type: TerrainType;
  rects: Rect[];
};

type Orientation = 0 | 90 | 180 | 270;

function rotatePoint(p: Vec2, o: Orientation, size: number): Vec2 {
  // rotate around the local (0,0) origin for a size×size bounding box
  // so the result remains within [0,size]×[0,size]
  switch (o) {
    case 0:
      return p;
    case 90:
      return { x: size - p.y, y: p.x };
    case 180:
      return { x: size - p.x, y: size - p.y };
    case 270:
      return { x: p.y, y: size - p.x };
  }
}

function rectFromCorners(a: Vec2, b: Vec2): Rect {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Create an L shape within a size×size box.
 *
 * To make terrain feel more distinct on the board, we support variants where
 * one arm is slightly shorter than the other (still within ~6"×6").
 *
 * - size: overall bounding size in inches (default 6)
 * - thickness: arm thickness in inches (default 2)
 * - vLen: vertical arm length (<= size)
 * - hLen: horizontal arm length (<= size)
 *
 * Local (unrotated) L:
 * - vertical arm: [0..thickness] × [0..vLen]
 * - horizontal arm: [0..hLen] × [0..thickness]
 */
export function makeLShapeRects(
  origin: Vec2,
  o: Orientation,
  size = 6,
  thickness = 2,
  vLen = 6,
  hLen = 6
): Rect[] {
  const vv = Math.max(1, Math.min(size, vLen));
  const hh = Math.max(1, Math.min(size, hLen));

  const rectsLocal: Rect[] = [
    { x: 0, y: 0, w: thickness, h: vv },
    { x: 0, y: 0, w: hh, h: thickness },
  ];

  const rectsWorld: Rect[] = [];

  for (const r of rectsLocal) {
    // rotate each rectangle by rotating its corners, then re-boxing
    const p1 = rotatePoint({ x: r.x, y: r.y }, o, size);
    const p2 = rotatePoint({ x: r.x + r.w, y: r.y + r.h }, o, size);
    // for axis-aligned rectangles under 90deg increments, corner-rotation is enough
    const rw = rectFromCorners(p1, p2);
    rectsWorld.push({ x: origin.x + rw.x, y: origin.y + rw.y, w: rw.w, h: rw.h });
  }

  return rectsWorld;
}

type LVariant = "FULL" | "SHORT_H" | "SHORT_V" | "CHUNKY";

export function makeLVariantRects(origin: Vec2, o: Orientation, variant: LVariant): Rect[] {
  // All variants stay within a 6×6 footprint.
  switch (variant) {
    case "FULL":
      return makeLShapeRects(origin, o, 6, 2, 6, 6);
    case "SHORT_H":
      return makeLShapeRects(origin, o, 6, 2, 6, 4);
    case "SHORT_V":
      return makeLShapeRects(origin, o, 6, 2, 4, 6);
    case "CHUNKY":
      return makeLShapeRects(origin, o, 6, 3, 6, 6);
  }
}

export function defaultTerrain48(): TerrainPiece[] {
  // Two HARD pieces and four SOFT pieces.
  // Placed to be "mid-board" and not collide with default spawns (6,24) and (42,24).
  return [
    // Hard cover: distinct rotations + one "chunky" piece so the silhouettes differ.
    { id: "H1", type: "HARD", rects: makeLVariantRects({ x: 17, y: 10 }, 90, "CHUNKY") },
    { id: "H2", type: "HARD", rects: makeLVariantRects({ x: 25, y: 32 }, 270, "FULL") },

    // Soft cover: use all four rotations and mix short-arm variants.
    { id: "S1", type: "SOFT", rects: makeLVariantRects({ x: 10, y: 30 }, 0, "SHORT_H") },
    { id: "S2", type: "SOFT", rects: makeLVariantRects({ x: 32, y: 12 }, 180, "SHORT_V") },
    { id: "S3", type: "SOFT", rects: makeLVariantRects({ x: 20, y: 22 }, 90, "FULL") },
    { id: "S4", type: "SOFT", rects: makeLVariantRects({ x: 22, y: 18 }, 270, "SHORT_H") },
  ];
}

export function pointInRect(p: Vec2, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

// Liang–Barsky segment-rect clipping. Returns the param tEnter of first intersection, or null.
export function segmentEnterT(a: Vec2, b: Vec2, r: Rect): number | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  let t0 = 0;
  let t1 = 1;

  const clip = (p: number, q: number) => {
    if (Math.abs(p) < 1e-9) {
      if (q < 0) return false;
      return true;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };

  const xMin = r.x;
  const xMax = r.x + r.w;
  const yMin = r.y;
  const yMax = r.y + r.h;

  if (!clip(-dx, a.x - xMin)) return null;
  if (!clip(dx, xMax - a.x)) return null;
  if (!clip(-dy, a.y - yMin)) return null;
  if (!clip(dy, yMax - a.y)) return null;

  // If the segment intersects, t0 is entry.
  if (t0 >= 0 && t0 <= 1) return t0;
  return null;
}

export function segmentIntersectsRects(a: Vec2, b: Vec2, rects: Rect[]): boolean {
  return rects.some((r) => segmentEnterT(a, b, r) !== null);
}

export function computeLosEffects(a: Vec2, b: Vec2, terrain: TerrainPiece[]): {
  /** Blocks ranged attacks only (hard cover). */
  blocked: boolean;
  /** True if LOS crosses any soft cover. */
  obscured: boolean;
  /** True if LOS crosses any cover of any type (hard or soft). */
  crossesAnyCover: boolean;
} {
  let obscured = false;
  let crossesAnyCover = false;
  for (const t of terrain) {
    if (!segmentIntersectsRects(a, b, t.rects)) continue;
    crossesAnyCover = true;
    if (t.type === "HARD") return { blocked: true, obscured: false, crossesAnyCover: true };
    if (t.type === "SOFT") obscured = true;
  }
  return { blocked: false, obscured, crossesAnyCover };
}

export function earliestObstacleEnterT(a: Vec2, b: Vec2, terrain: TerrainPiece[]): number | null {
  let best: number | null = null;
  for (const t of terrain) {
    for (const r of t.rects) {
      const te = segmentEnterT(a, b, r);
      if (te === null) continue;
      if (best === null || te < best) best = te;
    }
  }
  return best;
}
