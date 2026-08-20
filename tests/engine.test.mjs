import test from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis;
await import("../src/data.js");
await import("../src/engine.js");

const { data, engine } = globalThis.SGBU;

function playerTurnState() {
  const state = engine.makeInitialState(data);
  const actor = state.players[0];
  state.currentId = actor.instanceId;
  state.phase = "player";
  state.currentAp = 2;
  return { state, actor };
}

test("all three Basic ATKs cost one AP", () => {
  for (const kind of ["normal", "charged", "plunge"]) {
    const { state, actor } = playerTurnState();
    actor.sp = 100;
    actor.airborne = true;
    const result = engine.useBasic(state, kind, state.enemies[0].instanceId);
    assert.equal(result.ok, true);
    assert.equal(state.currentAp, 1);
  }
});

test("Skills require and consume two AP", () => {
  const { state, actor } = playerTurnState();
  actor.sp = 100;
  state.currentAp = 1;
  assert.equal(engine.useSkill(state, state.enemies[0].instanceId).ok, false);
  state.currentAp = 2;
  assert.equal(engine.useSkill(state, state.enemies[0].instanceId).ok, true);
  assert.notEqual(state.currentId, actor.instanceId);
});

test("switching is free and can occur only once in an inherited turn", () => {
  const { state } = playerTurnState();
  const reserve = state.players.find((unit) => !unit.onField);
  assert.equal(engine.switchUnits(state, reserve.instanceId).ok, true);
  assert.equal(state.currentAp, 2);
  const secondReserve = state.players.find((unit) => !unit.onField && unit.alive);
  assert.equal(engine.switchUnits(state, secondReserve.instanceId).ok, false);
});

test("a successful full parry banks one AP for every eligible target", () => {
  const state = engine.makeInitialState(data);
  const enemy = state.enemies[0];
  const targets = state.players.slice(0, 2);
  state.currentId = enemy.instanceId;
  state.phase = "defense";
  state.pendingDefense = { enemyId: enemy.instanceId, targetIds: targets.map((unit) => unit.instanceId), multiplier: 1 };
  engine.resolveDefense(state, "parry", true);
  assert.equal(targets[0].apBonus, 1);
  assert.equal(targets[1].apBonus, 1);
});

test("crowd-controlled allies cannot benefit from a parry", () => {
  const state = engine.makeInitialState(data);
  const enemy = state.enemies[0];
  const target = state.players[0];
  target.crowdControlled = true;
  const hp = target.hp;
  state.currentId = enemy.instanceId;
  state.phase = "defense";
  state.pendingDefense = { enemyId: enemy.instanceId, targetIds: [target.instanceId], multiplier: 1 };
  engine.resolveDefense(state, "parry", true);
  assert.equal(target.apBonus, 0);
  assert.ok(target.hp < hp);
});

test("front-column enemies protect rear targets", () => {
  const state = engine.makeInitialState(data);
  const rear = state.enemies.find((unit) => unit.lane === "rear" && unit.column === 2);
  assert.equal(engine.protectedRearTarget(state, rear), true);
  state.enemies.find((unit) => unit.lane === "front" && unit.column === 2).alive = false;
  assert.equal(engine.protectedRearTarget(state, rear), false);
});

