import type { LocationGroup } from "./grid";
import type { Grid } from "./grid";

export type WeaponMount = "CARAPACE" | "TORSO" | "ARM_LEFT" | "ARM_RIGHT" | "OTHER";

export type MountedWeapon = {
  name: string;
  mount: WeaponMount;
  disabled: boolean;
};

export type KnightState = {
  name: string;
  grid: Grid;

  maxActionPoints: number;
  movementPenalty: number;
  canRotateIonShields: boolean;

  weapons: MountedWeapon[];
};

export function applyCoreCriticalEffect(knight: KnightState, group: LocationGroup): void {
  switch (group) {
    case 1:
      knight.weapons.filter(w => w.mount === "CARAPACE").forEach(w => (w.disabled = true));
      return;
    case 2:
      return;
    case 3:
      return; // conditional, handled by updateArmDisablesIfNeeded()
    case 4:
      knight.canRotateIonShields = false;
      return;
    case 5:
      knight.maxActionPoints = Math.min(knight.maxActionPoints, 2);
      return;
    case 6:
      knight.weapons.filter(w => w.mount === "TORSO").forEach(w => (w.disabled = true));
      return;
    case 7:
      return;
    case 8:
      knight.movementPenalty += 1;
      return;
  }
}

export function updateArmDisablesIfNeeded(knight: KnightState): void {
  const group3Cells = knight.grid.cells.filter(c => c.group === 3);

  const mid = (knight.grid.width - 1) / 2;
  const leftArm = group3Cells.filter(c => c.x < mid);
  const rightArm = group3Cells.filter(c => c.x > mid);

  const leftBothCrit = leftArm.length >= 2 && leftArm.every(c => c.criticallyDamaged);
  const rightBothCrit = rightArm.length >= 2 && rightArm.every(c => c.criticallyDamaged);

  if (leftBothCrit) knight.weapons.filter(w => w.mount === "ARM_LEFT").forEach(w => (w.disabled = true));
  if (rightBothCrit) knight.weapons.filter(w => w.mount === "ARM_RIGHT").forEach(w => (w.disabled = true));
}

export function markCellCriticallyDamaged(knight: KnightState, cellId: string): void {
  const cell = knight.grid.cells.find(c => c.id === cellId);
  if (!cell || cell.criticallyDamaged) return;
  cell.criticallyDamaged = true;
  applyCoreCriticalEffect(knight, cell.group);
  if (cell.group === 3) updateArmDisablesIfNeeded(knight);
}
