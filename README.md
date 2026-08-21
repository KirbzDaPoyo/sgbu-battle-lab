# SGBU Battle Lab

An offline-first, data-driven debug battle simulator for testing SGBU combat rules and character kits. The interface is intentionally minimal: blocks, menus, meters, logs, and formula inspection instead of animation-heavy presentation.

## Run locally

1. Install Node.js 20 or newer.
2. Open a terminal in this folder.
3. Run `npm start`.
4. Open `http://127.0.0.1:4173` in a browser.
5. Configure the field team, enemies, seed, and common rules, then select **Start battle**.

No packages are downloaded and no internet connection is required. The app also works when `index.html` is opened directly, though the local server is more reliable across browsers.

## Implemented prototype rules

- A pre-battle setup screen keeps the timeline paused until the encounter is explicitly started.
- The default setup starts every ally at maximum SP (100) and 50% of that ally's maximum Energy.
- The default defense meter lasts 1500 ms and applies a 0.2 parry-window scale.
- Action Value controls the turn order.
- Natural player turns begin with 2 AP.
- Normal, Charged, and Plunging Basic ATKs cost 1 AP.
- Normal ATKs generate SP; Charged ATKs consume 50 SP; Plunging ATKs require Above Ground.
- Generic prototype Skills cost 2 AP and 50 personal SP by default; individual unit costs remain data-driven.
- Basic ATKs and Skills show a target-and-cost confirmation before they resolve.
- Ultimates cost 0 AP, consume Energy, generate SP, and resolve immediately once selected; their descriptions are visible on the action strip.
- Explicit Ultimate windows pause the simulator before the first turn, between AP actions, after a player turn has been finalized, and after enemy actions. Action advance therefore affects the ally whose turn just ended.
- Switching is free, transfers the remaining sequence to the incoming reserve, and can happen only once in that sequence.
- A successful full parry banks +1 AP for each eligible targeted ally's next turn.
- A single dodge/parry input resolves multi-target enemy attacks.
- Crowd-controlled allies cannot dodge or parry.
- Rear enemies are protected while a living front enemy occupies the same column.
- Lane attacks currently affect only the selected front or rear lane.
- Defeated on-field allies require immediate replacement when a living reserve exists.

## Generic roster

- Vanguard / Dreadnought — durable attacker
- Striker / Hunter — single-target attacker
- Sweeper / Blaster — lane-wide attacker
- Amplifier / Supporter — offensive support
- Suppressor / Hexer — debuff specialist
- Defender / Protector — team shielder
- Healer / Medic — restorative support

## Debugging

The runtime panel can modify HP, SP, Energy, Action Value, Above Ground, and Crowd Control. It can also force CRITs and defense outcomes, fill Ultimates, bank AP, undo mutations, return to encounter setup while preserving personal SP and Energy, fully reset the battle back to default setup, export the combat log, and edit validated unit/rule data as JSON. Runtime data edits persist in browser storage; the source defaults remain in `src/data.js`.

## Test

Run `npm test` to verify AP and personal resources, Ultimate windows, switching, dodge/parry, crowd control, targeting, reserve replacement, encounter carryover, deterministic results, and runtime-data validation.

## Repository setup

This folder is ready to become a Git repository. If it is not already initialized:

```sh
git init
git add .
git commit -m "Build initial SGBU battle simulator"
```

Then create or choose a GitHub repository and add it as the `origin` remote.
