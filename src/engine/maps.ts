import type { Vec2 } from "./execute-turn";
import type { TerrainPiece, TerrainType } from "./terrain";
import { makeLVariantRects } from "./terrain";

import standard48 from "../content/maps/standard-48.json";
import openMid48 from "../content/maps/open-mid-48.json";
import diagonalLanes48 from "../content/maps/diagonal-lanes-48.json";
import denseCenter48 from "../content/maps/dense-center-48.json";

export type MapId = "standard-48" | "open-mid-48" | "diagonal-lanes-48" | "dense-center-48";

type Orientation = 0 | 90 | 180 | 270;
export type LVariant = "FULL" | "SHORT_H" | "SHORT_V" | "CHUNKY";

export type TerrainPieceSpec = {
  id: string;
  type: TerrainType;
  origin: Vec2;
  orientation: Orientation;
  variant: LVariant;
};

export type MapLayout = {
  version: number;
  id: MapId;
  name: string;
  board: { sizeInches: number };
  terrainPieces: TerrainPieceSpec[];
};

function asMapLayout(v: any): MapLayout {
  if (!v || typeof v.id !== "string") throw new Error("Invalid map layout: missing id");
  if (!v.board || typeof v.board.sizeInches !== "number") throw new Error(`Invalid map layout ${v.id}: board.sizeInches`);
  if (!Array.isArray(v.terrainPieces)) throw new Error(`Invalid map layout ${v.id}: terrainPieces must be array`);
  return v as MapLayout;
}

export const MAP_LAYOUTS: Record<MapId, MapLayout> = {
  "standard-48": asMapLayout(standard48),
  "open-mid-48": asMapLayout(openMid48),
  "diagonal-lanes-48": asMapLayout(diagonalLanes48),
  "dense-center-48": asMapLayout(denseCenter48),
};

export function getMapLayout(id: MapId): MapLayout {
  const m = MAP_LAYOUTS[id];
  if (!m) throw new Error(`Unknown map layout: ${id}`);
  return m;
}

export function buildTerrainFromLayout(id: MapId): TerrainPiece[] {
  const layout = getMapLayout(id);
  return layout.terrainPieces.map((p) => ({
    id: p.id,
    type: p.type,
    rects: makeLVariantRects(p.origin, p.orientation, p.variant),
  }));
}

export function allMapIds(): MapId[] {
  return Object.keys(MAP_LAYOUTS) as MapId[];
}

export function mapOptions(): Array<{ id: MapId; name: string }> {
  return allMapIds().map((id) => ({ id, name: getMapLayout(id).name }));
}

export function pickRandomMapId(): MapId {
  const ids = allMapIds();
  return ids[Math.floor(Math.random() * ids.length)];
}
