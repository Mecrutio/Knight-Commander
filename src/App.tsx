import React, { useMemo, useState, useEffect, useRef } from "react";
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);


import { CORE_WEAPONS, WeaponProfile, resolveWeaponProfileForEquippedName, weaponHasAbility } from "./engine/core-weapons";
import { instantiateGrid, Grid, GridCell } from "./engine/grid";
import { QUESTORIS_GRID_TEMPLATE } from "./engine/questoris-grid";
import { QUESTORIS_CHASSIS, getChassis } from "./engine/chassis";
import { KnightState, type WeaponMount } from "./engine/criticals-core";
import { CORE_ACTION_COST, CORE_ACTION_ORDER, CoreAction, validatePlan, Plan, PlannedTurn } from "./engine/core-actions";
import { executeTurnMutating, GameState, TurnInputs, Vec2 } from "./engine/execute-turn";
import type { DiceOverrides } from "./engine/resolve-attack";
import { parseDiceString } from "./engine/dice-and-aim";
import type { FacingArc } from "./engine/facing-arcs";
import { arcShortLabel, bearingDeg, canFireAtTarget, relativeArc } from "./engine/facing-arcs";
import { type MapId, buildTerrainFromLayout, pickRandomMapId, mapOptions } from "./engine/maps";
import { computeLosEffects } from "./engine/terrain";
import type { TerrainPiece } from "./engine/terrain";

import { MapCanvas } from "./MapCanvas";
import rulesAppendix from "./content/rules-appendix.json";
import questorisLoadouts from "./content/loadouts/questoris-loadouts.json";

type PlayerId = "P1" | "P2";

type MoveMode = "ADVANCE" | "RUN" | "CHARGE";

type OrderPhase = "P1_ORDERS" | "PASS_TO_P2" | "P2_ORDERS" | "READY_TO_EXECUTE" | "POST_TURN_SUMMARY";
type AppTab = "PLAY" | "RULES";
const APP_VERSION = "Knight Commander-Build-a052";

function weaponTargetKeyForMountUi(mount: WeaponMount): string {
  switch (mount) {
    case "CARAPACE":
      return "CARAPACE";
    case "TORSO":
      return "TORSO";
    case "ARM_LEFT":
      return "ARM_LEFT_PRIMARY";
    case "ARM_RIGHT":
      return "ARM_RIGHT_PRIMARY";
    default:
      return String(mount);
  }
}
const AUTOSAVE_KEY = "knight-commander.autosave.v1";
const MANUAL_SAVE_KEY = "knight-commander.manualsave.v1";
const SAVE_VERSION = 1 as const;

type PersistedState = {
  chassisId: Record<PlayerId, string>;
  loadouts: Record<PlayerId, QuestorisLoadout>;
  knights: Record<PlayerId, KnightState>;
  turnNumber: number;
  phase: OrderPhase;
  revealLockedOrders: boolean;
  plans: PlannedTurn;
  selectedTargetCell: Record<PlayerId, string | null>;
  inputs: TurnInputs;
  log: string[];
  autoRoll: boolean;
  rangeInches: number;
  positions: Record<PlayerId, Vec2>;
  facings: Record<PlayerId, number>;
  mapId: MapId;
  loadoutLocked: boolean;
  weaponTargets: Record<PlayerId, Record<string, string>>;
  moveDestinations: Record<PlayerId, Record<MoveMode, Vec2 | null>>;
  moveEndFacings: Record<PlayerId, Record<MoveMode, number | null>>;
  activeMoveMode: Record<PlayerId, MoveMode>;
  gameOver: boolean;
};

type SaveFile = {
  version: typeof SAVE_VERSION;
  appVersion: string;
  savedAt: string; // ISO string
  state: PersistedState;
};

function safeReadSave(key: string): SaveFile | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SaveFile;
    if (!parsed || parsed.version !== SAVE_VERSION) return null;
    if (!parsed.state) return null;
    return parsed;
  } catch {
    return null;
  }
}

function downloadTextFile(filename: string, text: string, mime = "text/plain") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}


function makeKnight(chassisId: string, name: string, loadout: QuestorisLoadout): KnightState {
  const chassis = getChassis(chassisId);
  const grid = instantiateGrid(chassis.gridTemplate);
  return {
    name,
    grid,
    maxActionPoints: chassis.baseActionPoints,
    movementPenalty: 0,
    canRotateIonShields: true,
    weapons: buildWeaponsFromLoadout(loadout),
  };
}

type ArmLoadout = string;

type CarapaceLoadout = string;

type TorsoLoadout = string;

type QuestorisLoadout = {
  leftArm: ArmLoadout;
  rightArm: ArmLoadout;
  carapace: CarapaceLoadout;
  torso: TorsoLoadout;
};

const DEFAULT_LOADOUT: QuestorisLoadout = {
  leftArm: "RFBC_HS",
  rightArm: "GAUNTLET",
  carapace: "ICARUS",
  torso: "STUBBER",
};


function randomQuestorisLoadout(rng: () => number = Math.random): QuestorisLoadout {
  const pick = (slot: keyof LoadoutSlots) => {
    const arr = QUESTORIS_LOADOUTS.slots[slot];
    return arr[Math.floor(rng() * arr.length)]?.id ?? arr[0].id;
  };

  return {
    leftArm: pick("leftArm"),
    rightArm: pick("rightArm"),
    carapace: pick("carapace"),
    torso: pick("torso"),
  };
}


type LoadoutOption = { id: string; label: string; kind: "single" | "bundle" | "thermal"; weapons: string[] };
type LoadoutSlots = {
  leftArm: LoadoutOption[];
  rightArm: LoadoutOption[];
  carapace: LoadoutOption[];
  torso: LoadoutOption[];
};

const QUESTORIS_LOADOUTS = questorisLoadouts as { version: number; chassisId: string; slots: LoadoutSlots };

function optionById(slot: keyof LoadoutSlots, id: string): LoadoutOption {
  const opt = QUESTORIS_LOADOUTS.slots[slot].find((o) => o.id === id);
  if (!opt) throw new Error(`Unknown loadout option ${slot}:${id}`);
  return opt;
}

function loadoutOptionLabel(slot: keyof LoadoutSlots, id: string): string {
  const opt = QUESTORIS_LOADOUTS.slots[slot].find((o) => o.id === id);
  return opt ? opt.label : id;
}

function buildWeaponsFromLoadout(loadout: QuestorisLoadout) {
  const weapons: KnightState["weapons"] = [];

  const add = (weaponKey: string, mount: WeaponMount) => {
    const w = (CORE_WEAPONS as any)[weaponKey] as WeaponProfile | undefined;
    if (!w) throw new Error(`Unknown weapon key: ${weaponKey}`);
    weapons.push({ name: w.name, mount, disabled: false });
  };

  const addFromOption = (slot: keyof LoadoutSlots, mount: WeaponMount, optionId: string) => {
    const opt = optionById(slot, optionId);
    if (opt.kind === "thermal") {
      // Stored as canonical equipped name; resolved to half/max profile at fire time.
      weapons.push({ name: "Thermal cannon", mount, disabled: false });
      return;
    }
    for (const wk of opt.weapons) add(wk, mount);
  };

  addFromOption("leftArm", "ARM_LEFT", loadout.leftArm);
  addFromOption("rightArm", "ARM_RIGHT", loadout.rightArm);
  addFromOption("carapace", "CARAPACE", loadout.carapace);
  addFromOption("torso", "TORSO", loadout.torso);

  return weapons;
}

function applyLoadoutToKnight(k: KnightState, loadout: QuestorisLoadout): KnightState {
  // Preserve current damage state etc; only replace weapons.
  return { ...k, weapons: buildWeaponsFromLoadout(loadout) };
}

function isMeleeWeapon(w: WeaponProfile) {
  return w.scatter === false;
}

function rollD6() {
  return 1 + Math.floor(Math.random() * 6);
}

function RulesAppendix() {
  const ra = rulesAppendix as {
    title: string;
    intro: string;
    sections: {
      actionSequence: {
        heading: string;
        orderLabel: string;
        columns: string[];
        actions: Record<string, { name: string; desc: string }>;
      };
      victory?: { heading: string; items: Array<{ term: string; text: string }> };
      terrain: { heading: string; items: Array<{ term: string; text: string }> };
      criticals: { heading: string; items: Array<{ name: string; effect: string }> };
      weaponAbilities?: { heading: string; items: Array<{ name: string; effect: string }> };
      weapons: { heading: string; note: string; columns: string[] };
    };
  };

  const actionsByKey = ra.sections.actionSequence.actions as Record<
    CoreAction,
    { name: string; desc: string }
  >;

  const weapons = Object.values(CORE_WEAPONS);

  const formatDamage = (w: WeaponProfile) =>
    w.damage.type === "flat" ? String(w.damage.value) : w.damage.dice;

  const formatScatter = (w: WeaponProfile) => (w.scatter ? "Yes" : "No");

  return (
    <div style={{ marginTop: 14, border: "1px solid #e5e7eb", borderRadius: 12, padding: 14, background: "#fff" }}>
      <h2 style={{ marginTop: 0, marginBottom: 6 }}>{ra.title}</h2>
      <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 12 }}>{ra.intro}</div>

      <h3 style={{ marginBottom: 6 }}>{ra.sections.actionSequence.heading}</h3>
      <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 10 }}>
        {ra.sections.actionSequence.orderLabel} <b>{CORE_ACTION_ORDER.join(" → ")}</b>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "160px 60px 1fr", gap: 8, fontSize: 13 }}>
        <div style={{ fontWeight: 800, opacity: 0.8 }}>{ra.sections.actionSequence.columns[0]}</div>
        <div style={{ fontWeight: 800, opacity: 0.8 }}>{ra.sections.actionSequence.columns[1]}</div>
        <div style={{ fontWeight: 800, opacity: 0.8 }}>{ra.sections.actionSequence.columns[2]}</div>

        {CORE_ACTION_ORDER.map((key) => (
          <React.Fragment key={key}>
            <div><b>{actionsByKey[key]?.name ?? key}</b></div>
            <div>{(CORE_ACTION_COST as any)[key]}</div>
            <div style={{ opacity: 0.9 }}>{actionsByKey[key]?.desc ?? ""}</div>
          </React.Fragment>
        ))}
      </div>

      {ra.sections.victory && (
        <>
          <h3 style={{ marginTop: 18, marginBottom: 6 }}>{ra.sections.victory.heading}</h3>
          <div style={{ fontSize: 13, lineHeight: 1.45 }}>
            <ul style={{ marginTop: 6 }}>
              {ra.sections.victory.items.map((it) => (
                <li key={it.term}>
                  <b>{it.term}:</b> {it.text}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      <h3 style={{ marginTop: 18, marginBottom: 6 }}>{ra.sections.terrain.heading}</h3>
      <div style={{ fontSize: 13, lineHeight: 1.45 }}>
        <ul style={{ marginTop: 6 }}>
          {ra.sections.terrain.items.map((it) => (
            <li key={it.term}><b>{it.term}:</b> {it.text}</li>
          ))}
        </ul>
      </div>

      <h3 style={{ marginTop: 18, marginBottom: 6 }}>{ra.sections.criticals.heading}</h3>
      <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 8, fontSize: 13 }}>
        <div style={{ fontWeight: 800, opacity: 0.8 }}>Critical</div>
        <div style={{ fontWeight: 800, opacity: 0.8 }}>Effect</div>
        {ra.sections.criticals.items.map((c) => (
          <React.Fragment key={c.name}>
            <div><b>{c.name}</b></div>
            <div style={{ opacity: 0.9 }}>{c.effect}</div>
          </React.Fragment>
        ))}
      </div>

      {ra.sections.weaponAbilities && (
        <>
          <h3 style={{ marginTop: 18, marginBottom: 6 }}>{ra.sections.weaponAbilities.heading}</h3>
          <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 8, fontSize: 13 }}>
            <div style={{ fontWeight: 800, opacity: 0.8 }}>Ability</div>
            <div style={{ fontWeight: 800, opacity: 0.8 }}>Effect</div>
            {ra.sections.weaponAbilities.items.map((c) => (
              <React.Fragment key={c.name}>
                <div><b>{c.name}</b></div>
                <div style={{ opacity: 0.9 }}>{c.effect}</div>
              </React.Fragment>
            ))}
          </div>
        </>
      )}

      <h3 style={{ marginTop: 18, marginBottom: 6 }}>{ra.sections.weapons.heading}</h3>
      <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 8 }}>{ra.sections.weapons.note}</div>

      <div style={{ display: "grid", gridTemplateColumns: "260px 80px 60px 120px 140px", gap: 8, fontSize: 13 }}>
        <div style={{ fontWeight: 800, opacity: 0.8 }}>{ra.sections.weapons.columns[0]}</div>
        <div style={{ fontWeight: 800, opacity: 0.8 }}>{ra.sections.weapons.columns[1]}</div>
        <div style={{ fontWeight: 800, opacity: 0.8 }}>{ra.sections.weapons.columns[2]}</div>
        <div style={{ fontWeight: 800, opacity: 0.8 }}>{ra.sections.weapons.columns[3]}</div>
        <div style={{ fontWeight: 800, opacity: 0.8 }}>{ra.sections.weapons.columns[4]}</div>

        {weapons.map((w) => (
          <React.Fragment key={w.name}>
            <div><b>{w.name}</b></div>
            <div>{w.rangeInches}"</div>
            <div>{w.ap}</div>
            <div>{formatDamage(w)}</div>
            <div>{formatScatter(w)}</div>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

// Component label (from the core Critical Damage Table groups)
function cellComponentLabel(grid: Grid, cell: GridCell): string {
  switch (cell.group) {
    case 1: return "Carapace Wpn";
    case 2: return "Carapace";
    case 4: return "Tilt Shield";
    case 5: return "Head";
    case 6: return "Torso Wpn";
    case 7: return "Torso";
    case 8: return "Legs";
    case 3: {
      const mid = (grid.width - 1) / 2;
      if (cell.x < mid) return "L Arm";
      if (cell.x > mid) return "R Arm";
      return "Arm";
    }
  }
}

function groupFill(group: number): string {
  switch (group) {
    case 1: return "#E3F2FD";
    case 2: return "#BBDEFB";
    case 3: return "#E8F5E9";
    case 4: return "#FFF3E0";
    case 5: return "#F3E5F5";
    case 6: return "#FFE0B2";
    case 7: return "#E0F7FA";
    case 8: return "#ECEFF1";
    default: return "#FFFFFF";
  }
}

function groupStroke(group: number): string {
  switch (group) {
    case 1: return "#90CAF9";
    case 2: return "#64B5F6";
    case 3: return "#81C784";
    case 4: return "#FFB74D";
    case 5: return "#CE93D8";
    case 6: return "#FFCC80";
    case 7: return "#80DEEA";
    case 8: return "#B0BEC5";
    default: return "#CCCCCC";
  }
}


function actionApCost(action: ActionType): number {
  switch (action) {
    case "SNAP_ATTACK":
      return 1;
    case "ADVANCE":
      return 1;
    case "ROTATE_ION_SHIELDS":
      return 1;
    case "STANDARD_ATTACK":
      return 2;
    case "RUN":
      return 1;
    case "AIMED_ATTACK":
      return 3;
    case "CHARGE":
      return 2;
    default:
      return 0;
  }
}

// Keep UI order aligned with CORE_ACTION_ORDER (Option B: allow Run after Standard Attack, before Aimed Attack).
const ACTION_ORDER = ["SNAP_ATTACK","ADVANCE","ROTATE_ION_SHIELDS","STANDARD_ATTACK","RUN","AIMED_ATTACK","CHARGE"] as const;

type ActionType = CoreAction;
type PlayerPlan = Plan;

function setPlanActionEnabled(plan: PlayerPlan, action: CoreAction, enabled: boolean): PlayerPlan {
  const has = plan.actions.includes(action);
  if (enabled && has) return plan;
  if (!enabled && !has) return plan;
  const nextActions = enabled ? [...plan.actions, action] : plan.actions.filter((a) => a !== action);
  return { ...plan, actions: nextActions };
}

function PlayerPanel(props: {
  player: PlayerId;
  knight: KnightState;
  enemy: KnightState;
  baseGrid: Grid;
  loadout: QuestorisLoadout;
  onLoadoutChange: (next: QuestorisLoadout) => void;
  loadoutLocked: boolean;
  plan: PlayerPlan;
  apSpent: number;
  onToggleAction: (action: ActionType, enabled: boolean) => void;
  issues: string[];
  gridCells: { id: string }[];
  weaponTargets: Record<string, string>;
  onWeaponTargetsChange: (next: Record<string, string>) => void;
  defaultTargetCellId: string;
  mapSlot?: React.ReactNode;
}) {
  const { player, knight, baseGrid, loadout, onLoadoutChange, loadoutLocked, plan, apSpent, onToggleAction, issues } =
    props;





  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 16, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
        <h2 style={{ margin: 0 }}>{player}</h2>
        <div style={{ fontSize: 12, opacity: 0.8 }}>
          AP Remaining: <b>{Math.max(0, (knight?.maxActionPoints ?? 0) - apSpent)}</b> / {knight?.maxActionPoints ?? 0}
        </div>
      </div>

      <div style={{ marginTop: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <div style={{ fontWeight: 800 }}>Loadout</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: loadoutLocked ? "#b00020" : "#444" }}>
            {loadoutLocked ? "LOCKED" : "Unlocked"}
            {!loadoutLocked && <span style={{ marginLeft: 8, fontWeight: 400, opacity: 0.75 }}>(locks after Turn 1)</span>}
          </div>
        </div>
        <LoadoutSelect loadout={loadout} onChange={onLoadoutChange} locked={loadoutLocked} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "300px 1fr 320px", gap: 14, marginTop: 14, alignItems: "start" }}>
        <div>
          <WeaponTargetingHUD
            loadout={loadout}
            gridCells={props.gridCells}
            weaponTargets={props.weaponTargets}
            onChange={props.onWeaponTargetsChange}
            defaultTargetCellId={props.defaultTargetCellId}
          />
</div>

        <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 12 }}>
          <div style={{ fontWeight: 800, marginBottom: 10 }}>Knight Grid</div>
          <GridView grid={baseGrid} liveGrid={knight.grid} selectedCellId={null} onSelect={() => {}} />
        </div>

        <CriticalEffectsHUD knight={knight} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "300px 1fr 320px", gap: 14, marginTop: 14, alignItems: "start" }}>
        {/* Actions (left), Map (centered under the Knight Grid column), spacer (right) */}
        <div>
          <div style={{ fontWeight: 800, marginBottom: 8 }}>Actions</div>
          <div style={{ display: "grid", gap: 6 }}>
            {ACTION_ORDER.map((a) => (
              <label key={a} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <input
                  type="checkbox"
                  checked={plan.actions.includes(a)}
                  onChange={(e) => onToggleAction(a, e.target.checked)}
                />
                <span style={{ width: 160 }}>{a}</span>
                <span style={{ fontSize: 12, opacity: 0.8 }}>{actionApCost(a)} AP</span>
              </label>
            ))}
          </div>

          {plan.actions.includes("ROTATE_ION_SHIELDS") && (
            <div style={{ marginTop: 10, border: "1px solid #eee", borderRadius: 12, padding: 10 }}>
              <div style={{ fontWeight: 900, marginBottom: 6 }}>Rotate Ion Shields</div>
              <div style={{ fontSize: 12, opacity: 0.78, lineHeight: 1.35 }}>
                Until the end of this turn, you gain <b>+1 to Armour Saves</b> from all directions.
                <div style={{ marginTop: 6 }}>
                  Your Ion Save always protects the <b>Front</b> arc (unless the Tilting Shield is destroyed).
                </div>
              </div>

              {!knight.canRotateIonShields && (
                <div style={{ marginTop: 8, fontSize: 12, color: "#b00020", fontWeight: 800 }}>
                  Tilting shield destroyed — no Ion Save and cannot Rotate.
                </div>
              )}
            </div>
          )}

          {issues.length > 0 && (
            <div style={{ marginTop: 10, color: "crimson", fontSize: 12 }}>
              {issues.map((x) => (
                <div key={x}>• {x}</div>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "center" }}>
          {props.mapSlot ? props.mapSlot : null}
        </div>

        <div />
      </div>
    </div>
  );
}




type GameMode = "TWO_PLAYER" | "SOLO" | "VS_AI";

type TurnStartSnapshot = {
  turnNumber: number;
  positions: Record<PlayerId, Vec2>;
  facings: Record<PlayerId, number>;
};
type AppScreen = "HOME" | "MENU" | "HOW_TO_PLAY" | "GAME";

function HomeScreen(props: { onPlay: () => void; onHowToPlay: () => void }) {
  return (
    <div
      style={{
        border: "1px solid #eee",
        borderRadius: 20,
        padding: 18,
        maxWidth: 780,
        margin: "24px auto 0",
        background: "linear-gradient(180deg, #fff 0%, #fafafa 100%)",
      }}
    >
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 14, letterSpacing: 1, opacity: 0.75, fontWeight: 800 }}>KNIGHT COMMANDER</div>
        <div style={{ fontSize: 34, fontWeight: 1000, marginTop: 6 }}>Knight Commander</div>
        <div style={{ marginTop: 10, fontSize: 14, opacity: 0.8 }}>
          A quick-play companion for the Knight Commander prototype.
        </div>
      </div>

      <div style={{ display: "grid", gap: 12, marginTop: 18 }}>
        <button
          onClick={props.onPlay}
          style={{
            padding: "16px 18px",
            borderRadius: 16,
            border: "1px solid #111",
            background: "#111",
            color: "#fff",
            fontWeight: 1000,
            textAlign: "left",
          }}
        >
          Play
          <div style={{ fontSize: 12, fontWeight: 700, marginTop: 4, opacity: 0.9 }}>
            Start a new match or load a save
          </div>
        </button>

        <button
          onClick={props.onHowToPlay}
          style={{
            padding: "16px 18px",
            borderRadius: 16,
            border: "1px solid #e5e7eb",
            background: "#fff",
            color: "#111",
            fontWeight: 1000,
            textAlign: "left",
          }}
        >
          How to Play
          <div style={{ fontSize: 12, fontWeight: 700, marginTop: 4, opacity: 0.9 }}>
            Quick start + key rules
          </div>
        </button>
      </div>

      <div style={{ marginTop: 16, fontSize: 12, opacity: 0.7, textAlign: "center" }}>{APP_VERSION}</div>
    </div>
  );
}

function HowToPlayScreen(props: { onBackHome: () => void; onPlay: () => void }) {
  return (
    <div
      style={{
        border: "1px solid #eee",
        borderRadius: 20,
        padding: 18,
        maxWidth: 900,
        margin: "24px auto 0",
        background: "linear-gradient(180deg, #fff 0%, #fafafa 100%)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <button onClick={props.onBackHome} style={{ padding: "10px 12px", borderRadius: 12 }}>
          ← Home
        </button>
        <button
          onClick={props.onPlay}
          style={{
            padding: "10px 12px",
            borderRadius: 12,
            border: "1px solid #111",
            background: "#111",
            color: "#fff",
            fontWeight: 900,
          }}
        >
          Play
        </button>
      </div>

      <h1 style={{ marginTop: 16, marginBottom: 6 }}>How to Play</h1>
      <div style={{ opacity: 0.85, marginBottom: 14 }}>
        This is the minimal flow as implemented in the current build.
      </div>

      <div style={{ display: "grid", gap: 12 }}>
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 16, background: "#fff", padding: "12px 14px" }}>
          <div style={{ fontWeight: 1000 }}>1) Setup</div>
          <ul style={{ marginTop: 8, marginBottom: 0, paddingLeft: 18, opacity: 0.9 }}>
            <li>Tap <b>Play</b>, choose a mode, and pick a map layout (or Random).</li>
            <li>Each player picks a loadout and builds their action plan for the turn.</li>
          </ul>
        </div>

        <div style={{ border: "1px solid #e5e7eb", borderRadius: 16, background: "#fff", padding: "12px 14px" }}>
          <div style={{ fontWeight: 1000 }}>2) Plan your turn</div>
          <ul style={{ marginTop: 8, marginBottom: 0, paddingLeft: 18, opacity: 0.9 }}>
            <li>Select actions until you hit your AP limit.</li>
            <li>Choose weapon targets, then plot movement waypoints on the map.</li>
            <li>While plotting movement, a dashed ring shows your <b>max distance</b> for the selected step.</li>
          </ul>
        </div>

        <div style={{ border: "1px solid #e5e7eb", borderRadius: 16, background: "#fff", padding: "12px 14px" }}>
          <div style={{ fontWeight: 1000 }}>3) Lock orders → Execute</div>
          <ul style={{ marginTop: 8, marginBottom: 0, paddingLeft: 18, opacity: 0.9 }}>
            <li>P1 locks orders, then pass the device for P2 to plan.</li>
            <li>Tap <b>Execute Turn</b> to resolve actions in sequence and see the results page.</li>
          </ul>
        </div>

        <div style={{ border: "1px solid #e5e7eb", borderRadius: 16, background: "#fff", padding: "12px 14px" }}>
          <div style={{ fontWeight: 1000 }}>Destroyed condition</div>
          <div style={{ marginTop: 8, opacity: 0.9, lineHeight: 1.45 }}>
            A knight is considered <b>destroyed</b> when <b>6 grid locations</b> are <b>critically damaged</b>
            (i.e., their armour is reduced to 0). At that point the match ends.
          </div>
        </div>
      </div>

      <div style={{ marginTop: 14, fontSize: 12, opacity: 0.75 }}>
        For the full rules appendix, open the <b>Rules</b> tab while in a match.
      </div>
    </div>
  );
}

function StartMenu(props: {
  onBackHome: () => void;
  onHowToPlay: () => void;
  onStartTwoPlayerNewGame: () => void;
  onStartVsAiNewGame: () => void;
  onLoadLastSave: () => void;
  onImportSave: (file: File) => void;
  hasLastSave: boolean;

  mapOptions: Array<{ id: MapId; name: string }>;
  selectedMapId: MapId;
  setSelectedMapId: (id: MapId) => void;
  randomMap: boolean;
  setRandomMap: (v: boolean) => void;
}) {
  return (
    <div
      style={{
        border: "1px solid #eee",
        borderRadius: 20,
        padding: 18,
        maxWidth: 780,
        margin: "24px auto 0",
        background: "linear-gradient(180deg, #fff 0%, #fafafa 100%)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <button onClick={props.onBackHome} style={{ padding: "10px 12px", borderRadius: 12 }}>
          ← Home
        </button>
        <button onClick={props.onHowToPlay} style={{ padding: "10px 12px", borderRadius: 12 }}>
          How to Play
        </button>
      </div>

      <div style={{ textAlign: "center", marginTop: 10 }}>
        <div style={{ fontSize: 14, letterSpacing: 1, opacity: 0.75, fontWeight: 800 }}>KNIGHT COMMANDER</div>
        <div style={{ fontSize: 34, fontWeight: 1000, marginTop: 6 }}>Knight Commander</div>
        <div style={{ marginTop: 10, fontSize: 14, opacity: 0.8 }}>
          Prototype rules companion (Core Questoris). Choose a mode to begin.
        </div>
      </div>

      <div style={{ display: "grid", gap: 12, marginTop: 18 }}>

        <div
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 16,
            background: "#fff",
            padding: "12px 14px",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontWeight: 1000 }}>Map</div>
              <div style={{ fontSize: 12, opacity: 0.8, marginTop: 2 }}>Choose a preset layout, or enable Random Map.</div>
            </div>

            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 800 }}>
              <input
                type="checkbox"
                checked={props.randomMap}
                onChange={(e) => props.setRandomMap(e.target.checked)}
              />
              Random map
            </label>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
            <div style={{ fontSize: 13, fontWeight: 900, opacity: 0.85 }}>Preset:</div>
            <select
              value={props.selectedMapId}
              disabled={props.randomMap}
              onChange={(e) => props.setSelectedMapId(e.target.value as MapId)}
              style={{
                padding: "8px 10px",
                borderRadius: 12,
                border: "1px solid #e5e7eb",
                fontWeight: 800,
                minWidth: 280,
                background: props.randomMap ? "#f8fafc" : "#fff",
                color: props.randomMap ? "#94a3b8" : "#111",
              }}
            >
              {props.mapOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <button
          disabled
          style={{
            padding: "14px 16px",
            borderRadius: 16,
            border: "1px solid #e5e7eb",
            background: "#f8fafc",
            color: "#94a3b8",
            fontWeight: 900,
            textAlign: "left",
          }}
          title="Coming soon"
        >
          1 Player (Coming soon)
          <div style={{ fontSize: 12, fontWeight: 600, marginTop: 4, opacity: 0.85 }}>
            Solo reference / assisted play (not yet implemented)
          </div>
        </button>

        <button
          onClick={props.onStartTwoPlayerNewGame}
          style={{
            padding: "14px 16px",
            borderRadius: 16,
            border: "1px solid #111",
            background: "#111",
            color: "#fff",
            fontWeight: 1000,
            textAlign: "left",
          }}
        >
          2 Player Automated (New Game)
          <div style={{ fontSize: 12, fontWeight: 700, marginTop: 4, opacity: 0.9 }}>
            Starts a fresh match (secret orders → simultaneous resolution → post-turn summary)
          </div>
        </button>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <button
            onClick={props.onLoadLastSave}
            disabled={!props.hasLastSave}
            style={{
              padding: "12px 14px",
              borderRadius: 16,
              border: "1px solid #e5e7eb",
              background: props.hasLastSave ? "#fff" : "#f8fafc",
              color: props.hasLastSave ? "#111" : "#94a3b8",
              fontWeight: 900,
              textAlign: "left",
            }}
            title={props.hasLastSave ? "Load the most recent save" : "No save found yet"}
          >
            Load last save
            <div style={{ fontSize: 12, fontWeight: 600, marginTop: 4, opacity: 0.85 }}>
              Resume your latest match
            </div>
          </button>

          <label
            style={{
              padding: "12px 14px",
              borderRadius: 16,
              border: "1px solid #e5e7eb",
              background: "#fff",
              color: "#111",
              fontWeight: 900,
              textAlign: "left",
              cursor: "pointer",
            }}
          >
            Load save file
            <div style={{ fontSize: 12, fontWeight: 600, marginTop: 4, opacity: 0.85 }}>
              Import a .json save
            </div>
            <input
              type="file"
              accept="application/json"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                props.onImportSave(f);
                e.currentTarget.value = "";
              }}
            />
          </label>
        </div>

        <button
          onClick={props.onStartVsAiNewGame}
          style={{
            padding: "14px 16px",
            borderRadius: 16,
            border: "1px solid #111",
            background: "#fff",
            color: "#111",
            fontWeight: 1000,
            textAlign: "left",
          }}
        >
          VS AI (New Game)
          <div style={{ fontSize: 12, fontWeight: 700, marginTop: 4, opacity: 0.9 }}>
            Play against a simple AI opponent (heuristic orders + targeting)
          </div>
        </button>
      </div>

      <div style={{ marginTop: 16, fontSize: 12, opacity: 0.7, textAlign: "center" }}>
        Tip: You can install this as a PWA on Android via Chrome → ⋮ → “Add to Home screen”.
      </div>
    </div>
  );
}

export default function App() {
  const availableMaps = useMemo(() => mapOptions(), []);
  const [menuRandomMap, setMenuRandomMap] = useState<boolean>(true);
  const [menuSelectedMapId, setMenuSelectedMapId] = useState<MapId>(() => (availableMaps[0]?.id ?? "standard-48") as MapId);

  const [chassisId, setChassisId] = useState<Record<PlayerId, string>>({ P1: QUESTORIS_CHASSIS.id, P2: QUESTORIS_CHASSIS.id });

  const baseGrids = useMemo(() => ({
    P1: instantiateGrid(getChassis(chassisId.P1).gridTemplate),
    P2: instantiateGrid(getChassis(chassisId.P2).gridTemplate),
  }), [chassisId]);

  const [loadouts, setLoadouts] = useState<Record<PlayerId, QuestorisLoadout>>({
    P1: DEFAULT_LOADOUT,
    P2: DEFAULT_LOADOUT,
  });

  const [knights, setKnights] = useState<Record<PlayerId, KnightState>>({
    P1: makeKnight(chassisId.P1, "P1 Knight", DEFAULT_LOADOUT),
    P2: makeKnight(chassisId.P2, "P2 Knight", DEFAULT_LOADOUT),
  });

  const [turnNumber, setTurnNumber] = useState(1);
  const [phase, setPhase] = useState<OrderPhase>("P1_ORDERS");
  const [screen, setScreen] = useState<AppScreen>("HOME");
  const [activeTab, setActiveTab] = useState<AppTab>("PLAY");
  const [gameMode, setGameMode] = useState<GameMode>("TWO_PLAYER");
  const [revealLockedOrders, setRevealLockedOrders] = useState(false);
  const [plans, setPlans] = useState<PlannedTurn>({ P1: { actions: [] }, P2: { actions: [] } });

const apSpentByPlayer: Record<PlayerId, number> = useMemo(() => {
  return {
    P1: plans.P1.actions.reduce((s, a) => s + actionApCost(a), 0),
    P2: plans.P2.actions.reduce((s, a) => s + actionApCost(a), 0),
  };
}, [plans]);


  // Per-player target selection:
  // - P1 selects a cell on P2's grid
  // - P2 selects a cell on P1's grid
  const [selectedTargetCell, setSelectedTargetCell] = useState<Record<PlayerId, string | null>>({
    P1: null,
    P2: null,
  });

  const [inputs, setInputs] = useState<TurnInputs>({ P1: {}, P2: {} });
  const [log, setLog] = useState<string[]>([]);
  const [lastTurnLog, setLastTurnLog] = useState<string[]>([]);
  const [showSummaryLog, setShowSummaryLog] = useState(false);
  const [autoRoll, setAutoRoll] = useState(true);
  const [rangeInches, setRangeInches] = useState(24);

  // 48x48" map environment (game space inches)
  const DEFAULT_POSITIONS: Record<PlayerId, Vec2> = useMemo(
    () => ({ P1: { x: 6, y: 24 }, P2: { x: 42, y: 24 } }),
    []
  );

  const SPAWN_PAIRS: Array<Record<PlayerId, Vec2>> = useMemo(() => {
    const c = 24; // center of 48x48 board
    const d = 18; // distance from center
    const o = d / Math.sqrt(2); // diagonal offset (kept as float to satisfy exact 18" radius)
    return [
      // East-West
      { P1: { x: c - d, y: c }, P2: { x: c + d, y: c } },
      // North-South
      { P1: { x: c, y: c - d }, P2: { x: c, y: c + d } },
      // NorthEast - SouthWest
      { P1: { x: c + o, y: c - o }, P2: { x: c - o, y: c + o } },
      // NorthWest - SouthEast
      { P1: { x: c - o, y: c - o }, P2: { x: c + o, y: c + o } },
    ];
  }, []);

  const pickRandomSpawnPositions = () => {
    const i = Math.floor(Math.random() * SPAWN_PAIRS.length);
    return SPAWN_PAIRS[i];
  };

  const [positions, setPositions] = useState<Record<PlayerId, Vec2>>(DEFAULT_POSITIONS);

  // Facing is stored in degrees. 0° = east (+X), 90° = south (+Y) in screen/world space.
  const normDeg = (d: number) => ((d % 360) + 360) % 360;
  const bearingDeg = (from: Vec2, to: Vec2) => normDeg((Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI);
  const faceEachOther = (pos: Record<PlayerId, Vec2>): Record<PlayerId, number> => ({
    P1: bearingDeg(pos.P1, pos.P2),
    P2: bearingDeg(pos.P2, pos.P1),
  });

  const [facings, setFacings] = useState<Record<PlayerId, number>>(() => faceEachOther(DEFAULT_POSITIONS));

  // Snapshot of *public* state at the start of the current turn.
  // VS AI uses this so the AI doesn't peek at any human-plotted orders mid-planning.
  const [turnStart, setTurnStart] = useState<TurnStartSnapshot>(() => ({
    turnNumber: 1,
    positions: DEFAULT_POSITIONS,
    facings: faceEachOther(DEFAULT_POSITIONS),
  }));


  // Map layout + terrain are data-driven via JSON.
  const [mapId, setMapId] = useState<MapId>(() => pickRandomMapId());
  const terrain: TerrainPiece[] = useMemo(() => buildTerrainFromLayout(mapId), [mapId]);

  // When a knight is destroyed, the match ends and the end-of-turn summary should offer New Game / Main Menu.
  const [gameOver, setGameOver] = useState(false);
  const [moveDestinations, setMoveDestinations] = useState<Record<PlayerId, Record<MoveMode, Vec2 | null>>>({
    P1: { ADVANCE: null, RUN: null, CHARGE: null },
    P2: { ADVANCE: null, RUN: null, CHARGE: null },
  });

  // Optional facing overrides after each move type. If null, engine auto-faces along movement.
  const [moveEndFacings, setMoveEndFacings] = useState<Record<PlayerId, Record<MoveMode, number | null>>>({
    P1: { ADVANCE: null, RUN: null, CHARGE: null },
    P2: { ADVANCE: null, RUN: null, CHARGE: null },
  });
  // Default movement plotting mode at the start of a turn is ADVANCE.
  const [activeMoveMode, setActiveMoveMode] = useState<Record<PlayerId, MoveMode>>({ P1: "ADVANCE", P2: "ADVANCE" });

  const maxMoveInchesByPlayer: Record<PlayerId, Record<MoveMode, number>> = useMemo(() => {
    const out: Record<PlayerId, Record<MoveMode, number>> = {
      P1: { ADVANCE: 0, RUN: 0, CHARGE: 0 },
      P2: { ADVANCE: 0, RUN: 0, CHARGE: 0 },
    };
    (Object.keys(out) as PlayerId[]).forEach((p) => {
      const chassis = getChassis(chassisId[p]);
      const penalty = knights[p]?.movementPenalty ?? 0;
      out[p].ADVANCE = Math.max(0, (chassis.movement.advanceInches ?? 0) - penalty);

      const parsed = parseDiceString(chassis.movement.runDice);
      const runMax = parsed ? parsed.count * parsed.sides : 0;
      out[p].RUN = Math.max(0, runMax - penalty);

      out[p].CHARGE = Math.max(0, (chassis.movement.chargeInches ?? 0) - penalty);
    });
    return out;
  }, [chassisId, knights]);

  const measuredRangeInches = useMemo(() => {
    const dx = positions.P1.x - positions.P2.x;
    const dy = positions.P1.y - positions.P2.y;
    // Whole-inch map grid: keep displayed/measured range in whole inches.
    return Math.round(Math.sqrt(dx * dx + dy * dy));
  }, [positions]);
  const [loadoutLocked, setLoadoutLocked] = useState(false);

const [summaryFocus, setSummaryFocus] = useState<PlayerId>("P1");
const [summaryMode, setSummaryMode] = useState<"SPLIT" | "FOCUS">("SPLIT");
const [isNarrow, setIsNarrow] = useState(false);
const [lastTurnHighlights, setLastTurnHighlights] = useState<Record<PlayerId, Record<string, "damaged" | "destroyed">>>({
  P1: {},
  P2: {},
});
const [lastTurnMoveSegments, setLastTurnMoveSegments] = useState<Record<PlayerId, { from: Vec2; to: Vec2 } | null>>({
  P1: null,
  P2: null,
});
const [highlightToken, setHighlightToken] = useState(0);

useEffect(() => {
  const onResize = () => setIsNarrow(window.innerWidth < 900);
  onResize();
  window.addEventListener("resize", onResize);
  return () => window.removeEventListener("resize", onResize);
}, []);
  const [weaponTargets, setWeaponTargets] = useState<Record<PlayerId, Record<string, string>>>({ P1: {}, P2: {} });

const [lastAutoSavedAt, setLastAutoSavedAt] = useState<string | null>(null);
  const [lastManualSavedAt, setLastManualSavedAt] = useState<string | null>(null);
const [hasHydrated, setHasHydrated] = useState(false);
const autoSaveTimer = useRef<number | null>(null);

function buildPersistedState(): PersistedState {
  return {
    chassisId,
    loadouts,
    knights,
    turnNumber,
    phase,
    revealLockedOrders,
    plans,
    selectedTargetCell,
    inputs,
    log,
    autoRoll,
    rangeInches,
    loadoutLocked,
    weaponTargets,
    positions,
    facings,
    mapId,
    moveDestinations,
    moveEndFacings,
    activeMoveMode,
    gameOver,
  };
}

function writeSave(state: PersistedState, opts?: { silent?: boolean }, key: string = AUTOSAVE_KEY) {
  const payload: SaveFile = {
    version: SAVE_VERSION,
    appVersion: APP_VERSION,
    savedAt: new Date().toISOString(),
    state,
  };
  localStorage.setItem(key, JSON.stringify(payload));
  if (key === MANUAL_SAVE_KEY) setLastManualSavedAt(payload.savedAt);
    else setLastAutoSavedAt(payload.savedAt);
  if (!opts?.silent) {
    setLog((prev) => [...prev, `💾 Saved (${new Date(payload.savedAt).toLocaleString()})`]);
  }
}

function applyPersistedState(state: PersistedState, opts?: { silent?: boolean }) {
  // Be forgiving: if any field is missing, fall back to current defaults.
  setChassisId((state as any).chassisId ?? chassisId);
  setLoadouts(state.loadouts ?? loadouts);
  setKnights(state.knights ?? knights);
  setTurnNumber(state.turnNumber ?? turnNumber);
  setPhase(state.phase ?? "P1_ORDERS");
  setRevealLockedOrders(state.revealLockedOrders ?? false);
  setPlans(state.plans ?? { P1: { actions: [] }, P2: { actions: [] } });
  setSelectedTargetCell(state.selectedTargetCell ?? { P1: null, P2: null });
  setInputs(state.inputs ?? { P1: {}, P2: {} });
  setLog(state.log ?? []);
  setAutoRoll(state.autoRoll ?? true);
  setRangeInches(state.rangeInches ?? 24);
  setLoadoutLocked(state.loadoutLocked ?? false);
  setWeaponTargets(state.weaponTargets ?? { P1: {}, P2: {} });

  // Determine whether the match is over. Prefer explicit field; fall back to log scan for older saves.
  const logHasDestroyed = (state.log ?? []).some((l) => l.includes("💥") || /\bdestroyed\b/i.test(l));
  setGameOver((state as any).gameOver ?? logHasDestroyed);
  // Older saves may contain fractional coords; keep map on whole-inch grid.
  const snap = (v: Vec2) => ({ x: Math.round(v.x), y: Math.round(v.y) });
  const nextPos = state.positions
    ? { P1: snap(state.positions.P1), P2: snap(state.positions.P2) }
    : positions;
  setPositions(nextPos);

  // Facing (optional for older saves). Default to facing each other based on current positions.
  setFacings(((state as any).facings as Record<PlayerId, number>) ?? faceEachOther(nextPos));

  // Refresh turn-start snapshot on load (for VS AI parity).
  setTurnStart({
    turnNumber: state.turnNumber ?? turnNumber,
    positions: nextPos,
    facings: (((state as any).facings as Record<PlayerId, number>) ?? faceEachOther(nextPos)),
  });

  // Map layout is optional for older saves.
  setMapId(((state as any).mapId as MapId) ?? mapId);
  if ((state as any).moveDestinations) {
    setMoveDestinations((state as any).moveDestinations);
    // Optional: end-facing overrides for each plotted move type.
    setMoveEndFacings(
      ((state as any).moveEndFacings as Record<PlayerId, Record<MoveMode, number | null>>) ??
        { P1: { ADVANCE: null, RUN: null, CHARGE: null }, P2: { ADVANCE: null, RUN: null, CHARGE: null } }
    );
    const am = ((state as any).activeMoveMode) ?? { P1: "ADVANCE", P2: "ADVANCE" };
    const sanitizeMoveMode = (m: any): MoveMode => (m === "RUN" ? "RUN" : "ADVANCE");
    setActiveMoveMode({ P1: sanitizeMoveMode(am.P1), P2: sanitizeMoveMode(am.P2) });
  } else {
    // Back-compat: older saves used a single destination per player
    const legacy = (state as any).destinations as Record<PlayerId, Vec2 | null> | undefined;
    const md: Record<PlayerId, Record<MoveMode, Vec2 | null>> = {
      P1: { ADVANCE: legacy?.P1 ?? null, RUN: legacy?.P1 ?? null, CHARGE: legacy?.P1 ?? null },
      P2: { ADVANCE: legacy?.P2 ?? null, RUN: legacy?.P2 ?? null, CHARGE: legacy?.P2 ?? null },
    };
    setMoveDestinations(md);
    setMoveEndFacings({ P1: { ADVANCE: null, RUN: null, CHARGE: null }, P2: { ADVANCE: null, RUN: null, CHARGE: null } });
    setActiveMoveMode({ P1: "ADVANCE", P2: "ADVANCE" });
  }

  if (!opts?.silent) {
    setLog((prev) => [...prev, `📥 Loaded save`]);
  }
}

function saveNow(opts?: { silent?: boolean }) {
    writeSave(buildPersistedState(), opts, MANUAL_SAVE_KEY);
  }

function loadLastSave() {
  const saved = safeReadSave(MANUAL_SAVE_KEY);
  if (!saved) {
    setLog((prev) => [...prev, "ℹ️ No saved game found."]);
    return;
  }
  setLastManualSavedAt(saved.savedAt);
  applyPersistedState(saved.state, { silent: true });
  setLog((prev) => [...prev, `📥 Loaded save (${new Date(saved.savedAt).toLocaleString()})`]);
}

function exportSaveJson() {
  const payload: SaveFile = {
    version: SAVE_VERSION,
    appVersion: APP_VERSION,
    savedAt: new Date().toISOString(),
    state: buildPersistedState(),
  };
  downloadTextFile(`knight-commander-save-${turnNumber}.json`, JSON.stringify(payload, null, 2), "application/json");
}

function importSaveJsonText(text: string) {
  try {
    const parsed = JSON.parse(text) as SaveFile;
    if (!parsed || parsed.version !== SAVE_VERSION || !parsed.state) {
      setLog((prev) => [...prev, "❌ Invalid save file (version mismatch)."]);
      return;
    }
    applyPersistedState(parsed.state, { silent: true });
    setLastAutoSavedAt(parsed.savedAt ?? null);
      setLastManualSavedAt(parsed.savedAt ?? null);
    setLog((prev) => [...prev, `📥 Imported save (${parsed.savedAt ? new Date(parsed.savedAt).toLocaleString() : "unknown date"})`]);
    // persist immediately
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(parsed));
      localStorage.setItem(MANUAL_SAVE_KEY, JSON.stringify(parsed));
      setLastAutoSavedAt(parsed.savedAt ?? null);
      setLastManualSavedAt(parsed.savedAt ?? null);
  } catch {
    setLog((prev) => [...prev, "❌ Could not import save (bad JSON)."]);
  }
}

function copyLogToClipboard() {
  const text = log.join("\n");
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(
      () => setLog((prev) => [...prev, "📋 Log copied to clipboard"]),
      () => setLog((prev) => [...prev, "❌ Could not copy log (clipboard blocked)"])
    );
    return;
  }
  // Fallback
  downloadTextFile("knight-commander-log.txt", text);
  setLog((prev) => [...prev, "📄 Downloaded log (clipboard unavailable)"]);
}

function downloadLog() {
  const header = [
    `Knight Commander — ${APP_VERSION}`,
    `SavedAt: ${new Date().toLocaleString()}`,
    `Turn: ${turnNumber}`,
    "",
  ].join("\n");
  downloadTextFile(`knight-commander-log-${turnNumber}.txt`, header + log.join("\n"));
}

// Hydrate save metadata (do not auto-load into the match; player chooses from the start menu)
useEffect(() => {
  const savedAuto = safeReadSave(AUTOSAVE_KEY);
  const savedManual = safeReadSave(MANUAL_SAVE_KEY);

  if (savedAuto?.savedAt) setLastAutoSavedAt(savedAuto.savedAt);
  if (savedManual?.savedAt) setLastManualSavedAt(savedManual.savedAt);

  setHasHydrated(true);
}, []);


// Auto-save on any meaningful change (debounced)
useEffect(() => {
  if (!hasHydrated) return;
  if (screen !== "GAME") return;
  if (autoSaveTimer.current) window.clearTimeout(autoSaveTimer.current);
  autoSaveTimer.current = window.setTimeout(() => {
    try {
      writeSave(buildPersistedState(), { silent: true }, AUTOSAVE_KEY);
    } catch {
      // ignore quota errors etc.
    }
  }, 250);
  return () => {
    if (autoSaveTimer.current) window.clearTimeout(autoSaveTimer.current);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [
  hasHydrated,
  screen,
  loadouts,
  knights,
  turnNumber,
  phase,
  revealLockedOrders,
  plans,
  selectedTargetCell,
  inputs,
  log,
  autoRoll,
  rangeInches,
  loadoutLocked,
  weaponTargets,
]);

  const weaponList = useMemo(() => Object.values(CORE_WEAPONS), []);

  const p1TargetId = selectedTargetCell.P1;
  const p1TargetCell = p1TargetId ? knights.P2.grid.cells.find(c => c.id === p1TargetId) : null;
  const p1TargetLabel = p1TargetCell ? cellComponentLabel(knights.P2.grid, p1TargetCell) : null;

  const p2TargetId = selectedTargetCell.P2;
  const p2TargetCell = p2TargetId ? knights.P1.grid.cells.find(c => c.id === p2TargetId) : null;
  const p2TargetLabel = p2TargetCell ? cellComponentLabel(knights.P1.grid, p2TargetCell) : null;

const DEFAULT_TARGET_CELL_ID = useMemo(() => {
  // Default to C4 if present, otherwise fall back to first existing cell id.
  const preferred = baseGrids.P2.cells.find((c) => c.id === "C4");
  return (preferred ?? baseGrids.P2.cells[0])?.id ?? "C4";
}, [baseGrids]);

const issuesByPlayer: Record<PlayerId, string[]> = useMemo(() => {
  return {
    P1: validatePlan(plans.P1, {
      maxActionPoints: knights.P1.maxActionPoints,
      canRotateIonShields: knights.P1.canRotateIonShields,
    }).map((i) => i.message),
    P2: validatePlan(plans.P2, {
      maxActionPoints: knights.P2.maxActionPoints,
      canRotateIonShields: knights.P2.canRotateIonShields,
    }).map((i) => i.message),
  };
}, [plans, knights]);

function retargetPlayerInputs(player: PlayerId, newTargetCellId: string) {
  // Keep any existing planned attack/charge inputs aligned with the selected target.
  setInputs((prev) => {
    const cur = prev[player];
    const patch: any = { ...cur };

    const attackKeys: ("SNAP_ATTACK" | "STANDARD_ATTACK" | "AIMED_ATTACK")[] = ["SNAP_ATTACK", "STANDARD_ATTACK", "AIMED_ATTACK"];
    for (const k of attackKeys) {
      if (patch[k]) patch[k] = { ...patch[k], targetCellId: newTargetCellId };
    }
    if (patch.CHARGE) {
      patch.CHARGE = {
        ...patch.CHARGE,
        meleeAttack: { ...patch.CHARGE.meleeAttack, targetCellId: newTargetCellId },
      };
    }
    return { ...prev, [player]: patch };
  });
}

function ensureDefaultsForAction(player: PlayerId, action: CoreAction) {
  // If the action is selected but no inputs are set yet, initialize sensible defaults so the step actually executes.
  const defaultTarget = selectedTargetCell[player] ?? DEFAULT_TARGET_CELL_ID;
  const meleeDefault = weaponList.find((w) => w.scatter === false) ?? weaponList[0];

  setInputs((prev) => {
    const cur = prev[player];

    if (action === "SNAP_ATTACK" || action === "STANDARD_ATTACK" || action === "AIMED_ATTACK") {
      if (cur[action]) return prev;
      return {
        ...prev,
        [player]: {
          ...cur,
          [action]: {
            weapon: weaponList[0],
            targetCellId: defaultTarget,
            dice: {},
          },
        },
      };
    }

    if (action === "ADVANCE") {
      if (cur.ADVANCE) return prev;
      return { ...prev, [player]: { ...cur, ADVANCE: { distanceInches: QUESTORIS_CHASSIS.movement.advanceInches } } };
    }

    if (action === "RUN") {
      if (cur.RUN) return prev;
      return { ...prev, [player]: { ...cur, RUN: { distanceInches: 0 } } };
    }

    if (action === "ROTATE_ION_SHIELDS") {
      if (cur.ROTATE_ION_SHIELDS) return prev;
      return { ...prev, [player]: { ...cur, ROTATE_ION_SHIELDS: {} } };
    }

    if (action === "CHARGE") {
      if (cur.CHARGE) return prev;
      return {
        ...prev,
        [player]: {
          ...cur,
          CHARGE: {
            move: { distanceInches: QUESTORIS_CHASSIS.movement.chargeInches },
            meleeAttack: {
              weapon: meleeDefault,
              targetCellId: defaultTarget,
              dice: {},
            },
          },
        },
      };
    }

    return prev;
  });
}

  
function startFreshGame(opts?: { mapId?: MapId; p2Name?: string; p2IsAi?: boolean }) {
  // Reset match state, but do NOT delete existing saves.
  setLoadoutLocked(false);
  setWeaponTargets({ P1: {}, P2: {} });

  const p2Loadout = opts?.p2IsAi ? randomQuestorisLoadout() : DEFAULT_LOADOUT;
  setLoadouts({ P1: DEFAULT_LOADOUT, P2: p2Loadout });
  setChassisId({ P1: QUESTORIS_CHASSIS.id, P2: QUESTORIS_CHASSIS.id });

  setKnights({
    P1: makeKnight(QUESTORIS_CHASSIS.id, "P1 Knight", DEFAULT_LOADOUT),
    P2: makeKnight(QUESTORIS_CHASSIS.id, (opts?.p2Name ?? "P2 Knight"), p2Loadout),
  });
  setPlans({ P1: { actions: [] }, P2: { actions: [] } });
  setInputs({ P1: {}, P2: {} });
  setLog([]);
  setSelectedTargetCell({ P1: null, P2: null });
  setRevealLockedOrders(false);
  setPhase("P1_ORDERS");
  setTurnNumber(1);

  const spawns = pickRandomSpawnPositions();
  const startFacings = faceEachOther(spawns);

  setPositions(spawns);
  setFacings(startFacings);
  setTurnStart({ turnNumber: 1, positions: spawns, facings: startFacings });

  setMapId(opts?.mapId ?? pickRandomMapId());
  setMoveDestinations({ P1: { ADVANCE: null, RUN: null, CHARGE: null }, P2: { ADVANCE: null, RUN: null, CHARGE: null } });
  setMoveEndFacings({ P1: { ADVANCE: null, RUN: null, CHARGE: null }, P2: { ADVANCE: null, RUN: null, CHARGE: null } });
  setActiveMoveMode({ P1: "ADVANCE", P2: "ADVANCE" });
  setGameOver(false);
}

function resetForNewGame(opts?: { mapId?: MapId; p2Name?: string; p2IsAi?: boolean }) {
    try { localStorage.removeItem(AUTOSAVE_KEY); } catch {}
    try { localStorage.removeItem(MANUAL_SAVE_KEY); } catch {}
    setLastAutoSavedAt(null);
    setLastManualSavedAt(null);

    setLoadoutLocked(false);
    setWeaponTargets({ P1: {}, P2: {} });

    const isAi = opts?.p2IsAi ?? (gameMode === "VS_AI");
    const p2Name = opts?.p2Name ?? (isAi ? "AI Knight" : "P2 Knight");
    const p2Loadout = isAi ? randomQuestorisLoadout() : DEFAULT_LOADOUT;

    setLoadouts({ P1: DEFAULT_LOADOUT, P2: p2Loadout });
    setChassisId({ P1: QUESTORIS_CHASSIS.id, P2: QUESTORIS_CHASSIS.id });

    setKnights({
      P1: makeKnight(QUESTORIS_CHASSIS.id, "P1 Knight", DEFAULT_LOADOUT),
      P2: makeKnight(QUESTORIS_CHASSIS.id, p2Name, p2Loadout),
    });
    setPlans({ P1: { actions: [] }, P2: { actions: [] } });
    setInputs({ P1: {}, P2: {} });
    setLog([]);
    setSelectedTargetCell({ P1: null, P2: null });
    setRevealLockedOrders(false);
    setPhase("P1_ORDERS");
    setTurnNumber(1);

    const spawns = pickRandomSpawnPositions();
    const startFacings = faceEachOther(spawns);

    setPositions(spawns);
    setFacings(startFacings);
    setTurnStart({ turnNumber: 1, positions: spawns, facings: startFacings });

    setMapId(opts?.mapId ?? pickRandomMapId());
    setMoveDestinations({ P1: { ADVANCE: null, RUN: null, CHARGE: null }, P2: { ADVANCE: null, RUN: null, CHARGE: null } });
    setMoveEndFacings({ P1: { ADVANCE: null, RUN: null, CHARGE: null }, P2: { ADVANCE: null, RUN: null, CHARGE: null } });
    setActiveMoveMode({ P1: "ADVANCE", P2: "ADVANCE" });
    setGameOver(false);
  }

  function apSpent(player: PlayerId) {
    return plans[player].actions.reduce((sum, a) => sum + CORE_ACTION_COST[a], 0);
  }

  function toggleAction(player: PlayerId, action: CoreAction) {
  setPlans((prev) => {
    const already = prev[player].actions.includes(action);
    const nextActions = already ? prev[player].actions.filter((a) => a !== action) : [...prev[player].actions, action];
    return { ...prev, [player]: { actions: nextActions } };
  });

  // When enabling an action, initialize default inputs so the initiative step executes without extra clicks.
  // When disabling, we keep any existing inputs (so re-enabling preserves prior settings).
  setTimeout(() => {
    setPlans((prev) => {
      const enabled = prev[player].actions.includes(action);
      if (enabled) ensureDefaultsForAction(player, action);
      return prev;
    });
  }, 0);
}

function toggleActionEnabled(player: PlayerId, action: CoreAction, enabled: boolean) {
  setPlans((prev) => ({ ...prev, [player]: setPlanActionEnabled(prev[player], action, enabled) }));

  if (enabled) {
    setTimeout(() => ensureDefaultsForAction(player, action), 0);
  }
}



  function setAttackInput(
    player: PlayerId,
    action: "SNAP_ATTACK" | "STANDARD_ATTACK" | "AIMED_ATTACK",
    patch: Partial<{ targetCellId: string; dice: DiceOverrides }>
  ) {
    setInputs((prev) => {
      const prevAction = prev[player][action];
      const prevDice = prevAction?.dice ?? {};
      const nextDice = patch.dice ? { ...prevDice, ...patch.dice } : prevDice;

      return {
        ...prev,
        [player]: {
          ...prev[player],
          [action]: {
            targetCellId: prevAction?.targetCellId ?? (selectedTargetCell[player] ?? DEFAULT_TARGET_CELL_ID),
            dice: nextDice,
            ...patch,
            ...(patch.dice ? { dice: nextDice } : {}),
          },
        },
      };
    });
  }

  function setChargeInput(
    player: PlayerId,
    patch: Partial<{ moveDistance: number; meleeWeapon: WeaponProfile; targetCellId: string; dice: DiceOverrides }>
  ) {
    setInputs((prev) => {
      const meleeDefault = weaponList.find(isMeleeWeapon)!;
      const existing = prev[player].CHARGE;

      const move = patch.moveDistance !== undefined
        ? { distanceInches: patch.moveDistance }
        : (existing?.move ?? { distanceInches: QUESTORIS_CHASSIS.movement.chargeInches });

      const prevDice = existing?.meleeAttack.dice ?? {};
      const nextDice = patch.dice ? { ...prevDice, ...patch.dice } : prevDice;

      const meleeAttack = {
        weapon: patch.meleeWeapon ?? existing?.meleeAttack.weapon ?? meleeDefault,
        targetCellId: patch.targetCellId ?? existing?.meleeAttack.targetCellId ?? (selectedTargetCell[player] ?? DEFAULT_TARGET_CELL_ID),
        dice: nextDice,
      };

      return {
        ...prev,
        [player]: {
          ...prev[player],
          CHARGE: { move, meleeAttack },
        },
      };
    });
  }

  function setRunDistance(player: PlayerId, dist: number) {
    setInputs((prev) => ({
      ...prev,
      [player]: { ...prev[player], RUN: { distanceInches: dist } },
    }));
  }

  function validateBothPlans(): string[] {
    const issues: string[] = [];
    (["P1", "P2"] as PlayerId[]).forEach((p) => {
      const res = validatePlan(plans[p], {
        maxActionPoints: knights[p].maxActionPoints,
        canRotateIonShields: knights[p].canRotateIonShields,
      });
      res.forEach((i) => issues.push(`[${p}] ${i.message}`));
    });
    return issues;
  }

  function executeTurnUI() {
  const positionsBefore: Record<PlayerId, Vec2> = { P1: { ...positions.P1 }, P2: { ...positions.P2 } };
  const prevSnap: Record<PlayerId, Map<string, { armorPoints: number; criticallyDamaged: boolean }>> = {
    P1: new Map(knights.P1.grid.cells.map((c) => [c.id, { armorPoints: c.armorPoints, criticallyDamaged: c.criticallyDamaged }])),
    P2: new Map(knights.P2.grid.cells.map((c) => [c.id, { armorPoints: c.armorPoints, criticallyDamaged: c.criticallyDamaged }])),
  };

  const issues = validateBothPlans();
  if (issues.length) {
    setLog((prev) => [...prev, `❌ Cannot execute turn ${turnNumber}:`, ...issues]);
    return;
  }

  const game: GameState = {
    grid: baseGrids.P1,
    knights: { P1: knights.P1, P2: knights.P2 },
    turnNumber,
    positions: { ...positions },
    facings: { ...facings },
    terrain: [...terrain],
    chassisId: { ...chassisId },
  };

  // Auto-range is measured from the current map positions at each step.
  // `rangeInches` remains as a fallback for older saves.
  const inputsWithDest: TurnInputs = {
    P1: { ...inputs.P1 },
    P2: { ...inputs.P2 },
  };

  // Ensure the Rotate Ion Shields action has an input object (no parameters).
  (['P1', 'P2'] as PlayerId[]).forEach((p) => {
    if (plans[p].actions.includes("ROTATE_ION_SHIELDS")) {
      inputsWithDest[p].ROTATE_ION_SHIELDS = inputsWithDest[p].ROTATE_ION_SHIELDS ?? {};
    }
  });
  (['P1', 'P2'] as PlayerId[]).forEach((p) => {
    const advDest = moveDestinations[p].ADVANCE ?? undefined;
    const runDest = moveDestinations[p].RUN ?? undefined;

    const advFacing = moveEndFacings[p].ADVANCE ?? undefined;
    const runFacing = moveEndFacings[p].RUN ?? undefined;

    if (inputsWithDest[p].ADVANCE) inputsWithDest[p].ADVANCE = { ...inputsWithDest[p].ADVANCE, dest: advDest, endFacingDeg: advFacing };
    if (inputsWithDest[p].RUN) inputsWithDest[p].RUN = { ...inputsWithDest[p].RUN, dest: runDest, endFacingDeg: runFacing };
  });

  const events = executeTurnMutating(game, plans, inputsWithDest, rangeInches, weaponTargets);

  // Defensive guard: never let invalid engine movement (NaN/Infinity) poison the UI.
  (['P1', 'P2'] as PlayerId[]).forEach((p) => {
    const pos = game.positions?.[p];
    const facing = game.facings?.[p];
    const badPos = !pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y);
    const badFacing = typeof facing !== 'number' || !Number.isFinite(facing);
    if (badPos) {
      game.positions[p] = { ...positionsBefore[p] };
      setLog((prev) => [...prev, `❌ Engine produced invalid position for ${p}. Reverted to last valid position.`]);
    }
    if (badFacing) {
      game.facings[p] = facings[p];
      setLog((prev) => [...prev, `❌ Engine produced invalid facing for ${p}. Reverted to last valid facing.`]);
    }
  });

  // Persist mutated game state back into React state (clone cells to avoid mutation surprises).
  setKnights({
    P1: {
      ...game.knights.P1,
      grid: { ...game.knights.P1.grid, cells: game.knights.P1.grid.cells.map((c) => ({ ...c })) },
    },
    P2: {
      ...game.knights.P2,
      grid: { ...game.knights.P2.grid, cells: game.knights.P2.grid.cells.map((c) => ({ ...c })) },
    },

  });

  // Persist map positions (movement updates range for later steps).
  const segs: Record<PlayerId, { from: Vec2; to: Vec2 } | null> = { P1: null, P2: null };
  (['P1', 'P2'] as PlayerId[]).forEach((p) => {
    const from = positionsBefore[p];
    const to = game.positions[p];
    if (from.x !== to.x || from.y !== to.y) segs[p] = { from, to };
  });
  setLastTurnMoveSegments(segs);

  // Persist engine-updated facings (movement steps auto-face for later steps).
  setFacings({ ...game.facings });

  setPositions({ ...game.positions });

  const hlNext: Record<PlayerId, Record<string, "damaged" | "destroyed">> = { P1: {}, P2: {} };
  (["P1", "P2"] as PlayerId[]).forEach((p) => {
    const prev = prevSnap[p];
    for (const c of game.knights[p].grid.cells) {
      const before = prev.get(c.id);
      if (!before) continue;
      const apDropped = c.armorPoints < before.armorPoints;
      const becameCrit = c.criticallyDamaged && !before.criticallyDamaged;
      if (becameCrit) hlNext[p][c.id] = "destroyed";
      else if (apDropped) hlNext[p][c.id] = "damaged";
    }
  });
  setLastTurnHighlights(hlNext);
  setHighlightToken((t) => t + 1);
  setSummaryFocus("P1");
  setSummaryMode(isNarrow ? "FOCUS" : "SPLIT");


  const newLog: string[] = [];
  newLog.push(`=== TURN ${turnNumber} ===`);

  let anyDestroyed = false;

  for (const e of events) {
    if (e.kind === "STEP") {
      const who = e.order.length ? e.order.join(" then ") : "N/A";
      newLog.push(`[${e.stepNumber}]: ${e.action} (range ${Math.round(e.rangeInches)}\") -> ${who}`);
      continue;
    }

    if (e.kind === "ROTATE") {
      const parts = e.players.map((p) => `${p}: ROTATE_ION_SHIELDS (+1 Armour Saves this turn)`);
      newLog.push(parts.join(" | "));
      continue;
    }

    if (e.kind === "MOVE") {
      if (e.action === "RUN" && (e as any).dice) {
        const d = (e as any).dice as [number, number];
        const rolled = (e as any).distanceRolled ?? d[0] + d[1];
        newLog.push(
          `${e.player}: RUN rolled 2d6 (${d[0]}+${d[1]}=${rolled}) -> moved ${e.distanceAfterPenalty}" (after penalties)`
        );
      } else {
        newLog.push(`${e.player}: ${e.action} moved ${e.distanceAfterPenalty}" (after penalties)`);
      }
      continue;
    }

    if (e.kind === "ATTACK") {
      const o = e.outcome as any;
      const scatter = o.scatter
        ? (() => {
            const r = o.scatter.redRaw !== undefined ? `${o.scatter.redRaw}→${o.scatter.red}` : `${o.scatter.red}`;
            return ` scatter: ${r} ${o.scatter.horizSymbol}, ${o.scatter.blue} ${o.scatter.vertSymbol}`;
          })()
        : "";
      const tf =
        o.targetCellId || o.finalCellId !== undefined
          ? ` target ${o.targetCellId ?? "?"} -> final ${o.finalCellId ?? "OFF"}`
          : "";
      const w = (e as any).weapon ? ` [${(e as any).weapon}]` : "";

      const arcText = o.incomingArc ? ` (hit arc: ${arcShortLabel(o.incomingArc as FacingArc)})` : "";

      const saveMeta = (() => {
        const parts: string[] = [];
        if (o.ionSave?.attempted) {
          parts.push(`ion ${o.ionSave.die} needed ${o.ionSave.needed}${o.ionSave.success ? " PASS" : " FAIL"}`);
        }
        if (o.armourSave) {
          const mods: string[] = [];
          if (o.armourSave.mods?.cover) mods.push("Cover");
          if (typeof o.armourSave.mods?.ap === "number") mods.push(`AP${o.armourSave.mods.ap}`);
          if (typeof o.armourSave.mods?.rotate === "number" && o.armourSave.mods.rotate !== 0) {
            mods.push(`Rotate+${o.armourSave.mods.rotate}`);
          }
          const modText = mods.length ? ` [${mods.join("+")}]` : "";
          parts.push(`armour ${o.armourSave.die}→${o.armourSave.roll} needed ${o.armourSave.needed}${modText}`);
        }
        return parts.length ? ` (${parts.join("; ")})` : "";
      })();

      if (o.kind === "MISS") newLog.push(`${e.player}: ${e.action}${w} -> MISS (${o.reason})${tf}${scatter}${arcText}`);
      if (o.kind === "SAVED") {
        const by = o.savedBy === "ION" ? " (Ion)" : "";
        newLog.push(`${e.player}: ${e.action}${w} -> SAVED${by} at ${o.cellId}${saveMeta}${tf}${scatter}${arcText}`);
      }
      if (o.kind === "HIT")
        newLog.push(
          `${e.player}: ${e.action}${w} -> HIT ${o.cellId}${saveMeta} dmg ${o.damage}${o.destroyed ? " DESTROYED" : ""}${tf}${scatter}${arcText}`
        );
      continue;
    }

    if (e.kind === "SKIP") {
      newLog.push(`${e.player}: ${e.action} [${e.weapon}] -> SKIP (${e.reason})`);
      continue;
    }

    if (e.kind === "DESTROYED") {
      newLog.push(`💥 ${e.player} destroyed`);
      anyDestroyed = true;
      continue;
    }
  }

  setLog((prev) => [...prev, ...newLog]);
  setLastTurnLog(newLog);
  setShowSummaryLog(false);

  // As requested: loadouts unlock after a player is destroyed (for next game / reset).
  if (anyDestroyed) {
    setLoadoutLocked(false);
    setGameOver(true);
  }

  // Prepare next turn
  setTurnNumber((t) => t + 1);
  setPlans({ P1: { actions: [] }, P2: { actions: [] } });
  setInputs({ P1: {}, P2: {} });
  setSelectedTargetCell({ P1: null, P2: null });
  setRevealLockedOrders(false);
  setPhase("POST_TURN_SUMMARY");
}

function roundInches(n: number): number {
  return Math.round(n);
}

function distInches(a: Vec2, b: Vec2): number {
  return roundInches(Math.hypot(a.x - b.x, a.y - b.y));
}

function clampInchesToBoard(v: number): number {
  // 48" x 48" game space
  return Math.max(0, Math.min(48, v));
}

function clampPointToBoard(p: Vec2): Vec2 {
  return {
    x: clampInchesToBoard(p.x),
    y: clampInchesToBoard(p.y),
  };
}

function stepToward(from: Vec2, to: Vec2, distance: number): Vec2 {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const d = Math.hypot(dx, dy);
  if (d <= 1e-6) return { ...from };
  const t = Math.min(1, distance / d);
  return {
    x: roundInches(clampInchesToBoard(from.x + dx * t)),
    y: roundInches(clampInchesToBoard(from.y + dy * t)),
  };
}

// AI "smart" target picker: slightly biases toward disabling high-leverage systems.
// NOTE: this is used for *AI outgoing attacks*.
function pickAiTargetCellId(defender: KnightState): string {
  const alive = defender.grid.cells.filter((c) => !c.criticallyDamaged && c.armorPoints > 0);
  if (!alive.length) return DEFAULT_TARGET_CELL_ID;

  // If the Tilting Shield is still operational, destroying it removes BOTH Rotate Ion Shields and the Ion Save.
  // In the core grid, the Tilting Shield location is C3.
  const tiltingShieldActive = !!defender.canRotateIonShields;
  const value = (c: any): number => {
    if (tiltingShieldActive && c.id === "C3") return 2.0; // high-leverage critical
    return 1.0;
  };

  alive.sort((a, b) => a.armorPoints / value(a) - b.armorPoints / value(b));
  return alive[0].id;
}

// Worst-case / vulnerability picker (used for incoming-fire estimation).
function pickMostVulnerableCellId(defender: KnightState): string {
  const alive = defender.grid.cells.filter((c) => !c.criticallyDamaged && c.armorPoints > 0);
  if (!alive.length) return DEFAULT_TARGET_CELL_ID;
  alive.sort((a, b) => a.armorPoints - b.armorPoints);
  return alive[0].id;
}

function effectiveRangedRange(attacker: KnightState): number {
  // Weighted median of weapon ranges, weighted by average damage.
  const items: Array<{ range: number; weight: number }> = [];
  for (const w of attacker.weapons) {
    if (w.disabled) continue;
    const prof = resolveWeaponProfileForEquippedName(w.name, 48);
    if (!prof || prof.scatter !== true) continue;
    const r = prof.rangeInches ?? 0;
    if (r <= 0) continue;
    // Weighted by average damage; profile helper is the canonical one.
    let wt = Math.max(0.1, avgDamageForProfile(prof));
    if (weaponHasAbility(prof, "INDIRECT")) wt *= 0.85; // slightly devalue indirect (can be forced to Snap when blocked)
    items.push({ range: r, weight: wt });
  }
  if (!items.length) return 0;
  items.sort((a, b) => a.range - b.range);
  const totalW = items.reduce((s, it) => s + it.weight, 0);
  let cum = 0;
  for (const it of items) {
    cum += it.weight;
    if (cum >= totalW / 2) return it.range;
  }
  return items[items.length - 1].range;
}

function maxMeleeReach(attacker: KnightState): number {
  let reach = 0;
  for (const w of attacker.weapons) {
    if (w.disabled) continue;
    const prof = resolveWeaponProfileForEquippedName(w.name, 1);
    if (!prof) continue;
    if (prof.scatter === false) reach = Math.max(reach, prof.rangeInches);
  }
  return reach;
}

function hasRangedShotFrom(attacker: KnightState, attackerPos: Vec2, attackerFacingDeg: number, defenderPos: Vec2): boolean {
  const los = computeLosEffects(attackerPos, defenderPos, terrain);
  const r = distInches(attackerPos, defenderPos);
  for (const w of attacker.weapons) {
    if (w.disabled) continue;
    const prof = resolveWeaponProfileForEquippedName(w.name, r);
    if (!prof) continue;
    if (prof.scatter !== true) continue; // melee weapons have scatter=false
    if (r > prof.rangeInches) continue;
    if (los.blocked && !weaponHasAbility(prof, "INDIRECT")) continue;
    if (!canFireAtTarget({ attackerPos, attackerFacingDeg, targetPos: defenderPos, mount: w.mount })) continue;
    return true;
  }
  return false;
}

function avgDamageForProfile(p: WeaponProfile): number {
  if (p.damage.type === "flat") return p.damage.value;
  // Dice damage averages
  if (p.damage.dice === "D3") return 2;
  return 3.5;
}


function intCeil(n: number): number {
  return Math.trunc(n) === n ? n : n > 0 ? Math.trunc(n) + 1 : Math.trunc(n);
}

function armourSaveChance(effectiveAp: number, saveBonus: number): number {
  // Save succeeds if d6 + effectiveAp + saveBonus >= 5
  // saveBonus can include cover (1) and temporary effects like Rotate Ion Shields (+1).
  const threshold = 5 - effectiveAp - saveBonus; // need d6 >= threshold
  if (threshold <= 1) return 1;
  if (threshold >= 7) return 0;
  const successes = 7 - intCeil(threshold);
  return Math.max(0, Math.min(6, successes)) / 6;
}

type AttackKind = "SNAP" | "STANDARD" | "AIMED";

function horizShift(kind: AttackKind, die: number): number {
  switch (kind) {
    case "SNAP":
      return die <= 2 ? -1 : die <= 4 ? 0 : 1;
    case "STANDARD":
      if (die === 1) return -1;
      if (die === 6) return 1;
      return 0;
    case "AIMED":
      return 0;
  }
}

function vertShift(kind: AttackKind, die: number): number {
  switch (kind) {
    case "SNAP":
      if (die === 1) return -1;
      if (die === 6) return 1;
      return 0;
    case "STANDARD":
      return die <= 2 ? -1 : die <= 4 ? 0 : 1;
    case "AIMED":
      if (die === 1) return -1;
      if (die === 6) return 1;
      return 0;
  }
}

function expectedWeaponDamage(args: {
  profile: WeaponProfile;
  attackKind: AttackKind;
  targetCellId: string;
  attackerPos: Vec2;
  attackerFacingDeg: number;
  attackerMount: any;
  defender: KnightState;
  defenderPos: Vec2;
  defenderFacingDeg: number;
  defenderArmourSaveBonus?: number;
  targetObscured: boolean;
}): number {
    const {
      profile,
      attackKind,
      targetCellId,
      attackerPos,
      attackerFacingDeg,
      attackerMount,
      defender,
      defenderPos,
      defenderFacingDeg,
      defenderArmourSaveBonus,
      targetObscured,
    } = args;

  const range = distInches(attackerPos, defenderPos);
  if (range > profile.rangeInches) return 0;
  if (!canFireAtTarget({ attackerPos, attackerFacingDeg, targetPos: defenderPos, mount: attackerMount })) return 0;

  const startCell = defender.grid.cells.find((c) => c.id === targetCellId);
  if (!startCell || startCell.armorPoints <= 0) return 0;

  const incoming = relativeArc(defenderPos, defenderFacingDeg, attackerPos);

  const horizMod = incoming === "LEFT" ? -1 : incoming === "RIGHT" ? 1 : 0;
  const dmgBonus = incoming === "REAR" ? 1 : incoming === "LEFT" || incoming === "RIGHT" ? 1 : 0;
  const apBonus = incoming === "REAR" ? -1 : 0;

  const coverBonus = targetObscured ? 1 : 0;
  const avgDmg = Math.max(0, avgDamageForProfile(profile) + dmgBonus);

  // Ion save always protects the FRONT arc if enabled (Tilting Shield not destroyed).
  const ionApplies = !!profile.scatter && defender.canRotateIonShields && incoming === "FRONT";
  const pIon = ionApplies ? 0.5 : 0;

  const rotateBonus = defenderArmourSaveBonus ?? 0;

  if (!profile.scatter) {
    const pSave = armourSaveChance((profile.ap ?? 0) + apBonus, coverBonus + rotateBonus);
    return (1 - pSave) * avgDmg;
  }

  let total = 0;
  for (let redRaw = 1; redRaw <= 6; redRaw++) {
    for (let blue = 1; blue <= 6; blue++) {
      const red = Math.max(1, Math.min(6, redRaw + horizMod));
      const dx = horizShift(attackKind, red);
      const dy = vertShift(attackKind, blue);
      const hitX = startCell.x + dx;
      const hitY = startCell.y + dy;
      const hit = defender.grid.cells.find((c) => c.x === hitX && c.y === hitY);
      if (!hit || hit.armorPoints <= 0) continue;

      const pSave = armourSaveChance((profile.ap ?? 0) + apBonus, coverBonus + rotateBonus);
      const pFail = (1 - pIon) * (1 - pSave);
      total += (1 / 36) * pFail * avgDmg;
    }
  }

  return total;
}

function expectedRangedVolleyDamage(args: {
  attackKind: AttackKind;
  attacker: KnightState;
  attackerPos: Vec2;
  attackerFacingDeg: number;
  defender: KnightState;
  defenderPos: Vec2;
  defenderFacingDeg: number;
  defenderArmourSaveBonus?: number;
  targetCellId: string;
}): number {
  const { attackKind, attacker, attackerPos, attackerFacingDeg, defender, defenderPos, defenderFacingDeg, defenderArmourSaveBonus, targetCellId } = args;
  const los = computeLosEffects(attackerPos, defenderPos, terrain);

  let total = 0;
  const r = distInches(attackerPos, defenderPos);

  for (const w of attacker.weapons) {
    if (w.disabled) continue;
    const profile = resolveWeaponProfileForEquippedName(w.name, r);
    if (!profile?.scatter) continue; // ranged only
    if (r > profile.rangeInches) continue;

    const indirect = weaponHasAbility(profile, "INDIRECT");
    if (los.blocked && !indirect) continue;
    const kindForWeapon: AttackKind = los.blocked && indirect ? "SNAP" : attackKind;

    total += expectedWeaponDamage({
      profile,
      attackKind: kindForWeapon,
      targetCellId,
      attackerPos,
      attackerFacingDeg,
      attackerMount: w.mount,
      defender,
      defenderPos,
      defenderFacingDeg,
      defenderArmourSaveBonus,
      targetObscured: los.obscured,
    });
  }

  return total;
}

function bestMeleeChoice(args: {
  attacker: KnightState;
  attackerPos: Vec2;
  attackerFacingDeg: number;
  defender: KnightState;
  defenderPos: Vec2;
  defenderFacingDeg: number;
  defenderArmourSaveBonus?: number;
  targetCellId: string;
}): { weapon: string; expected: number } | null {
  const { attacker, attackerPos, attackerFacingDeg, defender, defenderPos, defenderFacingDeg, defenderArmourSaveBonus, targetCellId } = args;

  const range = distInches(attackerPos, defenderPos);
  const los = computeLosEffects(attackerPos, defenderPos, terrain);
  if (los.blocked || los.crossesAnyCover) return null;

  let best: { weapon: string; expected: number } | null = null;

  for (const w of attacker.weapons) {
    if (w.disabled) continue;
    const profile = resolveWeaponProfileForEquippedName(w.name, range);
    if (!profile || profile.scatter) continue; // melee only
    if (!canFireAtTarget({ attackerPos, attackerFacingDeg, targetPos: defenderPos, mount: w.mount })) continue;

    const expected = expectedWeaponDamage({
      profile,
      attackKind: "STANDARD",
      targetCellId,
      attackerPos,
      attackerFacingDeg,
      attackerMount: w.mount,
      defender,
      defenderPos,
      defenderFacingDeg,
      defenderArmourSaveBonus,
      targetObscured: false,
    });

    if (!best || expected > best.expected) best = { weapon: w.name, expected };
  }

  return best;
}


function generateAiOrdersForP2() {
  // VS AI parity: plan from the turn-start snapshot so we never peek at human-plotted orders.
  const snap = turnStart;

  const ai: PlayerId = "P2";
  const enemy: PlayerId = "P1";

  const aiKnight = knights[ai];
  const enemyKnight = knights[enemy];

  const aiPos0 = snap.positions[ai];
  const enemyPos0 = snap.positions[enemy];
  const aiFacing0 = snap.facings[ai];
  const enemyFacing0 = snap.facings[enemy];

  // Targeting: use the AI's own cell picker, and keep weapon target memory in sync.
  const targetCellId = pickAiTargetCellId(enemyKnight);
  setWeaponTargets((prev) => ({
    ...prev,
    [ai]: {
      ...prev[ai],
      ...Object.fromEntries((aiKnight.weapons ?? []).map((w) => [weaponTargetKeyForMountUi(w.mount as WeaponMount), targetCellId])),
    },
  }));

  // --- Local helpers (movement simulation uses the same rules as the engine) ---
  const boardSize = 48;

  const snapToWhole = (p: Vec2): Vec2 => ({ x: Math.round(p.x), y: Math.round(p.y) });

  const isBlocked = (p: Vec2): boolean => {
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    if (x < 0 || y < 0 || x > boardSize || y > boardSize) return true;
    for (const t of terrain) {
      for (const r of t.rects) {
        // match execute-turn.ts pathfinding semantics
        if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return true;
      }
    }
    return false;
  };

  const nudgeToUnblocked = (p: Vec2, maxRadius: number = 8): Vec2 => {
    const base = snapToWhole(clampPointToBoard(p));
    if (!isBlocked(base)) return base;
    for (let rad = 1; rad <= maxRadius; rad++) {
      // ring search (Manhattan + diagonals)
      for (let dx = -rad; dx <= rad; dx++) {
        for (let dy = -rad; dy <= rad; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
          const cand: Vec2 = {
            x: clampInchesToBoard(base.x + dx),
            y: clampInchesToBoard(base.y + dy),
          };
          if (!isBlocked(cand)) return cand;
        }
      }
    }
    return base; // give up; engine will clamp movement if needed
  };

  const findPathManhattan = (start: Vec2, goal: Vec2): Vec2[] | null => {
    const s0 = snapToWhole(start);
    const g0 = snapToWhole(goal);
    if (isBlocked(s0) || isBlocked(g0)) return null;
    if (s0.x === g0.x && s0.y === g0.y) return [s0];

    const key = (x: number, y: number) => `${x},${y}`;
    const q: Array<{ x: number; y: number }> = [{ x: s0.x, y: s0.y }];
    const prev = new Map<string, string>();
    const seen = new Set<string>([key(s0.x, s0.y)]);

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
        if (isBlocked({ x: nx, y: ny })) continue;
        prev.set(k, key(cur.x, cur.y));
        if (nx === g0.x && ny === g0.y) {
          const out: Vec2[] = [{ x: g0.x, y: g0.y }];
          let back = key(g0.x, g0.y);
          while (prev.has(back)) {
            const p = prev.get(back)!;
            const [px, py] = p.split(",").map(Number);
            out.push({ x: px, y: py });
            back = p;
            if (px === s0.x && py === s0.y) break;
          }
          out.reverse();
          return out;
        }
        seen.add(k);
        q.push({ x: nx, y: ny });
      }
    }
    return null;
  };

  const moveAlongWaypoints = (from: Vec2, waypoints: (Vec2 | null | undefined)[], maxDist: number): Vec2 => {
    let remaining = Math.max(0, maxDist);
    let cur: Vec2 = { ...from };

    for (const wp0 of waypoints) {
      if (!wp0) continue;
      const wp = nudgeToUnblocked(wp0);

      const start = snapToWhole(cur);
      const goal = snapToWhole(wp);
      const path = findPathManhattan(start, goal);

      if (path && path.length >= 2) {
        const stepsToGoal = path.length - 1;
        if (remaining >= stepsToGoal) {
          cur = { ...goal };
          remaining -= stepsToGoal;
        } else {
          const idx = Math.max(0, Math.min(stepsToGoal, Math.floor(remaining)));
          cur = { ...path[idx] };
          remaining = 0;
        }
      } else {
        // Fallback: straight-line step (rounded to whole inches) and let terrain stop us by nudging.
        const desired = stepToward(cur, wp, remaining);
        cur = nudgeToUnblocked(desired, 0); // do not spiral here; keep it local
        remaining = 0;
      }

      if (remaining <= 1e-6) break;
    }

    return snapToWhole(cur);
  };

  const facingToward = (from: Vec2, to: Vec2) => bearingDeg(from, to);
  const facingAway = (from: Vec2, to: Vec2) => (bearingDeg(from, to) + 180) % 360;

  const maxRangedRange = (k: KnightState): number => {
    let m = 0;
    for (const w of k.weapons) {
      if (w.disabled) continue;
      // use a large range so profiles resolve; then read max range
      const prof = resolveWeaponProfileForEquippedName(w.name, 48);
      if (!prof) continue;
      if (prof.scatter !== true) continue;
      m = Math.max(m, prof.rangeInches ?? 0);
    }
    return m;
  };

  const aiMaxRange = maxRangedRange(aiKnight);
  const enemyMaxRange = maxRangedRange(enemyKnight);

  // Use a more realistic "effective" range than the raw max (a single stubber shouldn't make us act long-ranged).
  const aiEffRange = effectiveRangedRange(aiKnight) || aiMaxRange;
  const enemyEffRange = effectiveRangedRange(enemyKnight) || enemyMaxRange;

  const aiMeleeReach = maxMeleeReach(aiKnight);
  const enemyMeleeReach = maxMeleeReach(enemyKnight);

  const aiHasMelee = aiMeleeReach > 0;
  const enemyHasMelee = enemyMeleeReach > 0;

  const maxAp = aiKnight.maxActionPoints ?? 7;

  const sumAp = (acts: CoreAction[]) => acts.reduce((n, a) => n + (CORE_ACTION_COST[a] ?? 0), 0);
  const withinAp = (acts: CoreAction[]) => sumAp(acts) <= maxAp;

  const totalArmour = aiKnight.grid.cells.reduce((s, c) => s + Math.max(0, c.armorPoints), 0);
  const maxArmour = aiKnight.grid.cells.reduce((s, c) => s + Math.max(0, c.maxArmorPoints ?? 0), 0);
  const integrity01 = maxArmour > 0 ? totalArmour / maxArmour : 1;

  // Defensive posture should be a "last resort"; otherwise close and fight.
  const defensivePosture = integrity01 < 0.33;

  const enemyArcAtStart = relativeArc(aiPos0, aiFacing0, enemyPos0);

  // Distances (rough expectations) – match engine values.
  const aiChassis = getChassis(chassisId[ai]);
  const movePenalty = aiKnight.movementPenalty ?? 0;
  const advDist = Math.max(0, aiChassis.movement.advanceInches - movePenalty);
  const runDistExp = Math.max(0, 7 - movePenalty); // Run is 2D6 (expected 7)
  const chargeDist = Math.max(0, aiChassis.movement.chargeInches - movePenalty);

  // Candidate type.
  type Candidate = {
    name: string;
    actions: CoreAction[];
    advDest?: Vec2 | null;
    runDest?: Vec2 | null;
    meleeWeapon?: string | null;
    // Filled in by scoring so we always send a sane end-facing to the engine.
    advFacing?: number | null;
    runFacing?: number | null;
    score?: number;
    expectedDamage?: number;
  };

  // Charge is automatic at the Charge step: move up to maxDist toward the enemy via pathing,
  // stopping 1" short (never ending on the enemy point).
  const autoChargeTowardEnemy = (from: Vec2, enemyPos: Vec2, maxDist: number): Vec2 => {
    const start = snapToWhole(from);
    const goal = snapToWhole(enemyPos);
    const maxSteps = Math.max(0, Math.floor(maxDist));
    const path = findPathManhattan(start, goal);
    if (path && path.length >= 1) {
      const stepsToEnemy = Math.max(0, path.length - 1);
      const desiredSteps = Math.min(maxSteps, Math.max(0, stepsToEnemy - 1));
      return { ...path[Math.min(path.length - 1, desiredSteps)] };
    }
    // Fallback: direct step toward (stop 1" short) and nudge around local terrain.
    const d = distInches(from, enemyPos);
    const travel = Math.min(maxDist, Math.max(0, d - 1));
    return nudgeToUnblocked(stepToward(from, enemyPos, travel), 0);
  };

  const scoreCandidate = (c0: Candidate): Candidate => {
    let expected = 0;

    // Start from turn-start state.
    let pos: Vec2 = { ...aiPos0 };
    let facing: number = aiFacing0;

    // Track actual movement so we can punish "stuck" results.
    let movedAdvance = 0;
    let movedRun = 0;

    // Outgoing damage does not assume the opponent will use Rotate Ion Shields this turn.
    const enemyArmourBonusAssumed = 0;

    // If we can shoot immediately, factor it in (and penalize wasted AP if nothing can fire).
    if (c0.actions.includes("SNAP_ATTACK")) {
      const snapExpected = expectedRangedVolleyDamage({
        attackKind: "SNAP",
        attacker: aiKnight,
        attackerPos: pos,
        attackerFacingDeg: facing,
        defender: enemyKnight,
        defenderPos: enemyPos0,
        defenderFacingDeg: enemyFacing0,
        defenderArmourSaveBonus: enemyArmourBonusAssumed,
        targetCellId,
      });
      expected += snapExpected;
      if (snapExpected < 0.05) expected -= 0.22;
    }

    // Advance
    let advFacingUsed: number | null = null;
    if (c0.actions.includes("ADVANCE") && c0.advDest) {
      const before = { ...pos };
      pos = moveAlongWaypoints(pos, [c0.advDest], advDist);
      movedAdvance = distInches(before, pos);
      advFacingUsed = typeof c0.advFacing === "number" && Number.isFinite(c0.advFacing) ? c0.advFacing : facingToward(pos, enemyPos0);
      facing = advFacingUsed;
    }

    // Predicted incoming arc after movement/facing.
    const incomingArcAfterMove = relativeArc(pos, facing, enemyPos0);

    // Rotate Ion Shields: grants +1 to Armour Saves (all directions) for the rest of the turn.
    const armourBonusAfterRotate = c0.actions.includes("ROTATE_ION_SHIELDS") && aiKnight.canRotateIonShields ? 1 : 0;

    // Standard attacks (after rotate)
    if (c0.actions.includes("STANDARD_ATTACK")) {
      const stdExpected = expectedRangedVolleyDamage({
        attackKind: "STANDARD",
        attacker: aiKnight,
        attackerPos: pos,
        attackerFacingDeg: facing,
        defender: enemyKnight,
        defenderPos: enemyPos0,
        defenderFacingDeg: enemyFacing0,
        defenderArmourSaveBonus: enemyArmourBonusAssumed,
        targetCellId,
      });
      expected += stdExpected;
      if (stdExpected < 0.05) expected -= 0.18;
    }

    // Run (engine continues toward ADVANCE dest first, then RUN dest)
    let runFacingUsed: number | null = null;
    if (c0.actions.includes("RUN") && c0.runDest) {
      const before = { ...pos };
      pos = moveAlongWaypoints(pos, [c0.advDest ?? null, c0.runDest], runDistExp);
      movedRun = distInches(before, pos);
      runFacingUsed = typeof c0.runFacing === "number" && Number.isFinite(c0.runFacing) ? c0.runFacing : facingToward(pos, enemyPos0);
      facing = runFacingUsed;
    }

    // Aimed attacks (after movement)
    if (c0.actions.includes("AIMED_ATTACK")) {
      const aimedExpected = expectedRangedVolleyDamage({
        attackKind: "AIMED",
        attacker: aiKnight,
        attackerPos: pos,
        attackerFacingDeg: facing,
        defender: enemyKnight,
        defenderPos: enemyPos0,
        defenderFacingDeg: enemyFacing0,
        defenderArmourSaveBonus: enemyArmourBonusAssumed,
        targetCellId,
      });
      expected += aimedExpected;
      if (aimedExpected < 0.05) expected -= 0.22;
    }

    // Charge: automatic 6" (or chassis charge) toward the enemy at the Charge step.
    if (c0.actions.includes("CHARGE")) {
      const before = { ...pos };
      pos = autoChargeTowardEnemy(pos, enemyPos0, chargeDist);
      // Charge in the engine always ends by facing the enemy.
      const movedCharge = distInches(before, pos);
      if (distInches(pos, enemyPos0) > 1e-6) facing = facingToward(pos, enemyPos0);
      else if (movedCharge > 0.1) facing = facingToward(before, pos);

      const melee = c0.meleeWeapon
        ? bestMeleeChoice({
            attacker: aiKnight,
            attackerPos: pos,
            attackerFacingDeg: facing,
            defender: enemyKnight,
            defenderPos: enemyPos0,
            defenderFacingDeg: enemyFacing0,
            defenderArmourSaveBonus: enemyArmourBonusAssumed,
            targetCellId,
          })
        : null;
      if (melee) expected += melee.expected;

      // If we didn't really move (stuck) treat as a weak plan.
      if (movedCharge < 1) expected -= 0.75;
    }

    // Positional evaluation.
    const dEnd = distInches(pos, enemyPos0);

    // Cover state (from enemy to AI)
    const losEnemyToAi = computeLosEffects(enemyPos0, pos, terrain);
    const hardCoverBonus = losEnemyToAi.blocked ? 1.1 : 0;
    const softCoverBonus = !losEnemyToAi.blocked && losEnemyToAi.obscured ? 0.6 : 0;

    // Exposure: keep the enemy in our FRONT arc whenever possible.
    const incomingToAi = relativeArc(pos, facing, enemyPos0);
    const arcExposureTerm = incomingToAi === "FRONT" ? 0.9 : incomingToAi === "LEFT" || incomingToAi === "RIGHT" ? -0.6 : -2.2;

    // Flanking: prefer positions that place us in the enemy's side/rear arcs (so our shots are more likely to land with arc bonuses).
    const aiRelativeToEnemy = relativeArc(enemyPos0, enemyFacing0, pos);
    const flankBonus = aiRelativeToEnemy === "REAR" ? 0.55 : aiRelativeToEnemy === "LEFT" || aiRelativeToEnemy === "RIGHT" ? 0.2 : 0;

    // Expected incoming fire (after our move). Ion Save is only from the FRONT arc; Rotate Ion Shields improves armour saves.
    // When estimating incoming fire, assume the enemy will pick our most vulnerable location.
    const aiSelfTargetCellId = pickMostVulnerableCellId(aiKnight);
    const incomingKind: AttackKind = defensivePosture ? "AIMED" : "STANDARD";
    const expectedIncomingNoRotate = expectedRangedVolleyDamage({
      attackKind: incomingKind,
      attacker: enemyKnight,
      attackerPos: enemyPos0,
      attackerFacingDeg: enemyFacing0,
      defender: aiKnight,
      defenderPos: pos,
      defenderFacingDeg: facing,
      defenderArmourSaveBonus: 0,
      targetCellId: aiSelfTargetCellId,
    });

    const expectedIncoming = expectedRangedVolleyDamage({
      attackKind: incomingKind,
      attacker: enemyKnight,
      attackerPos: enemyPos0,
      attackerFacingDeg: enemyFacing0,
      defender: aiKnight,
      defenderPos: pos,
      defenderFacingDeg: facing,
      defenderArmourSaveBonus: armourBonusAfterRotate,
      targetCellId: aiSelfTargetCellId,
    });

    const incomingWeight = defensivePosture ? 0.55 : 0.35;
    const incomingTerm = -incomingWeight * expectedIncoming;

    // Rotate is only worth it when meaningful fire is expected.
    const rotateCostPenalty = c0.actions.includes("ROTATE_ION_SHIELDS") ? 0.25 : 0;
    const rotateLowThreatPenalty = c0.actions.includes("ROTATE_ION_SHIELDS") && expectedIncomingNoRotate < 0.25 ? 0.7 : 0;

    // Avoid plans that fail to make progress (terrain dead-ends).
    const stuckPenalty = (c0.actions.includes("ADVANCE") && movedAdvance < 1 ? 2.0 : 0) + (c0.actions.includes("RUN") && movedRun < 1 ? 2.0 : 0);

    // Distance preference.
    let distCoeff = defensivePosture ? 0.04 : -0.02;
    if (!aiHasMelee && enemyHasMelee) distCoeff += 0.06;
    if (aiHasMelee && !enemyHasMelee) distCoeff -= 0.04;

    // If we're shorter-ranged than the enemy, we should close (but not "overshoot" and expose rear).
    const shortRanged = aiEffRange > 0 && aiEffRange + 4 < enemyEffRange;
    const rangeOvershootPenalty = aiEffRange > 0 && dEnd > aiEffRange ? (dEnd - aiEffRange) * 0.08 : 0;

    // Prefer being inside our effective band when we are the short-ranged fighter.
    const rangeBandBonus = shortRanged && aiEffRange > 0 && dEnd <= aiEffRange ? 0.35 : 0;

    // If we have no melee and the enemy does, avoid ending within their likely charge reach.
    const kitePenalty = !aiHasMelee && enemyHasMelee && dEnd <= enemyMeleeReach + 7 ? 0.9 : 0;

    // If we do have melee and are close enough, encourage closing for a charge next.
    const closeMeleeBonus = aiHasMelee && dEnd <= aiMeleeReach + 7 ? 0.35 : 0;

    const score =
      expected +
      hardCoverBonus +
      softCoverBonus +
      arcExposureTerm +
      flankBonus +
      rangeBandBonus +
      closeMeleeBonus +
      distCoeff * dEnd -
      rangeOvershootPenalty -
      kitePenalty +
      incomingTerm -
      rotateCostPenalty -
      rotateLowThreatPenalty -
      stuckPenalty;

    return {
      ...c0,
      advFacing: advFacingUsed ?? c0.advFacing ?? null,
      runFacing: runFacingUsed ?? c0.runFacing ?? null,
      score,
      expectedDamage: expected,
    };
  };

  // --- Candidate generation ---
  const baseBearing = bearingDeg(aiPos0, enemyPos0);
  const offsets = [-90, -60, -45, -30, -15, 0, 15, 30, 45, 60, 90];

  const pointAt = (origin: Vec2, deg: number, r: number): Vec2 => {
    const rr = (deg * Math.PI) / 180;
    return { x: origin.x + Math.cos(rr) * r, y: origin.y + Math.sin(rr) * r };
  };

  const advanceGoals: Vec2[] = offsets.map((off) => nudgeToUnblocked(pointAt(aiPos0, baseBearing + off, advDist)));

  // Flanking goals: attempt to work toward the enemy's sides/rear based on their current facing.
  // (These can be beyond ADVANCE distance; the mover will take the best path up to the allowed inches.)
  const flankRadius = Math.max(10, Math.min(22, (aiEffRange || 18) * 0.75));
  const flankGoals: Vec2[] = [
    nudgeToUnblocked(pointAt(enemyPos0, enemyFacing0 + 180, flankRadius)),
    nudgeToUnblocked(pointAt(enemyPos0, enemyFacing0 - 90, flankRadius)),
    nudgeToUnblocked(pointAt(enemyPos0, enemyFacing0 + 90, flankRadius)),
    nudgeToUnblocked(pointAt(enemyPos0, enemyFacing0 + 180, flankRadius + 6)),
  ];

  // Add a "best cover" option if it exists.
  const coverCandidates: Vec2[] = [];
  for (const t of terrain) {
    for (const r of t.rects) {
      const corners = [
        { x: r.x - 2, y: r.y - 2 },
        { x: r.x + r.w + 2, y: r.y - 2 },
        { x: r.x - 2, y: r.y + r.h + 2 },
        { x: r.x + r.w + 2, y: r.y + r.h + 2 },
      ];
      for (const c of corners) coverCandidates.push(nudgeToUnblocked(c));
    }
  }
  let bestCover: Vec2 | null = null;
  let bestCoverScore = -1e9;
  for (const c of coverCandidates) {
    const los = computeLosEffects(enemyPos0, c, terrain);
    const bonus = los.blocked ? 1.0 : los.obscured ? 0.4 : 0;
    const d = distInches(c, enemyPos0);
    const sc = bonus - 0.03 * d;
    if (sc > bestCoverScore) {
      bestCoverScore = sc;
      bestCover = c;
    }
  }

  const uniqueGoals = (list: Vec2[]) => {
    const seen = new Set<string>();
    const out: Vec2[] = [];
    for (const p of list) {
      const k = `${p.x},${p.y}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(p);
    }
    return out;
  };

  const advGoals = uniqueGoals([...advanceGoals, ...flankGoals, ...(bestCover ? [bestCover] : [])]);

  // Run goals: continue from advance goal toward enemy.
  const runGoalFrom = (fromAfterAdvance: Vec2): Vec2 => {
    const b = bearingDeg(fromAfterAdvance, enemyPos0);
    return nudgeToUnblocked(pointAt(fromAfterAdvance, b, runDistExp + 11));
  };

  const candidates: Candidate[] = [];

  const add = (c: Candidate) => {
    if (!withinAp(c.actions)) return;
    candidates.push(scoreCandidate(c));
  };

  const canRotate = !!aiKnight.canRotateIonShields;

  // Rush: snap + advance + run
  for (const g of advGoals) {
    add({ name: "RUSH", actions: ["SNAP_ATTACK", "ADVANCE", "RUN"], advDest: g, runDest: runGoalFrom(g) });
    if (canRotate) {
      // Close under fire with a defensive rotation (+1 armour saves).
      add({ name: "RUSH+SHIELD", actions: ["SNAP_ATTACK", "ADVANCE", "ROTATE_ION_SHIELDS", "RUN"], advDest: g, runDest: runGoalFrom(g) });
    }
  }

  // Advance + standard attack (take shots as you close)
  for (const g of advGoals) {
    add({ name: "ADV+STD", actions: ["ADVANCE", "STANDARD_ATTACK"], advDest: g });
    if (canRotate) {
      add({ name: "ADV+SHIELD+STD", actions: ["ADVANCE", "ROTATE_ION_SHIELDS", "STANDARD_ATTACK"], advDest: g });
    }
  }

  // Stand and shoot (useful if already in range)
  add({ name: "HOLD+STD", actions: ["STANDARD_ATTACK"] });
  add({ name: "HOLD+AIM", actions: ["AIMED_ATTACK"] });
  if (canRotate) add({ name: "HOLD+SHIELD+STD", actions: ["ROTATE_ION_SHIELDS", "STANDARD_ATTACK"] });

  // Retreat & shield only when genuinely damaged.
  if (defensivePosture && canRotate) {
    const away = nudgeToUnblocked(pointAt(aiPos0, facingAway(aiPos0, enemyPos0), advDist));
    const awayRun = nudgeToUnblocked(pointAt(away, facingAway(away, enemyPos0), runDistExp + 11));
    add({
      name: "RETREAT+SHIELD",
      actions: ["ADVANCE", "ROTATE_ION_SHIELDS", "RUN"],
      advDest: away,
      runDest: awayRun,
      // Move away, but end facing the enemy so the FRONT arc remains protected by Ion Saves.
      advFacing: bearingDeg(away, enemyPos0),
      runFacing: bearingDeg(awayRun, enemyPos0),
    });
  }

  // Charge if plausible.
  if (aiHasMelee && withinAp(["ADVANCE", "CHARGE"])) {
    for (const g of advGoals) {
      add({ name: "ADV+CHARGE", actions: ["ADVANCE", "CHARGE"], advDest: g, meleeWeapon: "AUTO" });
    }
  }

  // Pick winner.
  candidates.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const best = candidates[0];
  if (!best) return;

  // Soft randomness among the top few to avoid deterministic play.
  const top = candidates.filter((c) => (c.score ?? -1e9) >= (best.score ?? 0) - 0.5);
  const choice = top[Math.floor(Math.random() * top.length)] ?? best;

  // Apply choice: plans + inputs
  const nextPlans: Plan = { actions: choice.actions };
  const nextInputs: any = {};

  const advDest = choice.advDest ?? null;
  if (choice.actions.includes("ADVANCE") && advDest) {
    nextInputs.ADVANCE = { dest: advDest, distanceInches: advDist, endFacingDeg: choice.advFacing ?? null };
    setMoveDestinations((prev) => ({ ...prev, [ai]: { ...prev[ai], ADVANCE: advDest } }));
    setMoveEndFacings((prev) => ({
      ...prev,
      [ai]: { ...prev[ai], ADVANCE: typeof choice.advFacing === "number" ? choice.advFacing : null },
    }));
  }

  const runDest = choice.runDest ?? null;
  if (choice.actions.includes("RUN") && runDest) {
    nextInputs.RUN = { dest: runDest, distanceInches: 0, endFacingDeg: choice.runFacing ?? null };
    setMoveDestinations((prev) => ({ ...prev, [ai]: { ...prev[ai], RUN: runDest } }));
    setMoveEndFacings((prev) => ({
      ...prev,
      [ai]: { ...prev[ai], RUN: typeof choice.runFacing === "number" ? choice.runFacing : null },
    }));
  }

  if (choice.actions.includes("CHARGE")) {
    nextInputs.CHARGE = {
      // Charge movement is automatic at the Charge step; no destination needs to be plotted.
      move: { distanceInches: chargeDist },
      meleeAttack: {
        weapon: CORE_WEAPONS.REAPER_CHAINSWORD,
        targetCellId,
        dice: {},
      },
    };
  }

  if (choice.actions.includes("SNAP_ATTACK")) nextInputs.SNAP_ATTACK = { targetCellId, dice: {} };
  if (choice.actions.includes("STANDARD_ATTACK")) nextInputs.STANDARD_ATTACK = { targetCellId, dice: {} };
  if (choice.actions.includes("AIMED_ATTACK")) nextInputs.AIMED_ATTACK = { targetCellId, dice: {} };

  if (choice.actions.includes("ROTATE_ION_SHIELDS")) {
    nextInputs.ROTATE_ION_SHIELDS = {};
  }

  setPlans((prev) => ({ ...prev, [ai]: nextPlans }));
  setInputs((prev) => ({ ...prev, [ai]: nextInputs }));
}

function lockOrders(player: PlayerId) {
  // Orders become hidden/locked by phase changes.
  setRevealLockedOrders(false);

  const vsAi = gameMode === "VS_AI";

  // Auto-lock loadouts after both sides lock orders on Turn 1.
  if (!loadoutLocked && turnNumber === 1 && (player === "P2" || (vsAi && player === "P1"))) {
    setLoadoutLocked(true);
  }

  if (player === "P1") {
    if (vsAi) {
      generateAiOrdersForP2();
      setPhase("READY_TO_EXECUTE");
    } else {
      setPhase("PASS_TO_P2");
    }
  } else {
    setPhase("READY_TO_EXECUTE");
  }
}

function restartPlanning() {
  // Re-plan the current turn without resetting Knight damage/state.
  setPlans({ P1: { actions: [] }, P2: { actions: [] } });
  setInputs({ P1: {}, P2: {} });
  setRevealLockedOrders(false);
  setPhase("P1_ORDERS");
}

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 16, maxWidth: 1200, margin: "0 auto" }}>

<style>{`
  @keyframes rcFlashDamaged {
    0% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.95); transform: scale(1.00); }
    25% { box-shadow: 0 0 0 6px rgba(245, 158, 11, 0.40); transform: scale(1.02); }
    100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.0); transform: scale(1.00); }
  }
  @keyframes rcFlashDestroyed {
    0% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.95); transform: scale(1.00); }
    25% { box-shadow: 0 0 0 6px rgba(220, 38, 38, 0.40); transform: scale(1.02); }
    100% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.0); transform: scale(1.00); }
  }
  .rc-flash-damaged { animation: rcFlashDamaged 1.25s ease-out 0s 1; }
  .rc-flash-destroyed { animation: rcFlashDestroyed 1.25s ease-out 0s 1; }
`}</style>

{screen === "HOME" ? (
  <HomeScreen
    onPlay={() => setScreen("MENU")}
    onHowToPlay={() => setScreen("HOW_TO_PLAY")}
  />
) : screen === "HOW_TO_PLAY" ? (
  <HowToPlayScreen
    onBackHome={() => setScreen("HOME")}
    onPlay={() => setScreen("MENU")}
  />
) : screen === "MENU" ? (
  <StartMenu
    onBackHome={() => setScreen("HOME")}
    onHowToPlay={() => setScreen("HOW_TO_PLAY")}
    hasLastSave={!!(safeReadSave(MANUAL_SAVE_KEY) ?? safeReadSave(AUTOSAVE_KEY))}
    onLoadLastSave={() => {
      const saved = safeReadSave(MANUAL_SAVE_KEY) ?? safeReadSave(AUTOSAVE_KEY);
      if (!saved?.state) return;
      applyPersistedState(saved.state, { silent: true });
      setGameMode("TWO_PLAYER");
      setActiveTab("PLAY");
      setScreen("GAME");
      setLog((prev) => [...prev, `📥 Loaded save (${saved.savedAt ? new Date(saved.savedAt).toLocaleString() : "unknown date"})`]);
    }}
    onImportSave={(file) => {
      const reader = new FileReader();
      reader.onload = () => {
        importSaveJsonText(String(reader.result ?? ""));
        setGameMode("TWO_PLAYER");
        setActiveTab("PLAY");
        setScreen("GAME");
      };
      reader.readAsText(file);
    }}
    onStartTwoPlayerNewGame={() => {
      setGameMode("TWO_PLAYER");
      const chosenMapId = menuRandomMap ? pickRandomMapId() : menuSelectedMapId;
      startFreshGame({ mapId: chosenMapId });
      setActiveTab("PLAY");
      setScreen("GAME");
    }}

    onStartVsAiNewGame={() => {
      setGameMode("VS_AI");
      const chosenMapId = menuRandomMap ? pickRandomMapId() : menuSelectedMapId;
      startFreshGame({ mapId: chosenMapId, p2Name: "AI Knight", p2IsAi: true });
      setActiveTab("PLAY");
      setScreen("GAME");
    }}

    mapOptions={availableMaps}
    selectedMapId={menuSelectedMapId}
    setSelectedMapId={setMenuSelectedMapId}
    randomMap={menuRandomMap}
    setRandomMap={setMenuRandomMap}
  />
) : (
  <>
      <h1 style={{ margin: 0 }}>Knight Commander (Core Questoris Test Harness)</h1>
      <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>
        Mode: {gameMode === "TWO_PLAYER" ? "2 Player Automated" : gameMode === "VS_AI" ? "VS AI" : gameMode}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button
          onClick={() => setActiveTab("PLAY")}
          style={{
            fontWeight: activeTab === "PLAY" ? 800 : 600,
            border: activeTab === "PLAY" ? "2px solid #111" : "1px solid #ddd",
          }}
        >
          Play
        </button>
        <button
          onClick={() => setActiveTab("RULES")}
          style={{
            fontWeight: activeTab === "RULES" ? 800 : 600,
            border: activeTab === "RULES" ? "2px solid #111" : "1px solid #ddd",
          }}
        >
          Rules Appendix
        </button>
      </div>

<div style={{ display: "flex", gap: 12, margin: "12px 0", alignItems: "center", flexWrap: "wrap" }}>
  
<button
  onClick={() => {
    setScreen("HOME");
  }}
>
  Home
</button>
<button onClick={() => {
    const ok = window.confirm("Reset the game? This will clear autosave/manual save and all current damage/logs.");
    if (!ok) return;
    resetForNewGame();
  }}>Reset</button>
  <button onClick={() => saveNow()}>Save now</button>
  <button onClick={loadLastSave}>Load last save</button>
  <button onClick={exportSaveJson}>Export save (JSON)</button>
  <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
    <span style={{ opacity: 0.85 }}>Import save:</span>
    <input
      type="file"
      accept="application/json"
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => importSaveJsonText(String(reader.result ?? ""));
        reader.readAsText(f);
        e.currentTarget.value = "";
      }}
    />
  </label>
  {lastAutoSavedAt && (
    <div style={{ fontSize: 12, opacity: 0.75 }}>Autosave: {new Date(lastAutoSavedAt).toLocaleString()}</div>
  )}
  {lastManualSavedAt && (
    <div style={{ fontSize: 12, opacity: 0.75 }}>Manual save: {new Date(lastManualSavedAt).toLocaleString()}</div>
  )}
</div>

  <div style={{ display: "flex", gap: 12, margin: "12px 0", alignItems: "center", flexWrap: "wrap" }}>

  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
    <span style={{ opacity: 0.85 }}>Range:</span>
    <b>{measuredRangeInches}"</b>
    <span style={{ opacity: 0.7 }}>(auto from 48×48 map)</span>
  </div>
  <div style={{ fontSize: 13, opacity: 0.85 }}>
    Loadouts: <b>{loadoutLocked ? "LOCKED" : "Unlocked"}</b>
    {!loadoutLocked && <span style={{ marginLeft: 8, opacity: 0.75 }}>(auto-locks after Turn 1 orders)</span>}
  </div>
  <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
    <input type="checkbox" checked={autoRoll} onChange={(e) => setAutoRoll(e.target.checked)} />
    <span style={{ fontSize: 13 }}>Auto-roll dice (uncheck for manual dice)</span>
  </label>

  <div style={{ marginLeft: "auto", opacity: 0.8 }}>
    Turn: {turnNumber} —{" "}
    {phase === "P1_ORDERS"
      ? "P1 planning"
      : phase === "PASS_TO_P2"
      ? "pass device"
      : phase === "P2_ORDERS"
      ? "P2 planning"
      : "ready"}
  </div>
</div>

{activeTab === "RULES" && (
  <RulesAppendix />
)}

{activeTab === "PLAY" && phase === "P1_ORDERS" && (
  <div>
    <h2 style={{ marginTop: 8 }}>{gameMode === "VS_AI" ? "Player 1 (You): Choose orders" : "Player 1: Choose orders"}</h2>
<PlayerPanel
      player="P1"
      knight={knights.P1}
      enemy={knights.P2}
      baseGrid={baseGrids.P1}
      loadout={loadouts.P1}
      onLoadoutChange={(next) => {
              setLoadouts((prev) => ({ ...prev, P1: next }));
              setKnights((prev) => ({ ...prev, P1: applyLoadoutToKnight(prev.P1, next) }));
            }}
      loadoutLocked={loadoutLocked}
      plan={plans.P1}
      apSpent={apSpentByPlayer.P1}
      onToggleAction={(a, en) => toggleActionEnabled("P1", a as CoreAction, en)}
      issues={issuesByPlayer.P1}
      gridCells={baseGrids.P2.cells}
      weaponTargets={weaponTargets.P1}
      onWeaponTargetsChange={(next) => setWeaponTargets((prev) => ({ ...prev, P1: next }))}

      mapSlot={
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div>
            <MapCanvas
              terrain={terrain}
              positions={positions}
              facings={facings}
              maxMoveInches={maxMoveInchesByPlayer}
              ionShieldEnabled={{ P1: knights.P1.canRotateIonShields, P2: knights.P2.canRotateIonShields }}
              weaponsByPlayer={{ P1: knights.P1.weapons, P2: knights.P2.weapons }}
              knightNames={{ P1: knights.P1.name, P2: knights.P2.name }}
              moveDestinations={moveDestinations}
              moveEndFacings={moveEndFacings}
              activeMoveMode={activeMoveMode}
              onSetActiveMoveMode={(p, m) => setActiveMoveMode((prev) => ({ ...prev, [p]: m }))}
              activePlayer="P2"
              visibleDestinations={{ P1: true, P2: false }}
              onSetFacing={(p, deg) => setFacings((prev) => ({ ...prev, [p]: deg }))}
              onSetMoveEndFacing={(p, mode, degOrNull) =>
                setMoveEndFacings((prev) => ({ ...prev, [p]: { ...prev[p], [mode]: degOrNull } }))
              }
              onSetDestination={(p, mode, dest) =>
                setMoveDestinations((prev) => ({ ...prev, [p]: { ...prev[p], [mode]: dest } }))
              }
            />
            <div style={{ display: "flex", gap: 10, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button
                onClick={() => {
                  const sp = pickRandomSpawnPositions();
                  setPositions(sp);
                  setFacings(faceEachOther(sp));
                  setMoveDestinations({ P1: { ADVANCE: null, RUN: null, CHARGE: null }, P2: { ADVANCE: null, RUN: null, CHARGE: null } });
                  setMoveEndFacings({ P1: { ADVANCE: null, RUN: null, CHARGE: null }, P2: { ADVANCE: null, RUN: null, CHARGE: null } });
                }}
              >
                Reset spawns
              </button>
              <button onClick={() => {
                setMoveDestinations({ P1: { ADVANCE: null, RUN: null, CHARGE: null }, P2: { ADVANCE: null, RUN: null, CHARGE: null } });
                setMoveEndFacings({ P1: { ADVANCE: null, RUN: null, CHARGE: null }, P2: { ADVANCE: null, RUN: null, CHARGE: null } });
              }}>Clear destinations</button>
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                Default spawns: P1 (6,24) and P2 (42,24). Use the mode buttons on the map to set separate destinations for Advance / Run. Charge is automatic.
              </div>
            </div>
          </div>
        </div>
      }
      defaultTargetCellId={DEFAULT_TARGET_CELL_ID}
    />

    {!isNarrow ? (
      <div style={{ display: "flex", gap: 12, marginTop: 12, alignItems: "center" }}>
        <button onClick={() => lockOrders("P1")}>{gameMode === "VS_AI" ? "Lock Orders (AI will plan)" : "Lock P1 Orders"}</button>
        <div style={{ opacity: 0.7, fontSize: 13 }}>{gameMode === "VS_AI" ? "AI will immediately plan Player 2 orders." : "Pass the device to Player 2 after locking."}</div>
      </div>
    ) : (
      <>
        <div style={{ height: 110 }} />
        <div
          style={{
            position: "fixed",
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 50,
            background: "#fff",
            borderTop: "1px solid #eee",
            boxShadow: "0 -8px 24px rgba(0,0,0,0.10)",
            padding: 12,
            paddingBottom: "calc(12px + env(safe-area-inset-bottom))",
          }}
        >
          <button
            onClick={() => lockOrders("P1")}
            style={{
              width: "100%",
              padding: "14px 16px",
              borderRadius: 16,
              fontWeight: 900,
              fontSize: 16,
            }}
          >
            {gameMode === "VS_AI" ? "Lock Orders (AI will plan)" : "Lock P1 Orders"}
          </button>
          <div style={{ marginTop: 8, opacity: 0.75, fontSize: 13 }}>
            {gameMode === "VS_AI" ? "AI will immediately plan Player 2 orders." : "Pass the device to Player 2 after locking."}
          </div>
        </div>
      </>
    )}
  </div>
)}

{activeTab === "PLAY" && phase === "PASS_TO_P2" && gameMode !== "VS_AI" && (
  <div
    style={{
      marginTop: 24,
      border: "1px solid #ddd",
      borderRadius: 12,
      padding: 16,
      background: "#fafafa",
    }}
  >
    <h2 style={{ marginTop: 0 }}>Pass device to Player 2</h2>
    <p style={{ marginTop: 0, opacity: 0.85 }}>
      Player 1 orders are locked. Hand the device to Player 2, then tap continue.
    </p>
    <div style={{ display: "flex", gap: 12 }}>
      <button onClick={() => setPhase("P1_ORDERS")}>Back</button>
      <button onClick={() => setPhase("P2_ORDERS")}>Continue to Player 2</button>
    </div>
  </div>
)}

{activeTab === "PLAY" && phase === "P2_ORDERS" && gameMode !== "VS_AI" && (
  <div>
    <h2 style={{ marginTop: 8 }}>Player 2: Choose orders</h2>
<PlayerPanel
      player="P2"
      knight={knights.P2}
      enemy={knights.P1}
      baseGrid={baseGrids.P1}
      loadout={loadouts.P2}
      onLoadoutChange={(next) => {
              setLoadouts((prev) => ({ ...prev, P2: next }));
              setKnights((prev) => ({ ...prev, P2: applyLoadoutToKnight(prev.P2, next) }));
            }}
      loadoutLocked={loadoutLocked}
      plan={plans.P2}
      apSpent={apSpentByPlayer.P2}
      onToggleAction={(a, en) => toggleActionEnabled("P2", a as CoreAction, en)}
      issues={issuesByPlayer.P2}
      gridCells={baseGrids.P1.cells}
      weaponTargets={weaponTargets.P2}
      onWeaponTargetsChange={(next) => setWeaponTargets((prev) => ({ ...prev, P2: next }))}

      mapSlot={
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div>
            <MapCanvas
              terrain={terrain}
              positions={positions}
              facings={facings}
              maxMoveInches={maxMoveInchesByPlayer}
              ionShieldEnabled={{ P1: knights.P1.canRotateIonShields, P2: knights.P2.canRotateIonShields }}
              weaponsByPlayer={{ P1: knights.P1.weapons, P2: knights.P2.weapons }}
              knightNames={{ P1: knights.P1.name, P2: knights.P2.name }}
              moveDestinations={moveDestinations}
              moveEndFacings={moveEndFacings}
              activeMoveMode={activeMoveMode}
              onSetActiveMoveMode={(p, m) => setActiveMoveMode((prev) => ({ ...prev, [p]: m }))}
              activePlayer="P2"
              visibleDestinations={{ P1: false, P2: true }}
              onSetFacing={(p, deg) => setFacings((prev) => ({ ...prev, [p]: deg }))}
              onSetMoveEndFacing={(p, mode, degOrNull) =>
                setMoveEndFacings((prev) => ({ ...prev, [p]: { ...prev[p], [mode]: degOrNull } }))
              }
              onSetDestination={(p, mode, dest) =>
                setMoveDestinations((prev) => ({ ...prev, [p]: { ...prev[p], [mode]: dest } }))
              }
            />
            <div style={{ display: "flex", gap: 10, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button
                onClick={() => {
                  const sp = pickRandomSpawnPositions();
                  setPositions(sp);
                  setFacings(faceEachOther(sp));
                  setMoveDestinations({ P1: { ADVANCE: null, RUN: null, CHARGE: null }, P2: { ADVANCE: null, RUN: null, CHARGE: null } });
                  setMoveEndFacings({ P1: { ADVANCE: null, RUN: null, CHARGE: null }, P2: { ADVANCE: null, RUN: null, CHARGE: null } });
                }}
              >
                Reset spawns
              </button>
              <button onClick={() => {
                setMoveDestinations({ P1: { ADVANCE: null, RUN: null, CHARGE: null }, P2: { ADVANCE: null, RUN: null, CHARGE: null } });
                setMoveEndFacings({ P1: { ADVANCE: null, RUN: null, CHARGE: null }, P2: { ADVANCE: null, RUN: null, CHARGE: null } });
              }}>Clear destinations</button>
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                Default spawns: P1 (6,24) and P2 (42,24). Use the mode buttons on the map to set separate destinations for Advance / Run. Charge is automatic.
              </div>
            </div>
          </div>
        </div>
      }
      defaultTargetCellId={DEFAULT_TARGET_CELL_ID}
    />

    {!isNarrow ? (
      <div style={{ display: "flex", gap: 12, marginTop: 12, alignItems: "center" }}>
        <button onClick={() => setPhase("PASS_TO_P2")}>Back</button>
        <button onClick={() => lockOrders("P2")}>Lock P2 Orders</button>
      </div>
    ) : (
      <>
        <div style={{ height: 110 }} />
        <div
          style={{
            position: "fixed",
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 50,
            background: "#fff",
            borderTop: "1px solid #eee",
            boxShadow: "0 -8px 24px rgba(0,0,0,0.10)",
            padding: 12,
            paddingBottom: "calc(12px + env(safe-area-inset-bottom))",
          }}
        >
          <div style={{ display: "flex", gap: 12 }}>
            <button
              onClick={() => setPhase("PASS_TO_P2")}
              style={{
                flex: 1,
                padding: "14px 16px",
                borderRadius: 16,
                fontWeight: 800,
                fontSize: 16,
              }}
            >
              Back
            </button>
            <button
              onClick={() => lockOrders("P2")}
              style={{
                flex: 2,
                padding: "14px 16px",
                borderRadius: 16,
                fontWeight: 900,
                fontSize: 16,
              }}
            >
              Lock P2 Orders
            </button>
          </div>
        </div>
      </>
    )}
  </div>
)}



{activeTab === "PLAY" && phase === "POST_TURN_SUMMARY" && (
  <div>
    <h2 style={{ marginTop: 8 }}>
      End of Turn {Math.max(1, turnNumber - 1)} — Status Summary
    </h2>

    <div style={{ fontSize: 13, opacity: 0.8, marginTop: 6 }}>
      Changed cells are highlighted: <span style={{ fontWeight: 800, color: "#B45309" }}>orange</span> = damaged,{" "}
      <span style={{ fontWeight: 800, color: "#B91C1C" }}>red</span> = destroyed.
    </div>
    <div style={{ marginTop: 8, fontSize: 13, opacity: 0.85 }}>Tip: Tap <b>P1</b>/<b>P2</b> to swap views on phones.</div>

    <div style={{ marginTop: 12, display: "flex", justifyContent: "center" }}>
      <MapCanvas
        terrain={terrain}
        positions={positions}
        facings={facings}
        showScanPanel={false}
        ionShieldEnabled={{ P1: knights.P1.canRotateIonShields, P2: knights.P2.canRotateIonShields }}
        weaponsByPlayer={{ P1: knights.P1.weapons, P2: knights.P2.weapons }}
        knightNames={{ P1: knights.P1.name, P2: knights.P2.name }}
        moveDestinations={moveDestinations}
        moveEndFacings={moveEndFacings}
        activeMoveMode={activeMoveMode}
        onSetActiveMoveMode={(_p, _m) => {}}
        activePlayer={null}
        onSetFacing={(p, deg) => setFacings((prev) => ({ ...prev, [p]: deg }))}
        onSetMoveEndFacing={(_p, _mode, _degOrNull) => {}}
        onSetDestination={(_p, _mode, _dest) => {}}
        visibleDestinations={{ P1: true, P2: true }}
        showToolbar={false}
        movementSegments={lastTurnMoveSegments}
      />
    </div>

    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
      <button onClick={() => setShowSummaryLog((s) => !s)}>
        {showSummaryLog ? "Hide last turn log" : "Show last turn log"}
      </button>
    </div>

    {showSummaryLog && (
      <pre
        style={{
          marginTop: 10,
          background: "#111",
          color: "#eee",
          padding: 12,
          borderRadius: 12,
          maxHeight: 260,
          overflow: "auto",
          fontSize: 12,
          whiteSpace: "pre-wrap",
        }}
      >
        {lastTurnLog.join("\n")}
      </pre>
    )}


    <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
  <button
    onClick={() => {
      setSummaryFocus("P1");
      setSummaryMode("FOCUS");
    }}
    style={{
      flex: 1,
      minWidth: 120,
      padding: "12px 14px",
      borderRadius: 14,
      fontWeight: 900,
      border: summaryMode === "FOCUS" && summaryFocus === "P1" ? "2px solid #111" : "1px solid #ddd",
      background: summaryMode === "FOCUS" && summaryFocus === "P1" ? "#111" : "#fff",
      color: summaryMode === "FOCUS" && summaryFocus === "P1" ? "#fff" : "#111",
    }}
  >
    P1
  </button>
  <button
    onClick={() => {
      setSummaryFocus("P2");
      setSummaryMode("FOCUS");
    }}
    style={{
      flex: 1,
      minWidth: 120,
      padding: "12px 14px",
      borderRadius: 14,
      fontWeight: 900,
      border: summaryMode === "FOCUS" && summaryFocus === "P2" ? "2px solid #111" : "1px solid #ddd",
      background: summaryMode === "FOCUS" && summaryFocus === "P2" ? "#111" : "#fff",
      color: summaryMode === "FOCUS" && summaryFocus === "P2" ? "#fff" : "#111",
    }}
  >
    P2
  </button>

  {!isNarrow && summaryMode === "FOCUS" && (
    <button
      onClick={() => setSummaryMode("SPLIT")}
      style={{ padding: "12px 14px", borderRadius: 14, fontWeight: 800, border: "1px solid #ddd" }}
    >
      Show both
    </button>
  )}
</div>

    <div style={{ marginTop: 12 }}>
      {isNarrow || summaryMode === "FOCUS" ? (
        (() => {
          const p = summaryFocus;
          const k = knights[p];
          return (
            <div style={{ border: "1px solid #eee", borderRadius: 16, padding: 12 }}>
              <div style={{ fontWeight: 900, fontSize: 18 }}>{p} Knight</div>

              <div style={{ marginTop: 10 }}>
                <GridView
                  grid={baseGrids[p]}
                  liveGrid={k.grid}
                  selectedCellId={null}
                  onSelect={() => {}}
                  highlights={lastTurnHighlights[p]}
                  flashToken={highlightToken}
                  cellSize={52}
                />
              </div>

              <div style={{ marginTop: 10 }}>
                <CriticalEffectsHUD knight={k} />
              </div>
            </div>
          );
        })()
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          {(["P1", "P2"] as PlayerId[]).map((p) => {
            const k = knights[p];
            return (
              <div key={p} style={{ border: "1px solid #eee", borderRadius: 16, padding: 12 }}>
                <div style={{ fontWeight: 900, fontSize: 16 }}>{p} Knight</div>

                <div style={{ marginTop: 10 }}>
                  <GridView
                    grid={baseGrids[p]}
                    liveGrid={k.grid}
                    selectedCellId={null}
                    onSelect={() => {}}
                    highlights={lastTurnHighlights[p]}
                    flashToken={highlightToken}
                    cellSize={60}
                  />
                </div>

                <div style={{ marginTop: 10 }}>
                  <CriticalEffectsHUD knight={k} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>

    <div style={{ display: "flex", gap: 12, marginTop: 14, alignItems: "center", flexWrap: "wrap" }}>
      <button onClick={() => setPhase("READY_TO_EXECUTE")}>Back</button>
      {gameOver ? (
        <>
          <button
            onClick={() => {
              const chosenMapId = menuRandomMap ? pickRandomMapId() : menuSelectedMapId;
              resetForNewGame({ mapId: chosenMapId });
              setScreen("GAME");
            }}
            style={{ fontWeight: 900 }}
          >
            New Game
          </button>
          <button
            onClick={() => {
              setScreen("HOME");
            }}
          >
            Home
          </button>
        </>
      ) : (
        <button
          onClick={() => {
            setRevealLockedOrders(false);
            // Snapshot the public state at the start of the turn (VS AI parity).
            setTurnStart({
              turnNumber,
              positions: { P1: { ...positions.P1 }, P2: { ...positions.P2 } },
              facings: { ...facings },
            });
            // Start of a new turn: clear any remaining plotted destinations and default the map mode to ADVANCE.
            setMoveDestinations({ P1: { ADVANCE: null, RUN: null, CHARGE: null }, P2: { ADVANCE: null, RUN: null, CHARGE: null } });
            setMoveEndFacings({ P1: { ADVANCE: null, RUN: null, CHARGE: null }, P2: { ADVANCE: null, RUN: null, CHARGE: null } });
            setActiveMoveMode({ P1: "ADVANCE", P2: "ADVANCE" });
            setPhase("P1_ORDERS");
          }}
          style={{ fontWeight: 900 }}
        >
          Start next turn (P1 choose orders)
        </button>
      )}
    </div>
  </div>
)}

{activeTab === "PLAY" && phase === "READY_TO_EXECUTE" && (
  <div>
    <h2 style={{ marginTop: 8 }}>Ready to execute</h2>

    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      {(["P1", "P2"] as PlayerId[]).map((p) => {
        const k = knights[p];
        const apSpent = apSpentByPlayer[p];
        const apMax = k.maxActionPoints ?? 0;

        const plan = plans[p];
        const targets = weaponTargets[p] ?? {};

        const targetLabel = (cellId: string) => {
          const cell = baseGrids.P2.cells.find((c) => c.id === cellId);
          return cell ? `${cellId} (${cellComponentLabel(baseGrids.P2, cell)})` : cellId;
        };

        const summaryRows: { label: string; key: string }[] = [
          { label: "Carapace", key: "CARAPACE" },
          { label: "Torso Secondary", key: "TORSO" },
          { label: "Left Arm", key: "ARM_LEFT_PRIMARY" },
          { label: "Right Arm", key: "ARM_RIGHT_PRIMARY" },
        ];

        return (
          <div key={p} style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <div style={{ fontWeight: 700 }}>{p} Status</div>
              <div style={{ fontSize: 13, opacity: 0.8 }}>
                AP Remaining: {Math.max(0, apMax - apSpent)} / {apMax}
              </div>
            </div>

            <div style={{ marginTop: 10 }}>
              <GridView grid={baseGrids[p]} liveGrid={k.grid} selectedCellId={null} onSelect={() => {}} />
            </div>

            <div style={{ marginTop: 10 }}>
              <CriticalEffectsHUD knight={k} />
            </div>

            <div style={{ marginTop: 10, borderTop: "1px solid #eee", paddingTop: 10 }}>
              {!revealLockedOrders ? (
                <div style={{ opacity: 0.7, fontSize: 13 }}>Orders hidden (tap “Reveal orders” below if you want to review).</div>
              ) : (
                <div style={{ fontSize: 13 }}>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>Locked orders</div>
                  <div>Actions: {plan.actions.length ? plan.actions.join(", ") : "None"}</div>
                  <div style={{ marginTop: 6, fontWeight: 600 }}>Weapon targets</div>
                  <ul style={{ margin: "6px 0 0 18px", padding: 0 }}>
                    {summaryRows.map((r) => {
                      const tid = targets[r.key] ?? DEFAULT_TARGET_CELL_ID;
                      return (
                        <li key={r.key}>
                          {r.label}: {targetLabel(tid)}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>

    <div style={{ display: "flex", gap: 12, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
      <button onClick={executeTurnUI}>Execute Turn</button>
      <button onClick={restartPlanning}>Restart planning</button>

      <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input type="checkbox" checked={revealLockedOrders} onChange={(e) => setRevealLockedOrders(e.target.checked)} />
        <span style={{ fontSize: 13 }}>Reveal orders</span>
      </label>
    </div>
  </div>
)}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 20, flexWrap: "wrap" }}>
  <h2 style={{ margin: 0 }}>Log</h2>
  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
    <button onClick={copyLogToClipboard}>Copy log</button>
    <button onClick={downloadLog}>Download log.txt</button>
  </div>
</div>
      <pre style={{ background: "#111", color: "#eee", padding: 12, borderRadius: 8, minHeight: 160 }}>
        {log.join("\n")}
      </pre>
    
        </>
      )}

</div>
  );
}

function AttackConfigurator(props: {
  title: string;
  action: "SNAP_ATTACK" | "STANDARD_ATTACK" | "AIMED_ATTACK";
  weaponList: WeaponProfile[];
  autoRoll: boolean;
  onChange: (
    action: "SNAP_ATTACK" | "STANDARD_ATTACK" | "AIMED_ATTACK",
    patch: Partial<{ targetCellId: string; dice: DiceOverrides }>
  ) => void;
}) {
  const { title, action } = props;

  return (
    <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 10 }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>{title}</div>

      <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 8 }}>
        This action fires <b>each equipped ranged weapon once</b> (in range) using the target selected in the weapon target dropdowns.
      </div>

      <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
        Obscured / Cover is now handled automatically from terrain LOS; there is no manual toggle.
      </div>

      {!props.autoRoll && (
        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}>
          Manual dice mode currently applies the entered dice to the first weapon shot; additional weapons will auto-roll.
        </div>
      )}

      {!props.autoRoll && (
        <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          <DiceInput label="Red (horizontal)" onChange={(v) => props.onChange(action, { dice: { red: v } })} />
          <DiceInput label="Blue (vertical)" onChange={(v) => props.onChange(action, { dice: { blue: v } })} />
          <DiceInput label="Save" onChange={(v) => props.onChange(action, { dice: { save: v } })} />
          <DiceInput label="Damage D6" onChange={(v) => props.onChange(action, { dice: { damageD6: v } })} />
          <DiceInput label="Damage D3" min={1} max={3} onChange={(v) => props.onChange(action, { dice: { damageD3: v } })} />
        </div>
      )}

      {/* No manual apply button needed; dice inputs apply immediately. */}

      <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
        Target cells come from the weapon target dropdowns.
      </div>
    </div>
  );
}




function LoadoutSelect(props: { loadout: QuestorisLoadout; onChange: (next: QuestorisLoadout) => void; locked?: boolean }) {
  const { loadout, onChange, locked } = props;

  const opts = (slot: keyof LoadoutSlots) =>
    QUESTORIS_LOADOUTS.slots[slot].map((o) => ({ value: o.id, label: o.label }));

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 8 }}>
      <LabeledSelect
        label="Left Arm"
        value={loadout.leftArm}
        options={opts("leftArm")}
        onChange={(v) => onChange({ ...loadout, leftArm: v })}
        disabled={locked}
      />
      <LabeledSelect
        label="Right Arm"
        value={loadout.rightArm}
        options={opts("rightArm")}
        onChange={(v) => onChange({ ...loadout, rightArm: v })}
        disabled={locked}
      />
      <LabeledSelect
        label="Carapace"
        value={loadout.carapace}
        options={opts("carapace")}
        onChange={(v) => onChange({ ...loadout, carapace: v })}
        disabled={locked}
      />
      <LabeledSelect
        label="Torso Secondary"
        value={loadout.torso}
        options={opts("torso")}
        onChange={(v) => onChange({ ...loadout, torso: v })}
        disabled={locked}
      />
    </div>
  );
}

function WeaponTargetingHUD(props: {
  loadout: QuestorisLoadout;
  gridCells: { id: string }[];
  weaponTargets: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  defaultTargetCellId: string;
}) {

  const fields: { key: string; label: string; enabled: boolean }[] = [
  { key: "CARAPACE", label: "Carapace", enabled: true },
  { key: "TORSO", label: "Torso Secondary", enabled: true },
  { key: "ARM_LEFT_PRIMARY", label: "Left Arm", enabled: true },
  { key: "ARM_RIGHT_PRIMARY", label: "Right Arm", enabled: true },
];


  const get = (k: string) => props.weaponTargets[k] ?? props.defaultTargetCellId;

  return (
    <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 12 }}>
      <div style={{ fontWeight: 800, marginBottom: 10 }}>Weapon Targets</div>
      <div style={{ display: "grid", gap: 10 }}>
        {fields.map((f) => (
          <label
            key={f.key}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 120px",
              gap: 10,
              alignItems: "center",
              opacity: f.enabled ? 1 : 0.35,
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 700 }}>{f.label}</span>
            <select
              disabled={!f.enabled}
              value={get(f.key)}
              onChange={(e) => props.onChange({ ...props.weaponTargets, [f.key]: e.target.value })}
              style={{ padding: 8 }}
            >
              {props.gridCells.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.id}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
    </div>
  );
}

function CriticalEffectsHUD(props: { knight: KnightState }) {
  const k = props.knight;
  const byId = (id: string) => k.grid.cells.find((c) => c.id === id)?.criticallyDamaged ?? false;

  const carapace = byId("A4");
  const leftArm = byId("D2") && byId("E2");
  const tiltingShield = byId("C3");
  const sensors = byId("C4");
  const torso = byId("C5");
  const rightArm = byId("D6") && byId("E6");
  const moveList = ["E3", "E5", "F2", "F3", "F5", "F6"];
  const moveReducedCount = sum(moveList.map((id) => (byId(id) ? 1 : 0)));
  const moveReducedActive = moveReducedCount > 0;

  const items: { label: string; active: boolean; cells: string }[] = [
    { label: "Weapon Destroyed (Carapace)", active: carapace, cells: "A4" },
    { label: "Weapon Destroyed (Left Arm)", active: leftArm, cells: "D2, E2" },
    { label: "Tilting Shield Destroyed", active: tiltingShield, cells: "C3" },
    { label: "Sensors Destroyed (Head)", active: sensors, cells: "C4" },
    { label: "Weapon Destroyed (Torso)", active: torso, cells: "C5" },
    { label: "Weapon Destroyed (Right Arm)", active: rightArm, cells: "D6, E6" },
    { label: `Movement Reduced (${moveReducedCount}")`, active: moveReducedActive, cells: moveList.join(", ") },
  ];

  return (
    <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 12 }}>
      <div style={{ fontWeight: 800, marginBottom: 10 }}>Critical Effects</div>
      <div style={{ display: "grid", gap: 10 }}>
        {items.map((it) => (
          <div
            key={it.label}
            style={{
              borderRadius: 12,
              padding: "10px 12px",
              border: it.active ? "1px solid rgba(220,38,38,0.6)" : "1px solid #f0f0f0",
              background: it.active ? "rgba(220,38,38,0.18)" : "transparent",
              color: it.active ? "rgb(127,29,29)" : "inherit",
              opacity: it.active ? 1 : 0.35,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 800 }}>{it.label}</div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>cells: {it.cells}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LabeledSelect(props: { label: string; value: string; options: Array<string | { value: string; label: string }>; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 12, opacity: 0.85 }}>{props.label}</span>
      <select disabled={props.disabled} value={props.value} onChange={(e) => props.onChange(e.target.value)}
        style={{
          padding: "12px 12px",
          opacity: props.disabled ? 0.6 : 1,
          fontSize: 16,
          minHeight: 44,
          borderRadius: 12,
          border: "1px solid #ccc",
          background: "#fff",
        }}>
        {props.options.map((o) => {
          const value = typeof o === "string" ? o : o.value;
          const label = typeof o === "string" ? o : o.label;
          return (
            <option key={value} value={value}>
              {label}
            </option>
          );
        })}
      </select>
    </label>
  );
}

function DiceInput(props: { label: string; min?: number; max?: number; onChange: (v: number | undefined) => void }) {
  const { label, min = 1, max = 6, onChange } = props;
  return (
    <label style={{ fontSize: 12 }}>
      <div style={{ opacity: 0.8 }}>{label}</div>
      <input
        type="number"
        min={min}
        max={max}
        placeholder={`${min}-${max}`}
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (!raw) return onChange(undefined);
          const v = Number(raw);
          onChange(Number.isFinite(v) ? v : undefined);
        }}
        style={{ width: "100%", padding: 6 }}
      />
    </label>
  );
}

function GridView(props: {
  grid: Grid;
  liveGrid: Grid;
  selectedCellId: string | null;
  onSelect: (cell: GridCell) => void;
  highlights?: Record<string, "damaged" | "destroyed">;
  flashToken?: number;
  cellSize?: number;
}) {
  const { grid, liveGrid, selectedCellId, onSelect, highlights, flashToken = 0, cellSize = 60 } = props;
  const liveById = new Map(liveGrid.cells.map((c) => [c.id, c]));

  const rows: (GridCell | null)[][] = [];
  for (let y = 0; y < grid.height; y++) {
    const row: (GridCell | null)[] = [];
    for (let x = 0; x < grid.width; x++) {
      const cell = grid.cells.find((c) => c.x === x && c.y === y) ?? null;
      row.push(cell);
    }
    rows.push(row);
  }

  return (
    <div
      style={{
        position: "relative",
        display: "inline-block",
        border: "1px solid #ddd",
        borderRadius: 10,
        padding: 10,
        overflow: "hidden",
      }}
    >
<div style={{ position: "relative" }}>
        {rows.map((row, y) => (
          <div key={y} style={{ display: "flex" }}>
            {row.map((cell, x) => {
              if (!cell) {
                return <div key={x} style={{ width: cellSize, height: cellSize, margin: 2, background: "transparent" }} />;
              }

              const live = liveById.get(cell.id)!;
              const selected = selectedCellId === cell.id;
              const comp = cellComponentLabel(liveGrid, live);

              const baseFill = groupFill(live.group);
              const baseStroke = groupStroke(live.group);

              const isDamaged = !live.criticallyDamaged && live.armorPoints < live.maxArmorPoints;
              const isHeavilyDamaged = isDamaged && live.armorPoints <= Math.ceil(live.maxArmorPoints / 2);
              const bg = live.criticallyDamaged
                ? "#FFEBEE"
                : isDamaged
                ? `linear-gradient(180deg, rgba(245, 158, 11, ${isHeavilyDamaged ? 0.30 : 0.20}), rgba(245, 158, 11, ${isHeavilyDamaged ? 0.14 : 0.10})), ${baseFill}`
                : baseFill;

const hl = highlights?.[live.id];
const hlClass =
  hl === "destroyed" ? "rc-flash-destroyed" : hl === "damaged" ? "rc-flash-damaged" : "";
const hlOutline =
  hl === "destroyed"
    ? "0 0 0 3px rgba(220, 38, 38, 0.85)"
    : hl === "damaged"
    ? "0 0 0 3px rgba(245, 158, 11, 0.85)"
    : "none";

              return (
                <button
                  key={`${live.id}-${flashToken}`}
                  className={hlClass}
                  onClick={() => onSelect(live)}
                  style={{
                    width: cellSize,
                    height: cellSize,
                    margin: 2,
                    borderRadius: 10,
                    border: selected ? "2px solid #111" : `1px solid ${baseStroke}`,
                    background: bg,
                    boxShadow: hlOutline,
                    cursor: "pointer",
                    padding: 6,
                    opacity: live.criticallyDamaged ? 0.85 : 1,
                  }}
                  title={`${live.id} — ${comp} (Group ${live.group})`}
                >
                  <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", justifyContent: "space-between" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 6, alignItems: "baseline" }}>
                      <div style={{ fontSize: 11, fontWeight: 900, opacity: 0.8 }}>{live.id}</div>
                      {cellSize >= 60 && (
                        <div
                          style={{
                            fontSize: 10,
                            opacity: 0.7,
                            maxWidth: cellSize - 28,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            textAlign: "right",
                          }}
                        >
                          {comp}
                        </div>
                      )}
                    </div>

                    <div style={{ fontSize: cellSize >= 60 ? 18 : 16, fontWeight: 1000, lineHeight: 1.0, textAlign: "center" }}>{live.group}</div>

                    <div
                      style={{
                        alignSelf: "flex-end",
                        fontSize: 11,
                        fontWeight: 900,
                        padding: "2px 7px",
                        borderRadius: 999,
                        background: "rgba(255,255,255,0.72)",
                        border: "1px solid rgba(0,0,0,0.08)",
                      }}
                    >
                      {live.criticallyDamaged ? "CRIT" : `${live.armorPoints}/${live.maxArmorPoints}`}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}