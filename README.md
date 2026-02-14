# Knight Commander (Core Questoris Test Harness)

This is a minimal Vite + React + TypeScript app that implements a tabletop-assisted rules companion for:
- Knight Commander (core Questoris)
- Canon weapon stats provided by you
- Canon Questoris location grid provided by you
- Canon critical damage effects provided by you
- Plan/Execute action selection + roll-offs
- Charge includes immediate melee attack after moving
- Auto-roll dice or manual dice entry for testing

## Run locally

1. Install Node.js (LTS).
2. In this folder:

```bash
npm install
npm run dev
```

Open the local URL Vite prints (usually http://localhost:5173).

## Testing notes

- Click cells on the grid to select target locations.
- Choose actions for both P1 and P2, set attack/charge inputs, then click "Execute Turn".
- The log prints steps and attack outcomes.
- Grid updates reflect armour points and critical damage.


## UI notes

- Two target grids are shown (P1 targets P2, P2 targets P1).
- Cells are colour-coded by component group and show a short component label.
- A faint silhouette is rendered behind the grid as an aiming aid.

- Targeting grid updated to the provided 7x6 layout.

- Silhouette overlay removed; grid uses colour-coding only.

- Scatter log now uses arrow characters: ← → ↑ ↓ (repeated for magnitude).


- Grid cell IDs follow the Knight Commander targeting grid convention: Letter = row (vertical), Number = column (horizontal).
