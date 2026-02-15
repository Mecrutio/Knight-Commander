import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Vec2 } from "./engine/execute-turn";
import type { TerrainPiece } from "./engine/terrain";
import type { FacingArc } from "./engine/facing-arcs";
import { resolveWeaponProfileForEquippedName, weaponAbilitiesShortLabel } from "./engine/core-weapons";
import type { MountedWeapon } from "./engine/criticals-core";

type PlayerId = "P1" | "P2";

export function MapCanvas({
  boardSizeInches = 48,
  renderScale = 0.5, // 2:1 render ratio (half distance)
  positions,
  facings,
  ionShieldEnabled,
  activePlayer,
  onSetDestination,
  onSetFacing,
  moveDestinations,
  moveEndFacings,
  activeMoveMode,
  onSetActiveMoveMode,
  visibleDestinations,
  showToolbar = true,
  showScanPanel = true,
  movementSegments,
  terrain,
  onSetMoveEndFacing,
  weaponsByPlayer,
  knightNames,
  maxMoveInches,
}: {
  boardSizeInches?: number;
  renderScale?: number;
  positions: Record<PlayerId, Vec2>;
  facings: Record<PlayerId, number>;
  // Ion Shields always protect the FRONT arc if enabled.
  ionShieldEnabled?: Record<PlayerId, boolean>;
  activePlayer: PlayerId | null;
  moveDestinations: Record<PlayerId, Record<"ADVANCE" | "RUN" | "CHARGE", Vec2 | null>>;
  moveEndFacings?: Record<PlayerId, Record<"ADVANCE" | "RUN" | "CHARGE", number | null>>;
  activeMoveMode: Record<PlayerId, "ADVANCE" | "RUN" | "CHARGE">;
  onSetActiveMoveMode: (player: PlayerId, mode: "ADVANCE" | "RUN" | "CHARGE") => void;
  onSetDestination: (player: PlayerId, mode: "ADVANCE" | "RUN" | "CHARGE", dest: Vec2) => void;
  onSetFacing?: (player: PlayerId, facingDeg: number) => void;
  onSetMoveEndFacing?: (player: PlayerId, mode: "ADVANCE" | "RUN" | "CHARGE", facingDegOrNull: number | null) => void;
  visibleDestinations?: Record<PlayerId, boolean>;
  showToolbar?: boolean;
  /** Show the Auspex Scan side panel. Disable for mobile summary views where it pushes the map off-screen. */
  showScanPanel?: boolean;
  movementSegments?: Record<PlayerId, { from: Vec2; to: Vec2 } | null>;
  terrain: TerrainPiece[];
  weaponsByPlayer?: Record<PlayerId, MountedWeapon[]>;
  knightNames?: Record<PlayerId, string>;
  /** Max legal move distance for each player and move mode (in inches). Used to show a max-distance ring while plotting. */
  maxMoveInches?: Record<PlayerId, Record<"ADVANCE" | "RUN" | "CHARGE", number>>;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Tooltip/inspection UI: hover (mouse) + tap to pin (touch)
  const [hoverInspect, setHoverInspect] = useState<{ player: PlayerId; sx: number; sy: number } | null>(null);
  const [pinnedInspect, setPinnedInspect] = useState<{ player: PlayerId; sx: number; sy: number } | null>(null);

  const [interactionMode, setInteractionMode] = useState<"MOVE" | "FACE" | "END_FACE">("MOVE");

  // Facing conventions: degrees where 0° is +X (east), increasing clockwise (because Y increases downward).
  const normDeg = (d: number) => ((d % 360) + 360) % 360;
  const degToRad = (d: number) => (d * Math.PI) / 180;
  const radToDeg = (r: number) => (r * 180) / Math.PI;
  const bearingDeg = (from: Vec2, to: Vec2) => normDeg(radToDeg(Math.atan2(to.y - from.y, to.x - from.x)));

  const dist = (a: Vec2, b: Vec2) => {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const snapToWholeInches = (p: Vec2): Vec2 => ({ x: Math.round(p.x), y: Math.round(p.y) });

  const moveTowards = (from: Vec2, to: Vec2, maxDist: number): Vec2 => {
    const d = dist(from, to);
    if (d <= 1e-6) return { ...from };
    if (maxDist >= d) return { ...to };
    const t = maxDist / d;
    return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
  };

  const startPointForMode = (p: PlayerId, mode: "ADVANCE" | "RUN" | "CHARGE"): Vec2 => {
    if (mode === "ADVANCE") return positions[p];
    if (mode === "RUN") return moveDestinations[p].ADVANCE ?? positions[p];
    return moveDestinations[p].RUN ?? moveDestinations[p].ADVANCE ?? positions[p];
  };

  const relativeArc = (origin: Vec2, facingDeg: number, point: Vec2): FacingArc => {
    const b = bearingDeg(origin, point);
    let d = normDeg(b - facingDeg);
    if (d > 180) d -= 360; // [-180, 180]
    const ad = Math.abs(d);
    if (ad <= 45) return "FRONT";
    if (ad >= 135) return "REAR";
    return d > 0 ? "RIGHT" : "LEFT";
  };

  const pxPerInch = useMemo(() => {
    const basePx = 720; // tuned to fit comfortably in the HUD layout
    return (basePx / boardSizeInches) * renderScale;
  }, [boardSizeInches, renderScale]);

  const boardPx = useMemo(() => Math.round(boardSizeInches * pxPerInch), [boardSizeInches, pxPerInch]);

  const toScreen = (p: Vec2) => ({ x: p.x * pxPerInch, y: p.y * pxPerInch });
  const toWorld = (sx: number, sy: number): Vec2 => ({ x: sx / pxPerInch, y: sy / pxPerInch });

  const pickKnightAtScreen = (sx: number, sy: number): PlayerId | null => {
    const r = 14; // slightly larger than the drawn token
    for (const p of ["P1", "P2"] as PlayerId[]) {
      const s = toScreen(positions[p]);
      if (Math.hypot(sx - s.x, sy - s.y) <= r) return p;
    }
    return null;
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = boardPx;
    canvas.height = boardPx;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Background
    ctx.fillStyle = "#0d0f14";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Terrain
    // HARD: blocks movement + LOS
    // SOFT: blocks movement, but allows attacks through (Obscured)
    for (const t of terrain) {
      ctx.save();
      ctx.fillStyle = t.type === "HARD" ? "rgba(255,80,80,0.22)" : "rgba(160,200,255,0.18)";
      ctx.strokeStyle = t.type === "HARD" ? "rgba(255,80,80,0.45)" : "rgba(160,200,255,0.40)";
      ctx.lineWidth = 2;
      for (const r of t.rects) {
        const p = toScreen({ x: r.x, y: r.y });
        const w = r.w * pxPerInch;
        const h = r.h * pxPerInch;
        ctx.fillRect(p.x, p.y, w, h);
        ctx.strokeRect(p.x, p.y, w, h);
      }
      ctx.restore();
    }

    // Grid (1" tiles)
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    const step = pxPerInch;
    for (let x = 0; x <= canvas.width; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
    }
    for (let y = 0; y <= canvas.height; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }

    // Center lines
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.beginPath();
    ctx.moveTo(canvas.width / 2, 0);
    ctx.lineTo(canvas.width / 2, canvas.height);
    ctx.stroke();

    // Small Manhattan pathfinder so movement trails don't misleadingly "cut through" impassable cover.
    // This is intentionally lightweight (board is 48"×48" and we only compute for 0–2 segments).
    const isBlockedWhole = (x: number, y: number): boolean => {
      if (x < 0 || y < 0 || x > boardSizeInches || y > boardSizeInches) return true;
      for (const t of terrain) {
        for (const r of t.rects) {
          if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return true;
        }
      }
      return false;
    };

    const findPathManhattan = (start0: Vec2, goal0: Vec2): Vec2[] | null => {
      const s = snapToWholeInches(start0);
      const g = snapToWholeInches(goal0);
      if (isBlockedWhole(s.x, s.y) || isBlockedWhole(g.x, g.y)) return null;
      if (s.x === g.x && s.y === g.y) return [s];

      const key = (x: number, y: number) => `${x},${y}`;
      const q: Array<{ x: number; y: number }> = [{ x: s.x, y: s.y }];
      const prev = new Map<string, string>();
      const seen = new Set<string>([key(s.x, s.y)]);

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
          if (isBlockedWhole(nx, ny)) continue;
          prev.set(k, key(cur.x, cur.y));
          if (nx === g.x && ny === g.y) {
            const out: Vec2[] = [{ x: g.x, y: g.y }];
            let back = key(g.x, g.y);
            while (prev.has(back)) {
              const p = prev.get(back)!;
              const [px, py] = p.split(",").map(Number);
              out.push({ x: px, y: py });
              back = p;
              if (px === s.x && py === s.y) break;
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

    // End-of-turn movement segments (net movement this turn), if provided.
    if (movementSegments) {
      for (const p of ["P1", "P2"] as PlayerId[]) {
        const seg = movementSegments[p];
        if (!seg) continue;
        const path = findPathManhattan(seg.from, seg.to);
        ctx.setLineDash([]);
        ctx.strokeStyle = p === "P1" ? "rgba(0,200,255,0.55)" : "rgba(255,180,0,0.55)";
        ctx.lineWidth = 4;
        ctx.beginPath();

        if (path && path.length >= 2) {
          const s0 = toScreen(path[0]);
          ctx.moveTo(s0.x, s0.y);
          for (let i = 1; i < path.length; i++) {
            const s = toScreen(path[i]);
            ctx.lineTo(s.x, s.y);
          }
        } else {
          const a = toScreen(seg.from);
          const b = toScreen(seg.to);
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
        }
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    }
    ctx.beginPath();
    ctx.moveTo(0, canvas.height / 2);
    ctx.lineTo(canvas.width, canvas.height / 2);
    ctx.stroke();

    // While plotting movement for the active player, show a "max distance" ring.
    if (activePlayer && (interactionMode === "MOVE" || interactionMode === "END_FACE")) {
      const mode = activeMoveMode[activePlayer] ?? "ADVANCE";
      const max = maxMoveInches?.[activePlayer]?.[mode];
      if (typeof max === "number" && Number.isFinite(max) && max > 0) {
        const sp = startPointForMode(activePlayer, mode);
        const c = toScreen(sp);
        const rpx = max * pxPerInch;
        ctx.save();
        ctx.beginPath();
        ctx.arc(c.x, c.y, rpx, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.05)";
        ctx.strokeStyle = "rgba(255,255,255,0.28)";
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 6]);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }

    const drawFacingArrowAt = (at: { x: number; y: number }, facingDeg: number, baseRgb: string) => {
      const fr = degToRad(facingDeg);
      const len = 18;
      const head = 7;
      const ax = at.x + Math.cos(fr) * len;
      const ay = at.y + Math.sin(fr) * len;
      ctx.save();
      ctx.strokeStyle = `rgba(${baseRgb},0.92)`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(at.x, at.y);
      ctx.lineTo(ax, ay);
      ctx.stroke();

      // Arrow head
      const a1 = fr + 2.6;
      const a2 = fr - 2.6;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax + Math.cos(a1) * head, ay + Math.sin(a1) * head);
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax + Math.cos(a2) * head, ay + Math.sin(a2) * head);
      ctx.stroke();

      // Label
      ctx.font = "10px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.fillText("F", ax + 4, ay + 3);
      ctx.restore();
    };

    // Destinations (planned) — separate points for Advance / Run.
    // Charge is automatic at the Charge step and does not use a plotted destination.
    const modes = ["ADVANCE", "RUN"] as const;
    const modeLabel: Record<typeof modes[number], string> = { ADVANCE: "A", RUN: "R" };

    for (const p of ["P1", "P2"] as PlayerId[]) {
      // Privacy: optionally hide a player's planned destinations (but still show their model position).
      if (visibleDestinations && visibleDestinations[p] === false) {
        continue;
      }
      for (const mode of modes) {
        const dest = moveDestinations[p][mode];
        if (!dest) continue;
        const startPoint = (mode === "ADVANCE")
          ? positions[p]
          : (moveDestinations[p].ADVANCE ?? positions[p]);
        const a = toScreen(startPoint);
        const b = toScreen(dest);

        // dash patterns to differentiate modes without needing extra legend colors
        if (mode === "ADVANCE") ctx.setLineDash([]);
        if (mode === "RUN") ctx.setLineDash([6, 4]);

        ctx.strokeStyle = p === "P1" ? "rgba(0,200,255,0.7)" : "rgba(255,180,0,0.7)";
        ctx.fillStyle = ctx.strokeStyle;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();

        // marker
        ctx.beginPath();
        ctx.arc(b.x, b.y, 6, 0, Math.PI * 2);
        ctx.fill();

        // label A/R/C
        ctx.setLineDash([]);
        ctx.font = "11px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
        ctx.fillStyle = "rgba(255,255,255,0.95)";
        ctx.fillText(modeLabel[mode], b.x - 3, b.y + 4);

        // If an end-facing has been plotted for this move mode, show it as a small arrow.
        const ef = moveEndFacings?.[p]?.[mode];
        if (typeof ef === "number" && Number.isFinite(ef)) {
          const baseRgb = p === "P1" ? "0,200,255" : "255,180,0";
          drawFacingArrowAt(b, ef, baseRgb);
        }

        ctx.lineWidth = 1;
      }
      ctx.setLineDash([]);
    }

    // Facing arcs (front/left/right/rear).
    const drawFacingArcs = (p: PlayerId) => {
      const s = toScreen(positions[p]);
      const facing = facings[p] ?? 0;
      const r = 30;
      const fr = degToRad(facing);
      const isActive = activePlayer === p;

      const base = p === "P1" ? "0,200,255" : "255,180,0";
      const fill = (a: number) => `rgba(${base},${a})`;

      // Quadrants around facing: front (±45°), right, rear, left
      const wedges: Array<{ start: number; end: number; alpha: number }> = [
        { start: fr - Math.PI / 4, end: fr + Math.PI / 4, alpha: isActive ? 0.22 : 0.14 }, // FRONT
        { start: fr + Math.PI / 4, end: fr + (3 * Math.PI) / 4, alpha: isActive ? 0.14 : 0.09 }, // RIGHT
        { start: fr + (3 * Math.PI) / 4, end: fr + (5 * Math.PI) / 4, alpha: isActive ? 0.10 : 0.06 }, // REAR
        { start: fr + (5 * Math.PI) / 4, end: fr + (7 * Math.PI) / 4, alpha: isActive ? 0.14 : 0.09 }, // LEFT
      ];

      for (const w of wedges) {
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.arc(s.x, s.y, r, w.start, w.end);
        ctx.closePath();
        ctx.fillStyle = fill(w.alpha);
        ctx.fill();
      }

      // Highlight the Ion Shield protected arc (always FRONT when enabled).
      if (ionShieldEnabled?.[p]) {
        const w = wedges[0];
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.arc(s.x, s.y, r, w.start, w.end);
        ctx.closePath();
        // Stronger fill + crisp outline to make the protected arc obvious.
        ctx.fillStyle = fill(isActive ? 0.36 : 0.28);
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.65)";
        ctx.lineWidth = 2;
        ctx.stroke();

        // Small shield marker near the middle of the protected arc.
        const mid = (w.start + w.end) / 2;
        const tx = s.x + Math.cos(mid) * (r + 12);
        const ty = s.y + Math.sin(mid) * (r + 12);
        ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.fillText("🛡", tx - 6, ty + 5);
        ctx.restore();
      }

      // Boundary lines and forward arrow
      ctx.save();
      ctx.strokeStyle = isActive ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.30)";
      ctx.lineWidth = 1;
      const rays = [fr - Math.PI / 4, fr + Math.PI / 4, fr + (3 * Math.PI) / 4, fr + (5 * Math.PI) / 4];
      for (const ang of rays) {
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x + Math.cos(ang) * r, s.y + Math.sin(ang) * r);
        ctx.stroke();
      }
      // forward arrow
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x + Math.cos(fr) * (r + 10), s.y + Math.sin(fr) * (r + 10));
      ctx.stroke();
      ctx.restore();
    };

    drawFacingArcs("P1");
    drawFacingArcs("P2");

    // Units
    const drawUnit = (p: PlayerId) => {
      const s = toScreen(positions[p]);
      const isActive = activePlayer === p;
      ctx.fillStyle = p === "P1" ? "#00c8ff" : "#ffb400";
      ctx.strokeStyle = isActive ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.35)";
      ctx.lineWidth = isActive ? 3 : 2;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fillText(p, s.x + 12, s.y - 12);
    };
    drawUnit("P1");
    drawUnit("P2");

    // Range label
    const dx = positions.P1.x - positions.P2.x;
    const dy = positions.P1.y - positions.P2.y;
    const r = Math.sqrt(dx * dx + dy * dy);
    ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillText(`Range: ${Math.round(r)}"`, 10, 18);
    const p1Arc = relativeArc(positions.P1, facings.P1 ?? 0, positions.P2);
    const p2Arc = relativeArc(positions.P2, facings.P2 ?? 0, positions.P1);
    ctx.fillText(`Arc: P1→P2 ${p1Arc} | P2→P1 ${p2Arc}`, 10, 34);
  }, [boardPx, boardSizeInches, pxPerInch, positions, facings, ionShieldEnabled, moveDestinations, moveEndFacings, activePlayer, visibleDestinations, movementSegments, terrain, interactionMode, activeMoveMode, maxMoveInches]);

  const handlePointerDown: React.PointerEventHandler<HTMLCanvasElement> = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    // Mobile QoL: tap a knight to pin an inspection readout (without plotting a destination).
    // If a readout is pinned, tapping elsewhere dismisses it first.
    if (e.pointerType === "touch") {
      const hit = pickKnightAtScreen(sx, sy);
      if (pinnedInspect && !hit) {
        setPinnedInspect(null);
        return;
      }
      if (hit) {
        setPinnedInspect((prev) => (prev?.player === hit ? null : { player: hit, sx, sy }));
        return;
      }
    }

    if (!activePlayer) return;
    const w = toWorld(sx, sy);

    const clamped: Vec2 = {
      x: Math.round(Math.max(0, Math.min(boardSizeInches, w.x))),
      y: Math.round(Math.max(0, Math.min(boardSizeInches, w.y))),
    };

    // Clamp to board
    // Treat the map as a 1" grid (1 tile = 1 inch). Snap destinations to whole inches
    // so measured ranges remain whole inches as well.
    // If in facing mode, set facing based on click direction from the active unit.
    if (interactionMode === "FACE" && onSetFacing) {
      const origin = positions[activePlayer];
      const ang = bearingDeg(origin, clamped);
      onSetFacing(activePlayer, ang);
      return;
    }

    // If in end-facing mode, set the *post-move* facing for the currently selected move mode.
    if (interactionMode === "END_FACE" && onSetMoveEndFacing) {
      const mode = activeMoveMode[activePlayer] ?? "ADVANCE";
      const origin = moveDestinations[activePlayer][mode] ?? positions[activePlayer];
      const ang = bearingDeg(origin, clamped);
      onSetMoveEndFacing(activePlayer, mode, ang);
      return;
    }
    let mode = activeMoveMode[activePlayer] ?? "RUN";
    // Charge is automatic at the Charge step and does not use a plotted destination.
    if (mode === "CHARGE") mode = "RUN";

    // UI-only enforcement: keep the plotted destination within this turn's max movement.
    const max = maxMoveInches?.[activePlayer]?.[mode];
    let dest = clamped;
    if (typeof max === "number" && Number.isFinite(max) && max >= 0) {
      const sp = startPointForMode(activePlayer, mode);
      if (dist(sp, dest) > max) dest = moveTowards(sp, dest, max);
    }

    onSetDestination(activePlayer, mode, snapToWholeInches(dest));
  };

  const handlePointerMove: React.PointerEventHandler<HTMLCanvasElement> = (e) => {
    if (pinnedInspect) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const hit = pickKnightAtScreen(sx, sy);
    if (!hit) {
      setHoverInspect(null);
      return;
    }
    // Only show hover tooltip for mouse/pen. Touch is handled by pin-on-tap.
    if (e.pointerType === "mouse" || e.pointerType === "pen") {
      setHoverInspect({ player: hit, sx, sy });
    }
  };

  const handlePointerLeave: React.PointerEventHandler<HTMLCanvasElement> = () => {
    if (pinnedInspect) return;
    setHoverInspect(null);
  };

  const activeInspect = pinnedInspect ?? hoverInspect;
  const inspectedWeapons = activeInspect && weaponsByPlayer ? weaponsByPlayer[activeInspect.player] ?? [] : [];
  const inspectedShield =
    activeInspect
      ? ionShieldEnabled?.[activeInspect.player]
        ? "Front"
        : "Offline"
      : undefined;

  const mountLabel: Record<string, string> = {
    CARAPACE: "Carapace",
    TORSO: "Torso",
    ARM_LEFT: "Left arm",
    ARM_RIGHT: "Right arm",
    OTHER: "Other",
  };

  const weaponsByMount = useMemo(() => {
    if (!activeInspect) return null;
    const out: Record<string, string[]> = { CARAPACE: [], TORSO: [], ARM_LEFT: [], ARM_RIGHT: [], OTHER: [] };
    for (const w of inspectedWeapons) {
      const prof = resolveWeaponProfileForEquippedName(w.name, boardSizeInches);
      const abil = weaponAbilitiesShortLabel(prof);
      const label = w.name + (abil ? " (" + abil + ")" : "") + (w.disabled ? " (disabled)" : "");
      (out[w.mount] ?? (out[w.mount] = [])).push(label);
    }
    return out;
  }, [activeInspect, inspectedWeapons, boardSizeInches]);

  const activeMode = activePlayer ? (activeMoveMode[activePlayer] ?? "ADVANCE") : null;
  const activeMax = activeMode && activePlayer ? maxMoveInches?.[activePlayer]?.[activeMode] : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {/*
        Mode selector is intentionally rendered *outside* the canvas and with a visible container.
        Some layouts wrap/collapse inline toolbars; this keeps the buttons reliably visible.
      */}
      {showToolbar && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            flexWrap: "wrap",
            padding: "8px 10px",
            borderRadius: 10,
            border: "1px solid rgba(255,255,255,0.14)",
            background: "rgba(0,0,0,0.22)",
          }}
        >
          <div style={{ fontSize: 12, opacity: 0.9 }}>
            <b>Map</b> 48×48" (rendered 2:1) — click sets <b>{activePlayer ?? "—"}</b>'s{" "}
            {interactionMode === "FACE" ? (
              <b>facing</b>
            ) : interactionMode === "END_FACE" ? (
              <>
                <b>end-facing</b> after <b>{activeMoveMode[activePlayer ?? "P1"]}</b>
              </>
            ) : (
              <>
                <b>{activeMoveMode[activePlayer ?? "P1"]}</b>
                {interactionMode === "MOVE" && typeof activeMax === "number" && Number.isFinite(activeMax) && (
                  <span style={{ opacity: 0.95 }}>
                    {" "}— max {activeMax.toFixed(0)}"
                  </span>
                )}
              </>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <button
              disabled={!activePlayer}
              onClick={() => setInteractionMode("MOVE")}
              style={{
                padding: "6px 10px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.20)",
                background: interactionMode === "MOVE" ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.08)",
                color: "rgba(255,255,255,0.94)",
                fontWeight: 800,
                cursor: activePlayer ? "pointer" : "not-allowed",
              }}
              title="Move plotting"
            >
              Move
            </button>

            <button
              disabled={!activePlayer || !onSetFacing}
              onClick={() => setInteractionMode("FACE")}
              style={{
                padding: "6px 10px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.20)",
                background: interactionMode === "FACE" ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.08)",
                color: "rgba(255,255,255,0.94)",
                fontWeight: 800,
                cursor: activePlayer && onSetFacing ? "pointer" : "not-allowed",
              }}
              title="Facing mode (tap map to set facing)"
            >
              Facing
            </button>

            <button
              disabled={!activePlayer || !onSetMoveEndFacing}
              onClick={() => setInteractionMode("END_FACE")}
              style={{
                padding: "6px 10px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.20)",
                background: interactionMode === "END_FACE" ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.08)",
                color: "rgba(255,255,255,0.94)",
                fontWeight: 800,
                cursor: activePlayer && onSetMoveEndFacing ? "pointer" : "not-allowed",
              }}
              title="End-facing mode (tap map to set facing after the selected move)"
            >
              End Facing
            </button>

            {(interactionMode === "MOVE" || interactionMode === "END_FACE") && (
              <>
                {(["ADVANCE", "RUN"] as const).map((m) => {
                  const isOn = activePlayer ? activeMoveMode[activePlayer] === m : false;
                  return (
                    <button
                      key={m}
                      disabled={!activePlayer}
                      onClick={() => activePlayer && onSetActiveMoveMode(activePlayer, m)}
                      style={{
                        padding: "6px 10px",
                        borderRadius: 10,
                        border: "1px solid rgba(255,255,255,0.20)",
                        background: isOn ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.08)",
                        color: "rgba(255,255,255,0.94)",
                        fontWeight: 800,
                        cursor: activePlayer ? "pointer" : "not-allowed",
                      }}
                      title={m}
                    >
                      {m === "ADVANCE" ? "Advance" : "Run"}
                    </button>
                  );
                })}
              </>
            )}

            {interactionMode === "FACE" && (
              <>
                <button
                  disabled={!activePlayer || !onSetFacing}
                  onClick={() => {
                    if (!activePlayer || !onSetFacing) return;
                    onSetFacing(activePlayer, normDeg((facings[activePlayer] ?? 0) - 45));
                  }}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 10,
                    border: "1px solid rgba(255,255,255,0.20)",
                    background: "rgba(255,255,255,0.08)",
                    color: "rgba(255,255,255,0.94)",
                    fontWeight: 900,
                    cursor: activePlayer && onSetFacing ? "pointer" : "not-allowed",
                  }}
                  title="Rotate -45°"
                >
                  ⟲ 45°
                </button>
                <button
                  disabled={!activePlayer || !onSetFacing}
                  onClick={() => {
                    if (!activePlayer || !onSetFacing) return;
                    onSetFacing(activePlayer, normDeg((facings[activePlayer] ?? 0) + 45));
                  }}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 10,
                    border: "1px solid rgba(255,255,255,0.20)",
                    background: "rgba(255,255,255,0.08)",
                    color: "rgba(255,255,255,0.94)",
                    fontWeight: 900,
                    cursor: activePlayer && onSetFacing ? "pointer" : "not-allowed",
                  }}
                  title="Rotate +45°"
                >
                  45° ⟳
                </button>
              </>
            )}

            {interactionMode === "END_FACE" && (
              <>
                <button
                  disabled={!activePlayer || !onSetMoveEndFacing}
                  onClick={() => {
                    if (!activePlayer || !onSetMoveEndFacing) return;
                    const mode = activeMoveMode[activePlayer] ?? "ADVANCE";
                    onSetMoveEndFacing(activePlayer, mode, null);
                  }}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 10,
                    border: "1px solid rgba(255,255,255,0.20)",
                    background: "rgba(255,255,255,0.08)",
                    color: "rgba(255,255,255,0.94)",
                    fontWeight: 900,
                    cursor: activePlayer && onSetMoveEndFacing ? "pointer" : "not-allowed",
                  }}
                  title="Clear end-facing (use auto-face along movement)"
                >
                  Auto
                </button>
                <button
                  disabled={!activePlayer || !onSetMoveEndFacing}
                  onClick={() => {
                    if (!activePlayer || !onSetMoveEndFacing) return;
                    const mode = activeMoveMode[activePlayer] ?? "ADVANCE";
                    const base = moveEndFacings?.[activePlayer]?.[mode] ?? facings[activePlayer] ?? 0;
                    onSetMoveEndFacing(activePlayer, mode, normDeg(base - 45));
                  }}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 10,
                    border: "1px solid rgba(255,255,255,0.20)",
                    background: "rgba(255,255,255,0.08)",
                    color: "rgba(255,255,255,0.94)",
                    fontWeight: 900,
                    cursor: activePlayer && onSetMoveEndFacing ? "pointer" : "not-allowed",
                  }}
                  title="Rotate end-facing -45°"
                >
                  ⟲ 45°
                </button>
                <button
                  disabled={!activePlayer || !onSetMoveEndFacing}
                  onClick={() => {
                    if (!activePlayer || !onSetMoveEndFacing) return;
                    const mode = activeMoveMode[activePlayer] ?? "ADVANCE";
                    const base = moveEndFacings?.[activePlayer]?.[mode] ?? facings[activePlayer] ?? 0;
                    onSetMoveEndFacing(activePlayer, mode, normDeg(base + 45));
                  }}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 10,
                    border: "1px solid rgba(255,255,255,0.20)",
                    background: "rgba(255,255,255,0.08)",
                    color: "rgba(255,255,255,0.94)",
                    fontWeight: 900,
                    cursor: activePlayer && onSetMoveEndFacing ? "pointer" : "not-allowed",
                  }}
                  title="Rotate end-facing +45°"
                >
                  45° ⟳
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {/* Map + Auspex Scan: keep the scan panel to the right. If the viewport is too narrow,
          allow horizontal scrolling rather than wrapping the panel below the map. */}
      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "flex-start",
          flexWrap: "nowrap",
          overflowX: showScanPanel ? "auto" : "hidden",
          maxWidth: "100%",
          paddingBottom: 6,
          WebkitOverflowScrolling: "touch",
          justifyContent: showScanPanel ? "flex-start" : "center",
        }}
      >
        <div style={{ position: "relative", width: boardPx, height: boardPx }}>
          <canvas
            ref={canvasRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerLeave={handlePointerLeave}
            style={{
              width: boardPx,
              height: boardPx,
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.18)",
              touchAction: "none",
              display: "block",
            }}
          />
        </div>

        {showScanPanel && (
          <div
            style={{
              width: 280,
              flex: "0 0 280px",
              padding: "10px 10px",
              borderRadius: 12,
              background: "rgba(0,0,0,0.42)",
              border: "1px solid rgba(255,255,255,0.14)",
              color: "rgba(255,255,255,0.92)",
              backdropFilter: "blur(6px)",
              boxShadow: "0 10px 24px rgba(0,0,0,0.25)",
              minHeight: 180,
            }}
          >
            <div style={{ fontWeight: 900, fontSize: 13, opacity: 0.95 }}>Auspex Scan</div>

            {!activeInspect || !weaponsByMount ? (
              <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75, lineHeight: 1.35 }}>
                Hover (mouse) or tap (touch) a knight token to scan its loadout.
              </div>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginTop: 10 }}>
                  <div style={{ fontWeight: 900, fontSize: 13 }}>
                    {activeInspect.player}
                    {knightNames?.[activeInspect.player] ? ` — ${knightNames?.[activeInspect.player]}` : ""}
                  </div>
                  {inspectedShield && (
                    <div style={{ fontSize: 12, opacity: 0.85 }} title="Ion Shield status">
                      🛡 {inspectedShield}
                    </div>
                  )}
                </div>

                <div style={{ marginTop: 8, fontSize: 12, opacity: 0.9, fontWeight: 800 }}>Weapons</div>
                <div style={{ fontSize: 12, lineHeight: 1.25, marginTop: 6 }}>
                  {(["CARAPACE", "TORSO", "ARM_LEFT", "ARM_RIGHT", "OTHER"] as const).map((m) => {
                    const list = (weaponsByMount as any)[m] as string[];
                    if (!list || list.length === 0) return null;
                    return (
                      <div key={m} style={{ marginTop: 6 }}>
                        <div style={{ fontWeight: 800, opacity: 0.9 }}>{mountLabel[m]}</div>
                        <div style={{ opacity: 0.92 }}>
                          {list.map((w, i) => (
                            <div key={i} style={{ paddingLeft: 10 }}>
                              • {w}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                  {inspectedWeapons.length === 0 && <div style={{ opacity: 0.8 }}>(No weapons)</div>}
                </div>

                {pinnedInspect && (
                  <div style={{ marginTop: 10, fontSize: 11, opacity: 0.7 }}>
                    Tap empty map space to dismiss.
                  </div>
                )}
              </>
            )}
          </div>
        )}
	      </div>
	    </div>
  );
}
