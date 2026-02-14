export type CoreAction =
  | "SNAP_ATTACK"
  | "STANDARD_ATTACK"
  | "AIMED_ATTACK"
  | "ADVANCE"
  | "RUN"
  | "CHARGE"
  | "ROTATE_ION_SHIELDS";

export const CORE_ACTION_COST: Record<CoreAction, number> = {
  SNAP_ATTACK: 1,
  STANDARD_ATTACK: 2,
  AIMED_ATTACK: 3,
  ADVANCE: 1,
  RUN: 1,
  CHARGE: 2,
  ROTATE_ION_SHIELDS: 1,
};

/**
 * Initiative step order (Option B: preserve action-chain where running may occur after shooting).
 *
 * Required order for the map environment (ranges update after each step):
 * 1. Snap Shots
 * 2. Advances
 * 3. Rotate Ion Shields
 * 4. Standard attack
 * 5. Run
 * 6. Aimed attack
 * 7. Charge
 */
export const CORE_ACTION_ORDER: CoreAction[] = [
  "SNAP_ATTACK",
  "ADVANCE",
  "ROTATE_ION_SHIELDS",
  "STANDARD_ATTACK",
  "RUN",
  "AIMED_ATTACK",
  "CHARGE",
];

export type Plan = { actions: CoreAction[] };
export type PlannedTurn = { P1: Plan; P2: Plan };

export type ValidationIssue = { severity: "error" | "warning"; message: string };
export type KnightPlanContext = { maxActionPoints: number; canRotateIonShields: boolean };

export function validatePlan(plan: Plan, knight: KnightPlanContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const seen = new Set<CoreAction>();
  for (const a of plan.actions) {
    if (seen.has(a)) issues.push({ severity: "error", message: `Duplicate action chosen: ${a}` });
    seen.add(a);
  }

  const totalAP = plan.actions.reduce((sum, a) => sum + CORE_ACTION_COST[a], 0);
  if (totalAP > knight.maxActionPoints) {
    issues.push({ severity: "error", message: `Planned AP (${totalAP}) exceeds max (${knight.maxActionPoints}).` });
  }

  if (plan.actions.includes("ROTATE_ION_SHIELDS") && !knight.canRotateIonShields) {
    issues.push({ severity: "error", message: `Cannot choose Rotate Ion Shields: tilting shield is damaged.` });
  }

  return issues;
}
