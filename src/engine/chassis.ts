import type { GridTemplate } from "./grid";
import questorisData from "../content/chassis/questoris.json";

export type ChassisMovement = {
  advanceInches: number;
  chargeInches: number;
  runDice: string; // e.g. "2d6"
};

export type ChassisDef = {
  id: string;
  name: string;
  baseActionPoints: number;
  movement: ChassisMovement;
  gridTemplate: GridTemplate;
};

function assertNumber(name: string, v: any) {
  if (typeof v !== "number" || Number.isNaN(v)) throw new Error(`Invalid chassis: ${name}`);
}

function loadQuestoris(): ChassisDef {
  const d: any = questorisData;
  if (!d || typeof d.id !== "string") throw new Error("Invalid chassis: id");
  if (typeof d.name !== "string") throw new Error("Invalid chassis: name");
  assertNumber("baseActionPoints", d.baseActionPoints);
  if (!d.movement) throw new Error("Invalid chassis: movement");
  assertNumber("movement.advanceInches", d.movement.advanceInches);
  assertNumber("movement.chargeInches", d.movement.chargeInches);
  if (typeof d.movement.runDice !== "string") throw new Error("Invalid chassis: movement.runDice");
  if (!d.gridTemplate) throw new Error("Invalid chassis: gridTemplate");
  return {
    id: d.id,
    name: d.name,
    baseActionPoints: d.baseActionPoints,
    movement: d.movement,
    gridTemplate: d.gridTemplate,
  };
}

export const QUESTORIS_CHASSIS: ChassisDef = loadQuestoris();

export const CHASSIS_BY_ID: Record<string, ChassisDef> = {
  [QUESTORIS_CHASSIS.id]: QUESTORIS_CHASSIS,
};

export function getChassis(id: string): ChassisDef {
  return CHASSIS_BY_ID[id] ?? QUESTORIS_CHASSIS;
}
