import React, { useMemo, useState, useEffect, useRef } from "react";
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);


import { CORE_WEAPONS, WeaponProfile } from "./engine/core-weapons";
import { instantiateGrid, Grid, GridCell } from "./engine/grid";
import { QUESTORIS_GRID_TEMPLATE } from "./engine/questoris-grid";
import { QUESTORIS_CHASSIS, getChassis } from "./engine/chassis";
import { KnightState } from "./engine/criticals-core";
import { CORE_ACTION_COST, CORE_ACTION_ORDER, CoreAction, validatePlan, PlannedTurn } from "./engine/core-actions";
import { executeTurnMutating, GameState, TurnInputs, Vec2 } from "./engine/execute-turn";
import type { DiceOverrides } from "./engine/resolve-attack";
import type { FacingArc } from "./engine/facing-arcs";
import { arcShortLabel } from "./engine/facing-arcs";
import { type MapId, buildTerrainFromLayout, pickRandomMapId, mapOptions } from "./engine/maps";
import type { TerrainPiece } from "./engine/terrain";

import { MapCanvas } from "./MapCanvas";
import rulesAppendix from "./content/rules-appendix.json";
import questorisLoadouts from "./content/loadouts/questoris-loadouts.json";

type PlayerId = "P1" | "P2";

type MoveMode = "ADVANCE" | "RUN" | "CHARGE";

type OrderPhase = "P1_ORDERS" | "PASS_TO_P2" | "P2_ORDERS" | "READY_TO_EXECUTE" | "POST_TURN_SUMMARY";
type AppTab = "PLAY" | "RULES";
const APP_VERSION = "fixed20-save-log";
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
  ionShieldArc: Record<PlayerId, FacingArc>;
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

  const add = (weaponKey: string, mount: string) => {
    const w = (CORE_WEAPONS as any)[weaponKey] as WeaponProfile | undefined;
    if (!w) throw new Error(`Unknown weapon key: ${weaponKey}`);
    weapons.push({ name: w.name, mount, disabled: false });
  };

  const addFromOption = (slot: keyof LoadoutSlots, mount: string, optionId: string) => {
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
        columns: [string, string, string];
        actions: Record<string, { name: string; desc: string }>;
      };
      terrain: { heading: string; items: Array<{ term: string; text: string }> };
      criticals: { heading: string; items: Array<{ name: string; effect: string }> };
      weapons: { heading: string; note: string; columns: [string, string, string, string, string] };
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
type PlayerPlan = PlannedTurn;

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
  ionShieldArc: FacingArc;
  onIonShieldArcChange: (next: FacingArc) => void;
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
              <div style={{ fontWeight: 900, marginBottom: 6 }}>Ion Shield Arc</div>
              <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 8 }}>
                Choose the arc your Ion Shield protects. This setting persists until changed.
              </div>

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {(["FRONT", "LEFT", "RIGHT", "REAR"] as FacingArc[]).map((a) => {
                  const active = props.ionShieldArc === a;
                  return (
                    <button
                      key={a}
                      onClick={() => props.onIonShieldArcChange(a)}
                      disabled={!knight.canRotateIonShields}
                      style={{
                        padding: "6px 10px",
                        borderRadius: 10,
                        border: active ? "2px solid #111" : "1px solid #ddd",
                        background: active ? "#f3f4f6" : "#fff",
                        cursor: knight.canRotateIonShields ? "pointer" : "not-allowed",
                        fontWeight: 800,
                        fontSize: 12,
                      }}
                      title={arcShortLabel(a)}
                    >
                      {arcShortLabel(a)}
                    </button>
                  );
                })}
              </div>

              {!knight.canRotateIonShields && (
                <div style={{ marginTop: 8, fontSize: 12, color: "#b00020", fontWeight: 800 }}>
                  Tilting shield damaged — cannot rotate.
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
type AppScreen = "MENU" | "GAME";

function StartMenu(props: {
  onStartTwoPlayerNewGame: () => void;
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
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 14, letterSpacing: 1, opacity: 0.75, fontWeight: 800 }}>IMPERIAL KNIGHTS: RENEGADE</div>
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
          VS AI (Coming soon)
          <div style={{ fontSize: 12, fontWeight: 600, marginTop: 4, opacity: 0.85 }}>
            AI opponent for solo play (not yet implemented)
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
  const [screen, setScreen] = useState<AppScreen>("MENU");
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

  // Which arc the Ion Shield is currently set to cover for each player.
  const [ionShieldArc, setIonShieldArc] = useState<Record<PlayerId, FacingArc>>({ P1: "FRONT", P2: "FRONT" });

  // Draft arc selection for a pending ROTATE_ION_SHIELDS action.
  // This prevents "free" arc changes by toggling the action on/off during planning.
  const [ionShieldArcDraft, setIonShieldArcDraft] = useState<Record<PlayerId, FacingArc>>({ P1: "FRONT", P2: "FRONT" });


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
    ionShieldArc,
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

  // Ion Shield arc (optional for older saves).
  const savedArc = (state as any).ionShieldArc as Record<PlayerId, FacingArc> | undefined;
  const nextArc = savedArc ?? { P1: "FRONT", P2: "FRONT" };
  setIonShieldArc(nextArc);
  setIonShieldArcDraft(nextArc);

  // Map layout is optional for older saves.
  setMapId(((state as any).mapId as MapId) ?? mapId);
  if ((state as any).moveDestinations) {
    setMoveDestinations((state as any).moveDestinations);
    // Optional: end-facing overrides for each plotted move type.
    setMoveEndFacings(
      ((state as any).moveEndFacings as Record<PlayerId, Record<MoveMode, number | null>>) ??
        { P1: { ADVANCE: null, RUN: null, CHARGE: null }, P2: { ADVANCE: null, RUN: null, CHARGE: null } }
    );
    setActiveMoveMode(((state as any).activeMoveMode) ?? { P1: "ADVANCE", P2: "ADVANCE" });
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
  if (screen === "MENU") return;
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
      return { ...prev, [player]: { ...cur, ROTATE_ION_SHIELDS: { arc: ionShieldArc[player] } } };
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

  
function startFreshGame(opts?: { mapId?: MapId }) {
  // Reset match state, but do NOT delete existing saves.
  setLoadoutLocked(false);
  setWeaponTargets({ P1: {}, P2: {} });
  setLoadouts({ P1: DEFAULT_LOADOUT, P2: DEFAULT_LOADOUT });
  setChassisId({ P1: QUESTORIS_CHASSIS.id, P2: QUESTORIS_CHASSIS.id });

  setKnights({ P1: makeKnight(QUESTORIS_CHASSIS.id, "P1 Knight", DEFAULT_LOADOUT), P2: makeKnight(QUESTORIS_CHASSIS.id, "P2 Knight", DEFAULT_LOADOUT) });
  setPlans({ P1: { actions: [] }, P2: { actions: [] } });
  setInputs({ P1: {}, P2: {} });
  setLog([]);
  setSelectedTargetCell({ P1: null, P2: null });
  setRevealLockedOrders(false);
  setPhase("P1_ORDERS");
  setTurnNumber(1);
  const spawns = pickRandomSpawnPositions();
  setPositions(spawns);
  setFacings(faceEachOther(spawns));
  setIonShieldArc({ P1: "FRONT", P2: "FRONT" });
  setIonShieldArcDraft({ P1: "FRONT", P2: "FRONT" });
  setMapId(opts?.mapId ?? pickRandomMapId());
  setMoveDestinations({ P1: { ADVANCE: null, RUN: null, CHARGE: null }, P2: { ADVANCE: null, RUN: null, CHARGE: null } });
  setMoveEndFacings({ P1: { ADVANCE: null, RUN: null, CHARGE: null }, P2: { ADVANCE: null, RUN: null, CHARGE: null } });
  setActiveMoveMode({ P1: "ADVANCE", P2: "ADVANCE" });
  setGameOver(false);
}

function resetForNewGame(opts?: { mapId?: MapId }) {
    try { localStorage.removeItem(AUTOSAVE_KEY); } catch {}
    try { localStorage.removeItem(MANUAL_SAVE_KEY); } catch {}
    setLastAutoSavedAt(null);
    setLastManualSavedAt(null);
    setLoadoutLocked(false);
    setWeaponTargets({ P1: {}, P2: {} });
    setLoadouts({ P1: DEFAULT_LOADOUT, P2: DEFAULT_LOADOUT });
    setChassisId({ P1: QUESTORIS_CHASSIS.id, P2: QUESTORIS_CHASSIS.id });

    setKnights({ P1: makeKnight(QUESTORIS_CHASSIS.id, "P1 Knight", DEFAULT_LOADOUT), P2: makeKnight(QUESTORIS_CHASSIS.id, "P2 Knight", DEFAULT_LOADOUT) });
    setPlans({ P1: { actions: [] }, P2: { actions: [] } });
    setInputs({ P1: {}, P2: {} });
    setLog([]);
    setSelectedTargetCell({ P1: null, P2: null });
    setRevealLockedOrders(false);
    setPhase("P1_ORDERS");
    setTurnNumber(1);
    const spawns = pickRandomSpawnPositions();
  setPositions(spawns);
  setFacings(faceEachOther(spawns));
  setIonShieldArc({ P1: "FRONT", P2: "FRONT" });
  setIonShieldArcDraft({ P1: "FRONT", P2: "FRONT" });
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

  // ROTATE_ION_SHIELDS should be the only way to change the *active* shield arc.
  // Keep the draft selection synced to the current arc whenever the action is toggled.
  if (action === "ROTATE_ION_SHIELDS") {
    setIonShieldArcDraft((prev) => ({ ...prev, [player]: ionShieldArc[player] }));
  }

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
    ionShieldArc: { ...ionShieldArc },
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

  // Thread Ion Shield arc selection into the engine (if the action is chosen).
  (['P1', 'P2'] as PlayerId[]).forEach((p) => {
    if (plans[p].actions.includes("ROTATE_ION_SHIELDS")) {
      inputsWithDest[p].ROTATE_ION_SHIELDS = { arc: ionShieldArcDraft[p] };
    }
  });
  (['P1', 'P2'] as PlayerId[]).forEach((p) => {
    const advDest = moveDestinations[p].ADVANCE ?? undefined;
    const runDest = moveDestinations[p].RUN ?? undefined;
    const chgDest = moveDestinations[p].CHARGE ?? undefined;

    const advFacing = moveEndFacings[p].ADVANCE ?? undefined;
    const runFacing = moveEndFacings[p].RUN ?? undefined;
    const chgFacing = moveEndFacings[p].CHARGE ?? undefined;

    if (inputsWithDest[p].ADVANCE) inputsWithDest[p].ADVANCE = { ...inputsWithDest[p].ADVANCE, dest: advDest, endFacingDeg: advFacing };
    if (inputsWithDest[p].RUN) inputsWithDest[p].RUN = { ...inputsWithDest[p].RUN, dest: runDest, endFacingDeg: runFacing };
    if (inputsWithDest[p].CHARGE) {
      inputsWithDest[p].CHARGE = {
        ...inputsWithDest[p].CHARGE,
        move: { ...inputsWithDest[p].CHARGE!.move, dest: chgDest, endFacingDeg: chgFacing },
      };
    }
  });

  const events = executeTurnMutating(game, plans, inputsWithDest, rangeInches, weaponTargets);

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

  // Persist any updated Ion Shield arc.
  setIonShieldArc({ ...game.ionShieldArc });
  setIonShieldArcDraft({ ...game.ionShieldArc });

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

    if (e.kind === "ION") {
      const parts = e.players.map((p) => {
        const a = (e as any).arcByPlayer?.[p] as FacingArc | undefined;
        return `${p} rotated Ion Shield to ${arcShortLabel(a ?? "FRONT")}`;
      });
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

function lockOrders(player: PlayerId) {
  // Orders become hidden/locked by phase changes.
  setRevealLockedOrders(false);

  // Auto-lock loadouts after BOTH players lock orders on Turn 1.
  if (!loadoutLocked && turnNumber === 1 && player === "P2") {
    setLoadoutLocked(true);
  }

  if (player === "P1") {
    setPhase("PASS_TO_P2");
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

{screen === "MENU" ? (
  <StartMenu
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
        Mode: {gameMode === "TWO_PLAYER" ? "2 Player Automated" : gameMode}
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
    setScreen("MENU");
  }}
>
  Main Menu
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
    <h2 style={{ marginTop: 8 }}>Player 1: Choose orders</h2>
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
      ionShieldArc={ionShieldArcDraft.P1}
      onIonShieldArcChange={(next) => setIonShieldArcDraft((prev) => ({ ...prev, P1: next }))}

      mapSlot={
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div>
            <MapCanvas
              terrain={terrain}
              positions={positions}
              facings={facings}
              ionShieldArc={ionShieldArc}
              moveDestinations={moveDestinations}
              moveEndFacings={moveEndFacings}
              activeMoveMode={activeMoveMode}
              onSetActiveMoveMode={(p, m) => setActiveMoveMode((prev) => ({ ...prev, [p]: m }))}
              activePlayer={phase === "P1_ORDERS" ? "P1" : phase === "P2_ORDERS" ? "P2" : null}
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
                Default spawns: P1 (6,24) and P2 (42,24). Use the mode buttons on the map to set separate destinations for Advance / Run / Charge.
              </div>
            </div>
          </div>
        </div>
      }
      defaultTargetCellId={DEFAULT_TARGET_CELL_ID}
    />

    {!isNarrow ? (
      <div style={{ display: "flex", gap: 12, marginTop: 12, alignItems: "center" }}>
        <button onClick={() => lockOrders("P1")}>Lock P1 Orders</button>
        <div style={{ opacity: 0.7, fontSize: 13 }}>Pass the device to Player 2 after locking.</div>
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
            Lock P1 Orders
          </button>
          <div style={{ marginTop: 8, opacity: 0.75, fontSize: 13 }}>
            Pass the device to Player 2 after locking.
          </div>
        </div>
      </>
    )}
  </div>
)}

{activeTab === "PLAY" && phase === "PASS_TO_P2" && (
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

{activeTab === "PLAY" && phase === "P2_ORDERS" && (
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
      ionShieldArc={ionShieldArcDraft.P2}
      onIonShieldArcChange={(next) => setIonShieldArcDraft((prev) => ({ ...prev, P2: next }))}

      mapSlot={
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div>
            <MapCanvas
              terrain={terrain}
              positions={positions}
              facings={facings}
              ionShieldArc={ionShieldArc}
              moveDestinations={moveDestinations}
              moveEndFacings={moveEndFacings}
              activeMoveMode={activeMoveMode}
              onSetActiveMoveMode={(p, m) => setActiveMoveMode((prev) => ({ ...prev, [p]: m }))}
              activePlayer={phase === "P1_ORDERS" ? "P1" : phase === "P2_ORDERS" ? "P2" : null}
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
                Default spawns: P1 (6,24) and P2 (42,24). Use the mode buttons on the map to set separate destinations for Advance / Run / Charge.
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
        ionShieldArc={ionShieldArc}
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
              setScreen("MENU");
            }}
          >
            Main Menu
          </button>
        </>
      ) : (
        <button
          onClick={() => {
            setRevealLockedOrders(false);
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
                    background: live.criticallyDamaged ? "#FFEBEE" : baseFill,
                    boxShadow: hlOutline,
                    cursor: "pointer",
                    padding: 4,
                    opacity: live.criticallyDamaged ? 0.75 : 1,
                  }}
                  title={`${live.id} — ${comp} (Group ${live.group})`}
                >
                  <div style={{ fontSize: 11, opacity: 0.75 }}>{live.id}</div>
                  <div style={{ fontSize: 16, fontWeight: 800 }}>{live.group}</div>
                  <div style={{ fontSize: 10, opacity: 0.85 }}>{comp}</div>
                  <div style={{ fontSize: 12 }}>
                    {live.criticallyDamaged ? "CRIT" : `${live.armorPoints}/${live.maxArmorPoints}`}
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