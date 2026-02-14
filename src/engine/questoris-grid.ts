import type { GridTemplate } from "./grid";
import questorisData from "../content/chassis/questoris.json";

/**
 * Data-driven Questoris grid template.
 *
 * The actual editable source of truth is:
 *   src/content/chassis/questoris.json
 */
export const QUESTORIS_GRID_TEMPLATE: GridTemplate = (questorisData as any).gridTemplate as GridTemplate;
