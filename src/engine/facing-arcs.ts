import type { WeaponMount } from "./criticals-core";

export type Vec2 = { x: number; y: number };

// Clockwise in screen/world space:
// 0° = +X (east), 90° = +Y (south)
export type FacingArc = "FRONT" | "RIGHT" | "REAR" | "LEFT";

export function normDeg(d: number): number {
  return ((d % 360) + 360) % 360;
}

export function bearingDeg(from: Vec2, to: Vec2): number {
  return normDeg((Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI);
}

export function normalizeDeltaDeg(delta: number): number {
  // Normalize to (-180, 180]
  const d = ((delta + 180) % 360 + 360) % 360 - 180;
  return d === -180 ? 180 : d;
}

/**
 * Determine which *defender* arc the attacker is in, based on the defender's facing.
 *
 * Boundaries are inclusive on the "front" seam:
 * - FRONT: |delta| <= 45
 * - RIGHT:  45 < delta < 135
 * - REAR:  |delta| >= 135
 * - LEFT:  -135 < delta < -45
 */
export function incomingArc(defenderPos: Vec2, defenderFacingDeg: number, attackerPos: Vec2): FacingArc {
  const b = bearingDeg(defenderPos, attackerPos);
  const delta = normalizeDeltaDeg(b - normDeg(defenderFacingDeg));

  if (Math.abs(delta) <= 45) return "FRONT";
  if (Math.abs(delta) >= 135) return "REAR";
  return delta > 0 ? "RIGHT" : "LEFT";
}

/** Which arc a point lies in, relative to an origin's facing. */
export function relativeArc(originPos: Vec2, originFacingDeg: number, pointPos: Vec2): FacingArc {
  return incomingArc(originPos, originFacingDeg, pointPos);
}

export function mountFiringArcLabel(mount: WeaponMount): string {
  switch (mount) {
    case "CARAPACE":
      return "360°";
    case "TORSO":
      return "Front";
    case "ARM_LEFT":
      return "Front+Left";
    case "ARM_RIGHT":
      return "Front+Right";
    default:
      return "360°";
  }
}

export function canFireFromMountIntoArc(mount: WeaponMount, arc: FacingArc): boolean {
  switch (mount) {
    case "CARAPACE":
      return true;
    case "TORSO":
      return arc === "FRONT";
    case "ARM_LEFT":
      return arc === "FRONT" || arc === "LEFT";
    case "ARM_RIGHT":
      return arc === "FRONT" || arc === "RIGHT";
    default:
      return true;
  }
}

export function canFireAtTarget(args: { attackerPos: Vec2; attackerFacingDeg: number; targetPos: Vec2; mount: WeaponMount }): boolean {
  const a = relativeArc(args.attackerPos, args.attackerFacingDeg, args.targetPos);
  return canFireFromMountIntoArc(args.mount, a);
}

export function arcShortLabel(a: FacingArc): string {
  switch (a) {
    case "FRONT":
      return "Front";
    case "RIGHT":
      return "Right";
    case "REAR":
      return "Rear";
    case "LEFT":
      return "Left";
  }
}
