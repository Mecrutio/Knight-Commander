export type DiceExpr = "D3" | "D6";

export type DamageProfile =
  | { type: "flat"; value: number }
  | { type: "dice"; dice: DiceExpr };

export type WeaponAbility = "INDIRECT";

export type WeaponProfile = {
  name: string;
  rangeInches: number;
  ap: number;
  damage: DamageProfile;
  scatter: boolean; // false only when table explicitly says "(no scatter)"
  abilities?: WeaponAbility[];
};

export function weaponHasAbility(profile: WeaponProfile | null | undefined, ability: WeaponAbility): boolean {
  if (!profile?.abilities?.length) return false;
  return profile.abilities.includes(ability);
}

export function weaponAbilityDisplayName(ability: WeaponAbility): string {
  switch (ability) {
    case "INDIRECT":
      return "Indirect";
  }
}

export function weaponAbilitiesShortLabel(profile: WeaponProfile | null | undefined): string {
  if (!profile?.abilities?.length) return "";
  return profile.abilities.map(weaponAbilityDisplayName).join(", ");
}

// Data-driven weapons for easy editing / future chassis expansions.
import weaponsData from "../content/weapons.json";

function normalizeAbilities(v: any): WeaponAbility[] | undefined {
  if (v == null) return undefined;
  if (!Array.isArray(v)) throw new Error("Invalid weapon abilities: expected an array");

  const map: Record<string, WeaponAbility> = {
    INDIRECT: "INDIRECT",
    Indirect: "INDIRECT",
    indirect: "INDIRECT",
  };

  const out: WeaponAbility[] = [];
  for (const a of v) {
    if (typeof a !== "string") throw new Error("Invalid weapon abilities: non-string entry");
    const norm = map[a];
    if (!norm) throw new Error(`Invalid weapon ability: ${a}`);
    if (!out.includes(norm)) out.push(norm);
  }
  return out.length ? out : undefined;
}

function asWeaponProfile(v: any): WeaponProfile {
  if (!v || typeof v.name !== "string") throw new Error("Invalid weapon: missing name");
  if (typeof v.rangeInches !== "number") throw new Error(`Invalid weapon ${v.name}: rangeInches`);
  if (typeof v.ap !== "number") throw new Error(`Invalid weapon ${v.name}: ap`);
  if (!v.damage || (v.damage.type !== "flat" && v.damage.type !== "dice"))
    throw new Error(`Invalid weapon ${v.name}: damage`);
  if (v.damage.type === "flat" && typeof v.damage.value !== "number")
    throw new Error(`Invalid weapon ${v.name}: damage.value`);
  if (v.damage.type === "dice" && (v.damage.dice !== "D3" && v.damage.dice !== "D6"))
    throw new Error(`Invalid weapon ${v.name}: damage.dice`);
  if (typeof v.scatter !== "boolean") throw new Error(`Invalid weapon ${v.name}: scatter`);

  const abilities = normalizeAbilities(v.abilities);
  if (abilities) v.abilities = abilities;

  return v as WeaponProfile;
}

const W = (weaponsData as any).weapons;
const SPECIAL = (weaponsData as any).specialRules ?? {};

export const CORE_WEAPONS = Object.freeze({
  RAPID_FIRE_BATTLE_CANNON: Object.freeze(asWeaponProfile(W.RAPID_FIRE_BATTLE_CANNON)),
  THERMAL_CANNON_MAX: Object.freeze(asWeaponProfile(W.THERMAL_CANNON_MAX)),
  THERMAL_CANNON_HALF: Object.freeze(asWeaponProfile(W.THERMAL_CANNON_HALF)),
  AVENGER_GATLING_CANNON: Object.freeze(asWeaponProfile(W.AVENGER_GATLING_CANNON)),
  REAPER_CHAINSWORD: Object.freeze(asWeaponProfile(W.REAPER_CHAINSWORD)),
  THUNDERSTRIKE_GAUNTLET: Object.freeze(asWeaponProfile(W.THUNDERSTRIKE_GAUNTLET)),
  TWIN_ICARUS_AUTOCANNON: Object.freeze(asWeaponProfile(W.TWIN_ICARUS_AUTOCANNON)),
  STORMSPEAR_ROCKET_POD: Object.freeze(asWeaponProfile(W.STORMSPEAR_ROCKET_POD)),
  IRONSTORM_MISSILE_POD: Object.freeze(asWeaponProfile(W.IRONSTORM_MISSILE_POD)),
  HEAVY_STUBBER: Object.freeze(asWeaponProfile(W.HEAVY_STUBBER)),
  HEAVY_FLAMER: Object.freeze(asWeaponProfile(W.HEAVY_FLAMER)),
  MELTAGUN: Object.freeze(asWeaponProfile(W.MELTAGUN)),
} as const);

type RangeProfileRule = { equippedName: string; profiles: Array<{ weaponKey: keyof typeof CORE_WEAPONS; maxRange: number }> };

function getRangeProfileRules(): RangeProfileRule[] {
  const raw = SPECIAL.rangeProfiles;
  if (!raw) return [];
  if (!Array.isArray(raw)) throw new Error("Invalid weapons.json: specialRules.rangeProfiles must be an array");
  return raw as any;
}

/** Resolve an equipped weapon name into an actual weapon profile, including data-driven special rules. */
export function resolveWeaponProfileForEquippedName(
  equippedName: string,
  measuredRangeInches: number
): WeaponProfile | null {
  // Data-driven range-profile rules (e.g., Thermal cannon half/max profiles).
  for (const rule of getRangeProfileRules()) {
    if (rule.equippedName !== equippedName) continue;
    for (const p of rule.profiles) {
      if (measuredRangeInches <= p.maxRange) {
        return (CORE_WEAPONS as any)[p.weaponKey] as WeaponProfile;
      }
    }
    return null;
  }

  // Default: exact name match against core profiles
  return (Object.values(CORE_WEAPONS) as WeaponProfile[]).find((w) => w.name === equippedName) ?? null;
}
