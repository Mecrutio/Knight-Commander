export type LocationGroup = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export type GridCell = {
  id: string;
  x: number;
  y: number;
  group: LocationGroup;
  armorPoints: number;
  maxArmorPoints: number;
  criticallyDamaged: boolean;
};

export type Grid = {
  width: number;
  height: number;
  cells: GridCell[];
};

export type GridTemplateCell = {
  x: number;
  y: number;
  group: LocationGroup;
  maxArmorPoints: number;
};

export type GridTemplate = {
  width: number;
  height: number;
  cells: GridTemplateCell[];
};

function cellId(x: number, y: number): string {
  // IDs follow the Knight Commander targeting grid convention:
  // - Letter = row (y), top to bottom: A, B, C...
  // - Number = column (x+1), left to right: 1, 2, 3...
  // Example: C4 means row C (y=2), column 4 (x=3).
  return `${String.fromCharCode(65 + y)}${x + 1}`;
}

export function instantiateGrid(template: GridTemplate): Grid {
  const cells: GridCell[] = template.cells.map(c => ({
    id: cellId(c.x, c.y),
    x: c.x,
    y: c.y,
    group: c.group,
    armorPoints: c.maxArmorPoints,
    maxArmorPoints: c.maxArmorPoints,
    criticallyDamaged: false,
  }));
  return { width: template.width, height: template.height, cells };
}

export function getCell(grid: Grid, x: number, y: number): GridCell | null {
  return grid.cells.find(c => c.x === x && c.y === y) ?? null;
}

export function shiftCell(grid: Grid, from: GridCell, direction: "UP" | "DOWN" | "LEFT" | "RIGHT", steps: number): GridCell | null {
  // Apply the full shift in one go.
  // Important: the Knight Commander targeting grid is sparse; shifting does NOT require that intermediate squares exist.
  // Only the final destination matters (if it is outside the grid bounds OR lands on a blank square, the shot misses/off-grid).
  let nx = from.x;
  let ny = from.y;

  switch (direction) {
    case "UP":
      ny -= steps;
      break;
    case "DOWN":
      ny += steps;
      break;
    case "LEFT":
      nx -= steps;
      break;
    case "RIGHT":
      nx += steps;
      break;
  }

  if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) return null;

  const dest = grid.cells.find((c) => c.x === nx && c.y === ny) ?? null;
  return dest;
}

