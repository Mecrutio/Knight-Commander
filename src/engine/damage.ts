import type { KnightState } from "./criticals-core";
import { markCellCriticallyDamaged } from "./criticals-core";

export function applyDamageToCell(knight: KnightState, cell: { id: string; armorPoints: number; criticallyDamaged: boolean }, damage: number): void {
  if (cell.criticallyDamaged) return;
  cell.armorPoints = Math.max(0, cell.armorPoints - damage);
  if (cell.armorPoints === 0) markCellCriticallyDamaged(knight, cell.id);
}

export function isKnightDestroyed(knight: KnightState): boolean {
  const critCount = knight.grid.cells.filter(c => c.criticallyDamaged).length;
  return critCount >= 6;
}
