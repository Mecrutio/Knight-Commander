export function rollD6(): number {
  return Math.floor(Math.random() * 6) + 1;
}

export function rollD3(): number {
  return Math.ceil(rollD6() / 2);
}

import type { DamageProfile } from "./core-weapons";

export function rollDamage(profile: DamageProfile): number {
  if (profile.type === "flat") return profile.value;
  return profile.dice === "D3" ? rollD3() : rollD6();
}

export type AttackType = "SNAP" | "STANDARD" | "AIMED";
type Horizontal = "HIT" | "LEFT" | "RIGHT";
type Vertical = "HIT" | "UP" | "DOWN";

export const HORIZONTAL_AIM: Record<AttackType, Record<number, Horizontal>> = {
  SNAP:     { 1: "LEFT", 2: "LEFT", 3: "RIGHT", 4: "RIGHT", 5: "HIT", 6: "HIT" },
  STANDARD: { 1: "LEFT", 2: "LEFT", 3: "HIT",   4: "HIT",   5: "RIGHT", 6: "RIGHT" },
  AIMED:    { 1: "LEFT", 2: "HIT",  3: "HIT",   4: "HIT",   5: "HIT",  6: "RIGHT" },
};

export const VERTICAL_AIM: Record<number, Vertical> = {
  1: "UP",
  2: "UP",
  3: "HIT",
  4: "HIT",
  5: "DOWN",
  6: "DOWN",
};


export type DiceString = string; // e.g. "2d6", "1d6", "3d6"

export function parseDiceString(expr: string): { count: number; sides: number } | null {
  const m = /^\s*(\d+)\s*d\s*(\d+)\s*$/i.exec(expr);
  if (!m) return null;
  const count = parseInt(m[1], 10);
  const sides = parseInt(m[2], 10);
  if (!Number.isFinite(count) || !Number.isFinite(sides) || count <= 0 || sides <= 0) return null;
  return { count, sides };
}

export function rollDiceString(expr: string): { total: number; rolls: number[] } {
  const parsed = parseDiceString(expr);
  if (!parsed) throw new Error(`Unsupported dice string: ${expr}`);
  const rolls: number[] = [];
  for (let i = 0; i < parsed.count; i++) {
    if (parsed.sides === 6) rolls.push(rollD6());
    else if (parsed.sides === 3) rolls.push(rollD3());
    else rolls.push(1 + Math.floor(Math.random() * parsed.sides));
  }
  return { total: rolls.reduce((a, b) => a + b, 0), rolls };
}
