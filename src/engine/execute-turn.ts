import type { Grid } from "./grid";
import type { KnightState } from "./criticals-core";
import type { WeaponProfile } from "./core-weapons";
import { CORE_WEAPONS, resolveWeaponProfileForEquippedName, weaponHasAbility } from "./core-weapons";
import type { PlannedTurn, CoreAction } from "./core-actions";
import { CORE_ACTION_ORDER } from "./core-actions";
import { resolveAttackMutating, DiceOverrides, AttackOutcome } from "./resolve-attack";
import { isKnightDestroyed } from "./damage";
import type { TerrainPiece } from "./terrain";
import { computeLosEffects, earliestObstacleEnterT } from "./terrain";
import { getChassis } from "./chassis";
import { rollDiceString } from "./dice-and-aim";
import type { FacingArc } from "./facing-arcs";
import { arcShortLabel, bearingDeg, canFireAtTarget, mountFiringArcLabel, normDeg, relativeArc } from "./facing-arcs";
import type { WeaponMount } from "./criticals-core";

type PlayerId = "P1" | "P2";

export type AttackChoice = {
  targetCellId: string;
  targetObscured: boolean;
  dice?: DiceOverrides;
};

export type MoveChoice = { distanceInches: number };

export type Vec2 = { x: number; y: number };

// Movement in the map environment can be specified as a destination point.
// The engine will move the unit *towards* the destination by the allowed distance for the step.
export type MoveChoice2D = {
  // Optional explicit destination in inches (game space). If omitted, the move is treated as "in place".
  dest?: Vec2;
  // Optional precomputed intended distance (UI may still use this).
  distanceInches?: number;
  // Optional facing after completing this move (0°=east, 90°=south). If omitted, engine auto-faces along movement.
  endFacingDeg?: number;
};

export type TurnInputs = {
  P1: Partial<{
    SNAP_ATTACK: AttackChoice;
    STANDARD_ATTACK: AttackChoice;
    AIMED_ATTACK: AttackChoice;
    ADVANCE: MoveChoice2D;
    RUN: MoveChoice2D;
    CHARGE: {
      move: MoveChoice2D;
      meleeAttack: { weapon: WeaponProfile; targetCellId: string; dice?: DiceOverrides };
    };
    ROTATE_ION_SHIELDS: {};
  }>;
  P2: Partial<{
    SNAP_ATTACK: AttackChoice;
    STANDARD_ATTACK: AttackChoice;
    AIMED_ATTACK: AttackChoice;
    ADVANCE: MoveChoice2D;
    RUN: MoveChoice2D;
    CHARGE: {
      move: MoveChoice2D;
      meleeAttack: { weapon: WeaponProfile; targetCellId: string; dice?: DiceOverrides };
    };
    ROTATE_ION_SHIELDS: {};
  }>;
};

export type GameState = {
  grid: Grid;
  knights: Record<PlayerId, KnightState>;
  turnNumber: number;
  // Map positions in inches (game space). Used to compute range step-by-step.
  positions: Record<PlayerId, Vec2>;
  // Facing angles in degrees (0°=east, 90°=south). Used for arcs.
  facings: Record<PlayerId, number>;
  // Terrain pieces on the map.
  terrain: TerrainPiece[];
  // Selected chassis for each player.
  chassisId: Record<PlayerId, string>;
};

export type TurnEvent =
  | { kind: "STEP"; stepNumber: number; action: CoreAction; order: PlayerId[]; rangeInches: number } // order empty => N/A
  | { kind: "ROTATE"; players: PlayerId[] }
  | { kind: "MOVE"; player: PlayerId; action: "ADVANCE" | "RUN" | "CHARGE"; distanceAfterPenalty: number; distanceRolled?: number; dice?: [number, number]; from: Vec2; to: Vec2; rangeAfter: number }
  | { kind: "ATTACK"; player: PlayerId; action: "SNAP_ATTACK" | "STANDARD_ATTACK" | "AIMED_ATTACK" | "CHARGE_MELEE"; weapon: string; outcome: AttackOutcome }
  | { kind: "SKIP"; player: PlayerId; action: "SNAP_ATTACK" | "STANDARD_ATTACK" | "AIMED_ATTACK" | "CHARGE_MELEE"; weapon: string; reason: string }
  | { kind: "DESTROYED"; player: PlayerId };

function enemyOf(p: PlayerId): PlayerId {
  return p === "P1" ? "P2" : "P1";
}

function randomOrderBoth(): PlayerId[] {
  return Math.random() < 0.5 ? ["P1", "P2"] : ["P2", "P1"];
}

function d6(): number {
  return Math.floor(Math.random() * 6) + 1;
}

function dist(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function snapToWholeInches(p: Vec2): Vec2 {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

function moveTowards(from: Vec2, to: Vec2, maxDist: number): Vec2 {
  const d = dist(from, to);
  if (d <= 1e-6) return { ...from };
  if (maxDist >= d) return { ...to };
  const t = maxDist / d;
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}

function clampMoveByTerrain(from: Vec2, to: Vec2, terrain: TerrainPiece[]): Vec2 {
  // If the segment crosses an impassable terrain area, stop just before entering.
  const te = earliestObstacleEnterT(from, to, terrain);
  if (te === null) return to;
  // back off slightly so we don't end up inside due to floating error
  const t = Math.max(0, Math.min(1, te - 1e-3));
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
  };
}

// Grid-based pathfinding to allow automatic movement around impassable terrain.
// - Operates on 1" grid nodes (whole inches)
// - Uses 4-direction movement (N/E/S/W) costing 1" per step
// - Returns a list of nodes from start to goal inclusive, or null if no path.
function findPathManhattan(start: Vec2, goal: Vec2, terrain: TerrainPiece[], boardSize: number = 48): Vec2[] | null {
  const sx = Math.round(start.x);
  const sy = Math.round(start.y);
  const gx = Math.round(goal.x);
  const gy = Math.round(goal.y);

  const key = (x: number, y: number) => `${x},${y}`;

  const isBlocked = (x: number, y: number) => {
    // outside board bounds is blocked
    if (x < 0 || y < 0 || x > boardSize || y > boardSize) return true;
    // block if the point lies within any terrain rectangle
    for (const t of terrain) {
      for (const r of t.rects) {
        if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return true;
      }
    }
    return false;
  };

  if (isBlocked(sx, sy)) return null;
  if (isBlocked(gx, gy)) return null;
  if (sx === gx && sy === gy) return [{ x: sx, y: sy }];

  const q: Array<{ x: number; y: number }> = [{ x: sx, y: sy }];
  const prev = new Map<string, string>();
  const seen = new Set<string>([key(sx, sy)]);

  const dirs = [
    { dx: 1, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 0, dy: -1 },
  ];

  while (q.length) {
    const cur = q.shift()!;
    for (const d of dirs) {
      const nx = cur.x + d.dx;
      const ny = cur.y + d.dy;
      const k = key(nx, ny);
      if (seen.has(k)) continue;
      if (isBlocked(nx, ny)) continue;
      prev.set(k, key(cur.x, cur.y));
      if (nx === gx && ny === gy) {
        // reconstruct
        const out: Vec2[] = [{ x: gx, y: gy }];
        let back = key(gx, gy);
        while (prev.has(back)) {
          const p = prev.get(back)!;
          const [px, py] = p.split(",").map(Number);
          out.push({ x: px, y: py });
          back = p;
          if (px === sx && py === sy) break;
        }
        out.reverse();
        return out;
      }
      seen.add(k);
      q.push({ x: nx, y: ny });
    }
  }
  return null;
}

// Move along a sequence of waypoints, consuming distance in order.
// This supports waypoint plotting: later movement steps can continue toward
// earlier plotted destinations until those are reached.
function moveAlongWaypoints(from: Vec2, waypoints: (Vec2 | undefined)[], maxDist: number, terrain?: TerrainPiece[]): Vec2 {
  let remaining = Math.max(0, maxDist);
  let cur: Vec2 = { ...from };

  for (const wp of waypoints) {
    if (!wp) continue;
    // If terrain is present, route around impassable cover using a 1" grid path.
    if (terrain) {
      const start = snapToWholeInches(cur);
      const goal = snapToWholeInches(wp);
      const path = findPathManhattan(start, goal, terrain);
      if (path && path.length >= 2) {
        const stepsToGoal = path.length - 1;
        if (remaining >= stepsToGoal) {
          cur = { ...goal };
          remaining -= stepsToGoal;
        } else {
          // Move as far as possible along the path.
          const idx = Math.max(0, Math.min(stepsToGoal, Math.floor(remaining)));
          cur = { ...path[idx] };
          remaining = 0;
        }
      } else {
        // Fallback to straight-line clamp if no path exists.
        const before = { ...cur };
        const d = dist(cur, wp);
        const desired = remaining >= d ? { ...wp } : moveTowards(cur, wp, remaining);
        const clamped = clampMoveByTerrain(cur, desired, terrain);
        const spent = dist(before, clamped);
        cur = clamped;
        remaining = Math.max(0, remaining - spent);
        // If clamped early, stop.
        if (spent + 1e-6 < dist(before, desired)) {
          remaining = 0;
          break;
        }
      }
    } else {
      // No terrain: simple straight-line move.
      const d = dist(cur, wp);
      const desired = remaining >= d ? { ...wp } : moveTowards(cur, wp, remaining);
      const spent = dist(cur, desired);
      cur = desired;
      remaining = Math.max(0, remaining - spent);
    }

    if (remaining <= 1e-6) break;
  }

  return cur;
}

function isRangedWeapon(profile: WeaponProfile): boolean {
  // In Core, melee weapons are modeled as scatter=false. For ranged attack actions, skip those.
  return profile.scatter === true;
}

function weaponMount(attacker: KnightState, weaponName: string): WeaponMount {
  return (attacker.weapons.find((w) => w.name === weaponName)?.mount ?? "OTHER") as WeaponMount;
}


export function executeTurnMutating(
  game: GameState,
  plans: PlannedTurn,
  inputs: TurnInputs,
  manualRangeInches: number,
  weaponTargets: Record<PlayerId, Record<string, string>>
): TurnEvent[] {
  const events: TurnEvent[] = [];

  // Rotate Ion Shields now grants a temporary +1 to Armour Saves (all directions) for the rest of the turn.
  // Track it per player for the duration of this executeTurn call.
  const rotateArmourBonus: Record<PlayerId, number> = { P1: 0, P2: 0 };

  const getRangeInches = () => {
    const p1 = game.positions?.P1;
    const p2 = game.positions?.P2;
    // Map play uses whole-inch grid positions. Keep range in whole inches so
    // weapon gating / logs stay consistent with the 1"-tile UI.
    return p1 && p2 ? Math.round(dist(p1, p2)) : manualRangeInches;
  };

  for (let i = 0; i < CORE_ACTION_ORDER.length; i++) {
    const action = CORE_ACTION_ORDER[i];
    const stepNumber = i + 1;

    const rangeInches = getRangeInches();

    const p1 = plans.P1.actions.includes(action);
    const p2 = plans.P2.actions.includes(action);

    let order: PlayerId[] = [];
    if (p1 && p2) order = randomOrderBoth();
    else if (p1) order = ["P1"];
    else if (p2) order = ["P2"];
    else order = [];

    events.push({ kind: "STEP", stepNumber, action, order, rangeInches });

    if (order.length === 0) continue;

    const snapshotKnights: Record<PlayerId, KnightState> = {
      P1: game.knights.P1,
      P2: game.knights.P2,
    };

    const activePlayers = order.filter((p) => !isKnightDestroyed(snapshotKnights[p]));

    if (action === "ROTATE_ION_SHIELDS") {
      const rotated: PlayerId[] = [];
      for (const p of activePlayers) {
        if (!snapshotKnights[p].canRotateIonShields) continue;
        rotated.push(p);
        rotateArmourBonus[p] = 1;
      }
      if (rotated.length) events.push({ kind: "ROTATE", players: rotated });
      continue;
    }

    
if (action === "ADVANCE") {
  for (const p of activePlayers) {
    const move = inputs[p][action];
    if (!move) continue;
    const from = { ...game.positions[p] };
    const dest = move.dest ?? from;
    const intended = move.distanceInches ?? dist(from, dest);
    const afterPenalty = Math.max(0, intended - (snapshotKnights[p].movementPenalty ?? 0));
    const rawTo = moveAlongWaypoints(from, [dest], afterPenalty, game.terrain);
    const to = snapToWholeInches(rawTo);
    game.positions[p] = to;
    // Facing after movement: use explicit endFacing if provided, otherwise auto-face along the actual move.
    if (typeof move.endFacingDeg === "number" && Number.isFinite(move.endFacingDeg)) {
      game.facings[p] = normDeg(move.endFacingDeg);
    } else if (from.x !== to.x || from.y !== to.y) {
      game.facings[p] = bearingDeg(from, to);
    }
    events.push({ kind: "MOVE", player: p, action, distanceAfterPenalty: afterPenalty, from, to, rangeAfter: getRangeInches() });
  }
  continue;
}

if (action === "RUN") {
  for (const p of activePlayers) {
    const move = inputs[p][action];
    if (!move) continue;
    const chassis = getChassis(game.chassisId[p]);
    const runExpr = chassis.movement.runDice;
    const r = rollDiceString(runExpr);
    const rolled = r.total;
    const dice = r.rolls as number[];
    const afterPenalty = Math.max(0, rolled - (snapshotKnights[p].movementPenalty ?? 0));
    const from = { ...game.positions[p] };
    // Waypoint behavior:
    // If the player plotted an Advance destination that wasn't fully reached during ADVANCE,
    // RUN continues toward that Advance waypoint first, then toward the RUN waypoint.
    const advWp = inputs[p].ADVANCE?.dest;
    const runWp = move.dest;
    const fallback = from;
    const rawTo = moveAlongWaypoints(from, [advWp, runWp ?? fallback], afterPenalty, game.terrain);
    const to = snapToWholeInches(rawTo);
    game.positions[p] = to;
    if (typeof move.endFacingDeg === "number" && Number.isFinite(move.endFacingDeg)) {
      game.facings[p] = normDeg(move.endFacingDeg);
    } else if (from.x !== to.x || from.y !== to.y) {
      game.facings[p] = bearingDeg(from, to);
    }
    events.push({ kind: "MOVE", player: p, action, distanceAfterPenalty: afterPenalty, distanceRolled: rolled, dice: [dice[0] ?? 0, dice[1] ?? 0], from, to, rangeAfter: getRangeInches() });
  }
  continue;
}

    if (action === "SNAP_ATTACK" || action === "STANDARD_ATTACK" || action === "AIMED_ATTACK") {
      const attackType =
        action === "SNAP_ATTACK" ? "SNAP" : action === "STANDARD_ATTACK" ? "STANDARD" : "AIMED";

      // Clone for compute phase (same-step snapshot)
      const computeKnights: Record<PlayerId, KnightState> = {
        P1: { ...snapshotKnights.P1, grid: { ...snapshotKnights.P1.grid, cells: snapshotKnights.P1.grid.cells.map((c) => ({ ...c })) } },
        P2: { ...snapshotKnights.P2, grid: { ...snapshotKnights.P2.grid, cells: snapshotKnights.P2.grid.cells.map((c) => ({ ...c })) } },
      };

      // Determine attackers in this step (must have inputs)
      const attackers: PlayerId[] = [];
      for (const p of activePlayers) {
        const atk = inputs[p][action];
        if (!atk) continue;
        const enemy = enemyOf(p);
        if (isKnightDestroyed(computeKnights[enemy])) continue;
        attackers.push(p);
      }

      // Compute phase (discard outcomes) to preserve step-start context
      for (const p of attackers) {
        const enemy = enemyOf(p);
        const atk = inputs[p][action]!;
        const los = computeLosEffects(game.positions[p], game.positions[enemy], game.terrain);

        // fire ALL eligible ranged weapons once
        const mountedWeapons = computeKnights[p].weapons.filter((w) => !w.disabled);
        for (const mw of mountedWeapons) {
          const wn = mw.name;
          const profile = resolveWeaponProfileForEquippedName(wn, rangeInches);
          if (!profile) continue;
          if (!isRangedWeapon(profile)) continue;
          if (rangeInches > profile.rangeInches) continue;

          const indirect = weaponHasAbility(profile, "INDIRECT");
          if (los.blocked && !indirect) {
            // No LOS: direct-fire weapons cannot resolve at all.
            continue;
          }
          const effectiveAttackType = los.blocked && indirect ? "SNAP" : attackType;

          // Weapon firing arcs (as requested).
          const mount = mw.mount;
          if (!canFireAtTarget({ attackerPos: game.positions[p], attackerFacingDeg: game.facings[p], targetPos: game.positions[enemy], mount })) {
            continue;
          }

          resolveAttackMutating({
            attacker: computeKnights[p],
            defender: computeKnights[enemy],
            attackerPos: game.positions[p],
            defenderPos: game.positions[enemy],
            defenderFacingDeg: game.facings[enemy],
            defenderArmourSaveBonus: rotateArmourBonus[enemy] || 0,
            weapon: profile,
            attackType: effectiveAttackType,
            targetCellId: weaponTargets[p]?.[weaponTargetKeyForMount(mount)] ?? atk.targetCellId,
            targetObscured: los.obscured,
            grid: game.grid,
            dice: atk.dice,
          });
        }
      }

      // Apply phase: execute in the randomized order, each equipped ranged weapon once
      for (const p of attackers) {
        const enemy = enemyOf(p);
        const atk = inputs[p][action]!;
        const los = computeLosEffects(game.positions[p], game.positions[enemy], game.terrain);
        const mountedWeapons = game.knights[p].weapons.filter((w) => !w.disabled);

        for (const mw of mountedWeapons) {
          const wn = mw.name;

          const profile = resolveWeaponProfileForEquippedName(wn, rangeInches);
          if (!profile) {
            events.push({ kind: "SKIP", player: p, action, weapon: wn, reason: "Out of range (Thermal cannon) or unknown weapon profile" });
            continue;
          }

          const indirect = weaponHasAbility(profile, "INDIRECT");
          if (los.blocked && !indirect) {
            events.push({ kind: "SKIP", player: p, action, weapon: wn, reason: "No LOS (Hard cover blocks line of sight)" });
            continue;
          }

          if (!isRangedWeapon(profile)) {
            events.push({ kind: "SKIP", player: p, action, weapon: wn, reason: "Melee weapon (not used in ranged attack actions)" });
            continue;
          }
          if (rangeInches > profile.rangeInches) {
            events.push({ kind: "SKIP", player: p, action, weapon: wn, reason: `Out of range (range ${profile.rangeInches}\" < ${rangeInches}\")` });
            continue;
          }

          // Weapon firing arcs (as requested).
          const mount = mw.mount;
          if (!canFireAtTarget({ attackerPos: game.positions[p], attackerFacingDeg: game.facings[p], targetPos: game.positions[enemy], mount })) {
            const tgtArc = relativeArc(game.positions[p], game.facings[p], game.positions[enemy]);
            events.push({
              kind: "SKIP",
              player: p,
              action,
              weapon: wn,
              reason: `Target in ${arcShortLabel(tgtArc)} arc; ${mount} fires ${mountFiringArcLabel(mount)}`,
            });
            continue;
          }

          const forcedSnap = los.blocked && indirect;
          const effectiveAttackType = forcedSnap ? "SNAP" : attackType;
          const weaponLabel = forcedSnap ? `${wn} (Indirect → Snap)` : indirect ? `${wn} (Indirect)` : wn;

          const outcome = resolveAttackMutating({
            attacker: game.knights[p],
            defender: game.knights[enemy],
            attackerPos: game.positions[p],
            defenderPos: game.positions[enemy],
            defenderFacingDeg: game.facings[enemy],
            defenderArmourSaveBonus: rotateArmourBonus[enemy] || 0,
            weapon: profile,
            attackType: effectiveAttackType,
            targetCellId: weaponTargets[p]?.[weaponTargetKeyForMount(mount)] ?? atk.targetCellId,
            targetObscured: los.obscured,
            grid: game.grid,
            dice: atk.dice,
          });

          events.push({ kind: "ATTACK", player: p, action, weapon: weaponLabel, outcome });
        }
      }

      for (const p of ["P1", "P2"] as PlayerId[]) {
        if (isKnightDestroyed(game.knights[p])) events.push({ kind: "DESTROYED", player: p });
      }
      continue;
    }

    if (action === "CHARGE") {
      const chargers: PlayerId[] = [];
      for (const p of activePlayers) {
        // Charge moves up to 6" (core), then attacks with equipped melee weapons.
        chargers.push(p);

        const afterPenalty = Math.max(0, 6 - (snapshotKnights[p].movementPenalty ?? 0));
        const from = { ...game.positions[p] };
        const enemy = enemyOf(p);
        const choice = inputs[p].CHARGE?.move;
        // Waypoint behavior for CHARGE:
        // If earlier plotted ADVANCE/RUN waypoints were not reached, CHARGE continues toward them
        // before heading toward the CHARGE waypoint (or the enemy if none).
        const advWp = inputs[p].ADVANCE?.dest;
        const runWp = inputs[p].RUN?.dest;
        const chargeWp = choice?.dest ?? game.positions[enemy];
        const rawTo = moveAlongWaypoints(from, [advWp, runWp, chargeWp], afterPenalty, game.terrain);
        const to = snapToWholeInches(rawTo);
        game.positions[p] = to;
        if (typeof choice?.endFacingDeg === "number" && Number.isFinite(choice.endFacingDeg)) {
          game.facings[p] = normDeg(choice.endFacingDeg);
        } else if (from.x !== to.x || from.y !== to.y) {
          game.facings[p] = bearingDeg(from, to);
        }
        events.push({ kind: "MOVE", player: p, action: "CHARGE", distanceAfterPenalty: afterPenalty, from, to, rangeAfter: getRangeInches() });
      }

      if (chargers.length === 0) continue;

      // IMPORTANT: Charge includes a move followed immediately by melee attacks.
      // We must measure range *after* all charge moves complete, so melee range checks
      // (and any downstream logs) reflect the correct end-of-charge positions.
      const rangeAfterCharge = getRangeInches();

      // Compute phase (snapshot) — do not mutate real state
      const computeKnights: Record<PlayerId, KnightState> = {
        P1: { ...snapshotKnights.P1, grid: { ...snapshotKnights.P1.grid, cells: snapshotKnights.P1.grid.cells.map((c) => ({ ...c })) } },
        P2: { ...snapshotKnights.P2, grid: { ...snapshotKnights.P2.grid, cells: snapshotKnights.P2.grid.cells.map((c) => ({ ...c })) } },
      };

      // Use the currently selected target cell from the per-action inputs if present; otherwise default to C4.
      // (Melee has no scatter; we still need a location to strike.)
      const defaultTargetCellId = "C4";

      for (const p of chargers) {
        const enemy = enemyOf(p);
        if (isKnightDestroyed(computeKnights[p])) continue;
        if (isKnightDestroyed(computeKnights[enemy])) continue;

        // Cover blocks melee attacks (both hard and soft), so skip compute if LOS crosses any cover.
        const losMelee = computeLosEffects(game.positions[p], game.positions[enemy], game.terrain);
        if (losMelee.crossesAnyCover) continue;

        const targetCellId =
          inputs[p].STANDARD_ATTACK?.targetCellId ??
          inputs[p].SNAP_ATTACK?.targetCellId ??
          inputs[p].AIMED_ATTACK?.targetCellId ??
          defaultTargetCellId;

        const mountedMelee = computeKnights[p].weapons.filter((w) => !w.disabled);

        for (const mw of mountedMelee) {
          const wn = mw.name;
          const profile = resolveWeaponProfileForEquippedName(wn, rangeAfterCharge);
          if (!profile) continue;
          if (isRangedWeapon(profile)) continue; // only melee weapons for charge
          // Melee range check: skip if the target is outside the weapon's melee reach.
          if (rangeAfterCharge > profile.rangeInches) continue;

          // Weapon arcs apply to melee as well (arm/torso constraints).
          const mount = mw.mount;
          if (!canFireAtTarget({ attackerPos: game.positions[p], attackerFacingDeg: game.facings[p], targetPos: game.positions[enemy], mount })) {
            continue;
          }
          resolveAttackMutating({
            attacker: computeKnights[p],
            defender: computeKnights[enemy],
            attackerPos: game.positions[p],
            defenderPos: game.positions[enemy],
            defenderFacingDeg: game.facings[enemy],
            defenderArmourSaveBonus: rotateArmourBonus[enemy] || 0,
            weapon: profile,
            attackType: "STANDARD",
            targetCellId: (weaponTargets[p]?.[weaponTargetKeyForMount(mount)] ?? targetCellId),
            targetObscured: false,
            grid: game.grid,
            dice: undefined,
          });
        }
      }

      // Apply phase — execute in the randomized order from this step
      for (const p of chargers) {
        const enemy = enemyOf(p);
        if (isKnightDestroyed(game.knights[p])) continue;
        if (isKnightDestroyed(game.knights[enemy])) continue;

        // Cover blocks melee attacks (both hard and soft).
        const losMelee = computeLosEffects(game.positions[p], game.positions[enemy], game.terrain);

        const targetCellId =
          inputs[p].STANDARD_ATTACK?.targetCellId ??
          inputs[p].SNAP_ATTACK?.targetCellId ??
          inputs[p].AIMED_ATTACK?.targetCellId ??
          defaultTargetCellId;

        const mountedMelee = game.knights[p].weapons.filter((w) => !w.disabled);

        for (const mw of mountedMelee) {
          const wn = mw.name;
          if (losMelee.crossesAnyCover) {
            events.push({ kind: "SKIP", player: p, action: "CHARGE_MELEE", weapon: wn, reason: "No LOS (Cover blocks melee attacks)" });
            continue;
          }
          const profile = resolveWeaponProfileForEquippedName(wn, rangeAfterCharge);
          if (!profile) continue;
          if (isRangedWeapon(profile)) continue;

          // Melee range check (requested): if outside reach after charge move, skip like ranged.
          if (rangeAfterCharge > profile.rangeInches) {
            events.push({
              kind: "SKIP",
              player: p,
              action: "CHARGE_MELEE",
              weapon: wn,
              reason: `Out of range (range ${profile.rangeInches}" < ${rangeAfterCharge}")`,
            });
            continue;
          }

          // Weapon arcs apply to melee as well (arm/torso constraints).
          const mount = mw.mount;
          if (!canFireAtTarget({ attackerPos: game.positions[p], attackerFacingDeg: game.facings[p], targetPos: game.positions[enemy], mount })) {
            const tgtArc = relativeArc(game.positions[p], game.facings[p], game.positions[enemy]);
            events.push({
              kind: "SKIP",
              player: p,
              action: "CHARGE_MELEE",
              weapon: wn,
              reason: `Target in ${arcShortLabel(tgtArc)} arc; ${mount} attacks ${mountFiringArcLabel(mount)}`,
            });
            continue;
          }

          const outcome = resolveAttackMutating({
            attacker: game.knights[p],
            defender: game.knights[enemy],
            attackerPos: game.positions[p],
            defenderPos: game.positions[enemy],
            defenderFacingDeg: game.facings[enemy],
            defenderArmourSaveBonus: rotateArmourBonus[enemy] || 0,
            weapon: profile,
            attackType: "STANDARD",
            targetCellId: (weaponTargets[p]?.[weaponTargetKeyForMount(mount)] ?? targetCellId),
            targetObscured: false,
            grid: game.grid,
            dice: undefined,
          });

          events.push({ kind: "ATTACK", player: p, action: "CHARGE_MELEE", weapon: wn, outcome });
        }
      }

      for (const p of ["P1", "P2"] as PlayerId[]) {
        if (isKnightDestroyed(game.knights[p])) events.push({ kind: "DESTROYED", player: p });
      }
      continue;
    }

  }

  return events;
}
function weaponTargetKeyForMount(mount: WeaponMount): string {
  if (mount === "CARAPACE") return "CARAPACE";
  if (mount === "TORSO") return "TORSO";
  if (mount === "ARM_LEFT") {
    // Secondary arm weapons (e.g., Heavy Stubber / Heavy Flamer) are slaved to the arm's primary target.
    return "ARM_LEFT_PRIMARY";
  }
  if (mount === "ARM_RIGHT") {
    // Secondary arm weapons (e.g., Heavy Stubber / Heavy Flamer) are slaved to the arm's primary target.
    return "ARM_RIGHT_PRIMARY";
  }
  return "DEFAULT";
}


