# SGBU Battle Lab

An offline-first, data-driven debug battle simulator for testing SGBU combat rules and character kits. The interface is intentionally minimal: blocks, menus, meters, logs, and formula inspection instead of animation-heavy presentation.

## Run locally

1. Install Node.js 20 or newer.
2. Open a terminal in this folder.
3. Run `npm start`.
4. Open `http://127.0.0.1:4173` in a browser.

No packages are downloaded and no internet connection is required. The app also works when `index.html` is opened directly, though the local server is more reliable across browsers.

## Implemented prototype rules

- Action Value controls the turn order.
- Natural player turns begin with 2 AP.
- Normal, Charged, and Plunging Basic ATKs cost 1 AP.
- Normal ATKs generate SP; Charged ATKs consume SP; Plunging ATKs require Above Ground.
- Skills cost 2 AP and personal SP.
- Ultimates cost 0 AP, consume Energy, generate SP, and can interrupt normal player/enemy ordering before a defense window opens.
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

The runtime panel can modify HP, SP, Energy, Action Value, Above Ground, and Crowd Control. It can also force CRITs and defense outcomes, fill Ultimates, bank AP, undo mutations, export the combat log, and edit all unit/rule data as JSON. Runtime edits persist in browser storage; the source defaults remain in `src/data.js`.

## Test

Run `npm test` to verify the baseline AP, switching, parry, crowd-control, and formation rules.

## Repository setup

This folder is ready to become a Git repository. If it is not already initialized:

```sh
git init
git add .
git commit -m "Build initial SGBU battle simulator"
```

Then create or choose a GitHub repository and add it as the `origin` remote.
