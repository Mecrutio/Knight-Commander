import type { WeaponProfile } from "./core-weapons";
import type { Grid, GridCell } from "./grid";
import type { KnightState } from "./criticals-core";
import { applyDamageToCell, isKnightDestroyed } from "./damage";
import { rollD6 } from "./dice-and-aim";
import type { FacingArc, Vec2 } from "./facing-arcs";
import { incomingArc } from "./facing-arcs";

export type AttackType = "SNAP" | "STANDARD" | "AIMED";

export type DiceOverrides = Partial<{
  red: number;
  blue: number;
  ionSave: number;
  save: number;
  damageD6: number;
  damageD3: number;
}>;

type DirH = "LEFT" | "RIGHT" | "HIT";
type DirV = "UP" | "DOWN" | "HIT";

export type ScatterLog = {
  red: number;   // horizontal die (after any modifiers)
  redRaw?: number; // original horizontal die, if modified
  blue: number;  // vertical die
  horizSymbol: string; // [+] or arrows
  vertSymbol: string;  // [+] or arrows
  horizShift: number;  // squares shifted (0 if [+])
  vertShift: number;   // squares shifted (0 if [+])
};

export type IonSaveLog = {
  attempted: boolean;
  die: number;
  needed: number;
  success: boolean;
};

export type ArmourSaveLog = {
  roll: number;
  die: number;
  needed: number;
  mods: { ap: number; cover: boolean };
};

export type AttackOutcome =
  | {
      kind: "MISS";
      targetCellId: string;
      finalCellId: string | null;
      reason: string;
      incomingArc: FacingArc;
      scatter?: ScatterLog;
    }
  | {
      kind: "SAVED";
      targetCellId: string;
      finalCellId: string;
      cellId: string;
      incomingArc: FacingArc;
      savedBy: "ION" | "ARMOUR";
      ionSave?: IonSaveLog;
      armourSave?: ArmourSaveLog;
      scatter?: ScatterLog;
    }
  | {
      kind: "HIT";
      targetCellId: string;
      finalCellId: string;
      cellId: string;
      incomingArc: FacingArc;
      ionSave?: IonSaveLog;
      armourSave: ArmourSaveLog;
      damage: number;
      destroyed: boolean;
      scatter?: ScatterLog;
    };

/**
 * Shift tables (rules-as-written per your spec).
 * - Horizontal die = red
 * - Vertical die   = blue
 */
function verticalShift(attackType: AttackType, roll: number): { dir: DirV; shift: number } {
  // Rolls are 1..6
  if (attackType === "AIMED") {
    if (roll === 1) return { dir: "UP", shift: 1 };
    if (roll === 6) return { dir: "DOWN", shift: 1 };
    return { dir: "HIT", shift: 0 };
  }
  if (attackType === "STANDARD") {
    if (roll === 1) return { dir: "UP", shift: 2 };
    if (roll === 2) return { dir: "UP", shift: 1 };
    if (roll === 5) return { dir: "DOWN", shift: 1 };
    if (roll === 6) return { dir: "DOWN", shift: 2 };
    return { dir: "HIT", shift: 0 };
  }
  // SNAP
  if (roll === 1) return { dir: "UP", shift: 3 };
  if (roll === 2) return { dir: "UP", shift: 2 };
  if (roll === 3) return { dir: "UP", shift: 1 };
  if (roll === 4) return { dir: "DOWN", shift: 1 };
  if (roll === 5) return { dir: "DOWN", shift: 2 };
  return { dir: "DOWN", shift: 3 }; // 6
}

function horizontalShift(attackType: AttackType, roll: number): { dir: DirH; shift: number } {
  if (attackType === "AIMED") {
    if (roll === 1) return { dir: "LEFT", shift: 1 };
    if (roll === 6) return { dir: "RIGHT", shift: 1 };
    return { dir: "HIT", shift: 0 };
  }
  if (attackType === "STANDARD") {
    if (roll === 1) return { dir: "LEFT", shift: 2 };
    if (roll === 2) return { dir: "LEFT", shift: 1 };
    if (roll === 5) return { dir: "RIGHT", shift: 1 };
    if (roll === 6) return { dir: "RIGHT", shift: 2 };
    return { dir: "HIT", shift: 0 };
  }
  // SNAP
  if (roll === 1) return { dir: "LEFT", shift: 3 };
  if (roll === 2) return { dir: "LEFT", shift: 2 };
  if (roll === 3) return { dir: "LEFT", shift: 1 };
  if (roll === 4) return { dir: "RIGHT", shift: 1 };
  if (roll === 5) return { dir: "RIGHT", shift: 2 };
  return { dir: "RIGHT", shift: 3 }; // 6
}

function horizSymbol(dir: DirH, shift: number): string {
  if (dir === "HIT" || shift === 0) return "[+]";
  const arrows = dir === "LEFT" ? "←".repeat(shift) : "→".repeat(shift);
  return `[${arrows}]`;
}

function vertSymbol(dir: DirV, shift: number): string {
  if (dir === "HIT" || shift === 0) return "[+]";
  const arrows = dir === "UP" ? "↑".repeat(shift) : "↓".repeat(shift);
  return `[${arrows}]`;
}

export function resolveAttackMutating(args: {
  attacker: KnightState;
  defender: KnightState;
  attackerPos: Vec2;
  defenderPos: Vec2;
  defenderFacingDeg: number;
  defenderIonShieldArc?: FacingArc;
  weapon: WeaponProfile;
  attackType: AttackType;
  targetCellId: string;
  targetObscured: boolean;
  grid: Grid;
  dice?: DiceOverrides;
}): AttackOutcome {
  const {
    defender,
    weapon,
    attackType,
    targetCellId,
    targetObscured,
    attackerPos,
    defenderPos,
    defenderFacingDeg,
    defenderIonShieldArc,
  } = args;
  const dice = args.dice ?? {};

  const arc = incomingArc(defenderPos, defenderFacingDeg, attackerPos);
  const shieldArc: FacingArc = defenderIonShieldArc ?? "FRONT";

  // Targeting arc effects (as requested):
  // - Left arc:  -1 to horizontal targeting roll, +1 damage
  // - Right arc: +1 to horizontal targeting roll, +1 damage
  // - Rear arc:  +1 damage, and +1 AP step (AP -1 becomes -2; 0 becomes -1)
  const horizMod = arc === "LEFT" ? -1 : arc === "RIGHT" ? 1 : 0;
  const damageBonus = arc === "LEFT" || arc === "RIGHT" || arc === "REAR" ? 1 : 0;
  const apBonus = arc === "REAR" ? -1 : 0; // more negative AP

  const startCell = defender.grid.cells.find((c) => c.id === targetCellId);
  if (!startCell)
    return {
      kind: "MISS",
      targetCellId,
      finalCellId: null,
      reason: "Target cell not found on defender grid.",
      incomingArc: arc,
    };

  let finalCell: GridCell | null = startCell;
  let scatter: ScatterLog | undefined = undefined;

  if (weapon.scatter) {
    const redRaw = dice.red ?? rollD6();   // horizontal
    const red = Math.max(1, Math.min(6, redRaw + horizMod));
    const blue = dice.blue ?? rollD6(); // vertical

    const hs = horizontalShift(attackType, red);
    const vs = verticalShift(attackType, blue);

    scatter = {
      red,
      redRaw: red !== redRaw ? redRaw : undefined,
      blue,
      horizSymbol: horizSymbol(hs.dir, hs.shift),
      vertSymbol: vertSymbol(vs.dir, vs.shift),
      horizShift: hs.shift,
      vertShift: vs.shift,
    };

    // Apply the *combined* offset in one go.
    // Important: the Knight Commander grid is sparse; intermediate squares may be blank.
    // Only the final destination matters.
    const dx = hs.dir === "LEFT" ? -hs.shift : hs.dir === "RIGHT" ? hs.shift : 0;
    const dy = vs.dir === "UP" ? -vs.shift : vs.dir === "DOWN" ? vs.shift : 0;

    const nx = startCell.x + dx;
    const ny = startCell.y + dy;

    // Bounds check against defender grid dimensions
    if (nx < 0 || ny < 0 || nx >= defender.grid.width || ny >= defender.grid.height) {
      finalCell = null;
    } else {
      finalCell = defender.grid.cells.find((c) => c.x === nx && c.y === ny) ?? null;
    }
  }

  if (!finalCell)
    return {
      kind: "MISS",
      targetCellId,
      finalCellId: null,
      reason: "Scatter moved shot off-grid.",
      incomingArc: arc,
      scatter,
    };

  const liveCell = defender.grid.cells.find((c) => c.id === finalCell.id)!;
  if (liveCell.armorPoints <= 0)
    return {
      kind: "MISS",
      targetCellId,
      finalCellId: liveCell.id,
      reason: "Final location has no Armour Points remaining.",
      incomingArc: arc,
      scatter,
    };

  // Ion Save (4+) from Rotate Ion Shields:
  // - Only applies to the selected arc
  // - Cannot be modified by AP or cover
  // - Rolled *before* armour saves
  // NOTE: Ion Shield orientation persists until changed via ROTATE_ION_SHIELDS.
  // Ion Save always applies (for ranged attacks) when the attack hits the protected arc.
  const ionApplies = weapon.scatter && arc === shieldArc;
  let ionSave: IonSaveLog | undefined = undefined;
  if (ionApplies) {
    const ionDie = dice.ionSave ?? rollD6();
    const needed = 4;
    const success = ionDie >= needed;
    ionSave = { attempted: true, die: ionDie, needed, success };
    if (success)
      return {
        kind: "SAVED",
        targetCellId,
        finalCellId: liveCell.id,
        cellId: liveCell.id,
        incomingArc: arc,
        savedBy: "ION",
        ionSave,
        scatter,
      };
  }

  // Armour save (5+) after AP + cover (Ion Save does not affect this roll).
  const saveDie = dice.save ?? rollD6();
  const coverBonus = targetObscured ? 1 : 0;
  const effectiveAp = weapon.ap + apBonus;
  const saveRoll = saveDie + effectiveAp + coverBonus;
  const saveNeeded = 5;
  const armourSave: ArmourSaveLog = { roll: saveRoll, die: saveDie, needed: saveNeeded, mods: { ap: effectiveAp, cover: coverBonus === 1 } };

  if (saveRoll >= saveNeeded)
    return {
      kind: "SAVED",
      targetCellId,
      finalCellId: liveCell.id,
      cellId: liveCell.id,
      incomingArc: arc,
      savedBy: "ARMOUR",
      ionSave,
      armourSave,
      scatter,
    };

  let damage = 0;
  if (weapon.damage.type === "flat") {
    damage = weapon.damage.value;
  } else if (weapon.damage.dice === "D6") {
    damage = dice.damageD6 ?? rollD6();
  } else if (weapon.damage.dice === "D3") {
    if (dice.damageD3 !== undefined) damage = dice.damageD3;
    else damage = Math.ceil((dice.damageD6 ?? rollD6()) / 2);
  }

  damage = Math.max(0, damage + damageBonus);

  applyDamageToCell(defender, liveCell, damage);
  const destroyed = isKnightDestroyed(defender);
  return {
    kind: "HIT",
    targetCellId,
    finalCellId: liveCell.id,
    cellId: liveCell.id,
    incomingArc: arc,
    ionSave,
    armourSave,
    damage,
    destroyed,
    scatter,
  };
}
