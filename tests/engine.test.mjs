import test from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis;
await import("../src/data.js");
await import("../src/engine.js");

const { data, engine } = globalThis.SGBU;

function playerTurnState(index = 0) {
  const state = engine.makeInitialState(data);
  const actor = state.players[index];
  state.currentId = actor.instanceId;
  state.phase = "player";
  state.currentAp = state.config.baseAp;
  state.switchUsed = false;
  return { state, actor };
}

function defenseState(targets) {
  const state = engine.makeInitialState(data);
  const enemy = state.enemies[0];
  state.currentId = enemy.instanceId;
  state.phase = "defense";
  state.pendingDefense = {
    enemyId: enemy.instanceId,
    targetIds: targets(state).map((unit) => unit.instanceId),
    multiplier: 1,
  };
  return { state, enemy };
}

test("encounters can remain in setup until explicitly started", () => {
  const state = engine.makeInitialState(data, { autoStart: false, seed: 90210 });

  assert.equal(state.phase, "setup");
  assert.equal(state.turn, 0);
  assert.equal(state.currentId, null);
  assert.equal(state.currentAp, 0);
  assert.equal(state.seed, 90210);

  assert.equal(engine.startBattle(state).ok, true);
  assert.equal(state.phase, "interrupt");
  assert.equal(state.turn, 0);
  assert.equal(state.currentId, null);
  assert.equal(engine.startBattle(state).ok, false);

  assert.equal(engine.continueBattle(state).ok, true);
  assert.equal(state.turn, 1);
  assert.ok(state.currentId);
});

test("default personal resources start at maximum SP and configured Energy percentage", () => {
  const state = engine.makeInitialState(data, { autoStart: false });

  state.players.forEach((unit) => {
    assert.equal(unit.sp, unit.maxSp);
    assert.equal(unit.energy, Math.round(unit.maxEnergy * data.config.initialEnergyPercent / 100));
  });
  assert.equal(state.config.defenseDurationMs, 1500);
  assert.equal(state.config.parryWindowScale, 0.2);
  assert.equal(state.config.chargedSpCost, 50);
  assert.ok(state.players.every((unit) => unit.skill.spCost === 50));
});

test("the pre-turn Ultimate window permits action advance before the timeline starts", () => {
  const state = engine.makeInitialState(data, { autoStart: false });
  const relay = state.players.find((unit) => unit.id === "supporter");
  relay.energy = relay.maxEnergy;
  const avBefore = state.players.filter((unit) => unit.onField).map((unit) => unit.av);

  assert.equal(engine.startBattle(state).ok, true);
  assert.equal(engine.useUltimate(state, relay.instanceId, state.enemies[0].instanceId).ok, true);
  assert.equal(state.phase, "interrupt");
  assert.ok(state.players.filter((unit) => unit.onField).every((unit, index) => unit.av < avBefore[index]));

  assert.equal(engine.continueBattle(state).ok, true);
  assert.equal(state.turn, 1);
});
test("natural player turns begin with the configured base AP", () => {
  const state = engine.makeInitialState(data);
  state.currentId = null;
  state.phase = "ready";
  state.players.forEach((unit) => { unit.av = 100; });
  state.enemies.forEach((unit) => { unit.av = 100; });
  state.players[0].av = 0;

  const actor = engine.advanceTimeline(state);

  assert.equal(actor.instanceId, state.players[0].instanceId);
  assert.equal(state.phase, "player");
  assert.equal(state.currentAp, data.config.baseAp);
});

test("all three Basic ATKs cost one AP and apply their personal resources", () => {
  for (const kind of ["normal", "charged", "plunge"]) {
    const { state, actor } = playerTurnState();
    actor.sp = 50;
    actor.energy = 0;
    actor.airborne = true;
    const result = engine.useBasic(state, kind, state.enemies[0].instanceId);

    assert.equal(result.ok, true);
    assert.equal(state.currentAp, 1);
    assert.equal(state.phase, "interrupt");
    assert.equal(actor.energy, data.config[kind === "normal" ? "normalEnergyGain" : kind === "charged" ? "chargedEnergyGain" : "plungeEnergyGain"]);
    assert.equal(actor.sp, kind === "normal" ? 50 + data.config.normalSpGain : kind === "charged" ? 50 - data.config.chargedSpCost : 50);
    if (kind === "plunge") assert.equal(actor.airborne, false);
    assert.equal(engine.continueBattle(state).ok, true);
    assert.equal(state.phase, "player");
    assert.equal(state.currentId, actor.instanceId);
  }
});

test("Skills require two AP, spend SP, generate Energy, and apply declared self HP costs", () => {
  const { state, actor } = playerTurnState();
  actor.sp = 100;
  state.currentAp = 1;
  assert.equal(engine.useSkill(state, state.enemies[0].instanceId).ok, false);

  state.currentAp = 2;
  const hpBefore = actor.hp;
  const energyBefore = actor.energy;
  assert.equal(engine.useSkill(state, state.enemies[0].instanceId).ok, true);
  assert.equal(actor.sp, 100 - actor.skill.spCost);
  assert.equal(actor.energy, Math.min(actor.maxEnergy, energyBefore + data.config.skillEnergyGain));
  assert.equal(actor.hp, hpBefore - Math.floor(hpBefore * actor.skill.selfHpCost));
  assert.equal(state.phase, "interrupt");
  assert.equal(state.currentId, null);
  assert.equal(actor.av, engine.baseAv(actor.speed));
  assert.equal(engine.continueBattle(state).ok, true);
  assert.notEqual(state.currentId, actor.instanceId);
});

test("ending a player sequence opens an Ultimate window before the timeline advances", () => {
  const { state, actor } = playerTurnState();

  assert.equal(engine.endPlayerTurn(state).ok, true);
  assert.equal(state.phase, "interrupt");
  assert.equal(state.currentId, null);
  assert.equal(actor.av, engine.baseAv(actor.speed));
  assert.equal(engine.continueBattle(state).ok, true);
  assert.notEqual(state.currentId, actor.instanceId);
});

test("a team-advance Ultimate benefits the ally whose turn just ended", () => {
  const { state, actor } = playerTurnState();
  const relay = state.players.find((unit) => unit.id === "supporter");
  relay.energy = relay.maxEnergy;
  state.currentAp = 1;

  assert.equal(engine.useBasic(state, "normal", state.enemies[0].instanceId).ok, true);
  assert.equal(state.phase, "interrupt");
  assert.equal(state.currentId, null);
  const resetAv = engine.baseAv(actor.speed);
  assert.equal(actor.av, resetAv);

  assert.equal(engine.useUltimate(state, relay.instanceId, state.enemies[0].instanceId).ok, true);
  assert.ok(Math.abs(actor.av - resetAv * 0.8) < 1e-9);
  assert.equal(state.phase, "interrupt");
});

test("Ultimates consume Energy, generate personal SP, and do not change AP", () => {
  const { state, actor } = playerTurnState(1);
  actor.energy = actor.maxEnergy;
  actor.sp = 40;
  state.currentAp = 1;

  const result = engine.useUltimate(state, actor.instanceId, state.enemies[0].instanceId);

  assert.equal(result.ok, true);
  assert.equal(actor.energy, 0);
  assert.equal(actor.sp, 40 + data.config.ultimateSpGain);
  assert.equal(state.currentAp, 1);
});

test("switching is free, transfers the slot and AP, and can occur only once", () => {
  const { state, actor } = playerTurnState();
  const reserve = state.players.find((unit) => !unit.onField);
  const slot = actor.slot;

  assert.equal(engine.switchUnits(state, reserve.instanceId).ok, true);
  assert.equal(state.currentAp, data.config.baseAp);
  assert.equal(state.currentId, reserve.instanceId);
  assert.equal(reserve.slot, slot);
  assert.equal(actor.onField, false);
  assert.equal(reserve.statuses.find((status) => status.id === "atkUp").multiplier, 1 + data.config.introAtkUp);

  const secondReserve = state.players.find((unit) => !unit.onField && unit.alive);
  assert.equal(engine.switchUnits(state, secondReserve.instanceId).ok, false);

  state.replacementIds.push("hold-timeline");
  engine.finishCurrentTurn(state);
  assert.equal(reserve.av, engine.baseAv(reserve.speed));
});

test("a successful full parry banks one AP for every eligible target", () => {
  const { state } = defenseState((current) => current.players.slice(0, 2));
  const targets = state.players.slice(0, 2);

  engine.resolveDefense(state, "parry", true);

  assert.equal(targets[0].apBonus, 1);
  assert.equal(targets[1].apBonus, 1);
});

test("one successful dodge resolves a multi-target attack", () => {
  const { state } = defenseState((current) => current.players.slice(0, 2));
  const targets = state.players.slice(0, 2);
  const hp = targets.map((unit) => unit.hp);

  engine.resolveDefense(state, "dodge", true);

  assert.deepEqual(targets.map((unit) => unit.hp), hp);
});

test("crowd-controlled allies cannot benefit from a shared parry", () => {
  const { state } = defenseState((current) => current.players.slice(0, 2));
  const [controlled, eligible] = state.players;
  controlled.crowdControlled = true;
  const hp = controlled.hp;

  engine.resolveDefense(state, "parry", true);

  assert.equal(controlled.apBonus, 0);
  assert.ok(controlled.hp < hp);
  assert.equal(eligible.apBonus, 1);
});

test("front-column enemies protect rear targets from direct attacks", () => {
  const { state } = playerTurnState();
  const rear = state.enemies.find((unit) => unit.lane === "rear" && unit.column === 2);

  assert.equal(engine.protectedRearTarget(state, rear), true);
  assert.equal(engine.useBasic(state, "normal", rear.instanceId).ok, false);

  state.enemies.find((unit) => unit.lane === "front" && unit.column === 2).alive = false;
  assert.equal(engine.protectedRearTarget(state, rear), false);
  assert.equal(engine.useBasic(state, "normal", rear.instanceId).ok, true);
});

test("lane attacks affect only the selected lane in the prototype", () => {
  const { state, actor } = playerTurnState(2);
  actor.sp = 100;
  const rear = state.enemies.find((unit) => unit.lane === "rear");
  const frontHp = state.enemies.filter((unit) => unit.lane === "front").map((unit) => unit.hp);
  const rearHp = state.enemies.filter((unit) => unit.lane === "rear").map((unit) => unit.hp);

  assert.equal(engine.useSkill(state, rear.instanceId).ok, true);
  assert.deepEqual(state.enemies.filter((unit) => unit.lane === "front").map((unit) => unit.hp), frontHp);
  assert.ok(state.enemies.filter((unit) => unit.lane === "rear").every((unit, index) => unit.hp < rearHp[index]));
});

test("replacement prompts are capped by living reserves and do not cause premature defeat", () => {
  const { state } = defenseState((current) => current.players.filter((unit) => unit.onField));
  state.players.filter((unit) => unit.onField).forEach((unit) => { unit.hp = 1; });

  engine.resolveDefense(state, "dodge", false);

  assert.notEqual(state.phase, "defeat");
  assert.equal(state.replacementIds.length, 3);

  while (state.replacementIds.length) {
    const reserve = state.players.find((unit) => unit.alive && !unit.onField);
    assert.equal(engine.replaceDefeated(state, state.replacementIds[0], reserve.instanceId).ok, true);
  }

  assert.equal(state.players.filter((unit) => unit.alive && unit.onField).length, 3);
  assert.notEqual(state.phase, "defeat");
});

test("the battle ends when no deployed ally or living reserve remains", () => {
  const { state } = defenseState((current) => [current.players[0]]);
  state.players.slice(1).forEach((unit) => {
    unit.alive = false;
    unit.hp = 0;
  });
  state.players[0].hp = 1;

  engine.resolveDefense(state, "dodge", false);

  assert.equal(state.phase, "defeat");
  assert.equal(state.replacementIds.length, 0);
});

test("debug HP mutation uses defeat and replacement transitions", () => {
  const { state } = playerTurnState();
  const target = state.players[1];

  assert.equal(engine.setUnitHp(state, target.instanceId, 0).ok, true);
  assert.equal(target.alive, false);
  assert.deepEqual(state.replacementIds, [target.instanceId]);

  assert.equal(engine.setUnitHp(state, target.instanceId, target.maxHp).ok, true);
  assert.equal(target.alive, true);
  assert.equal(state.replacementIds.length, 0);
});

test("SP and Energy can carry into a new encounter without carrying combat state", () => {
  const state = engine.makeInitialState(data);
  state.players[0].sp = 73;
  state.players[0].energy = 61;
  state.players[0].hp = 1;
  const resources = engine.capturePersistentResources(state);

  const next = engine.makeInitialState(data, { resources });

  assert.equal(next.players[0].sp, 73);
  assert.equal(next.players[0].energy, 61);
  assert.equal(next.players[0].hp, next.players[0].maxHp);
});

test("seeded combat results and log identifiers are reproducible", () => {
  const first = playerTurnState();
  const second = playerTurnState();

  engine.useBasic(first.state, "normal", first.state.enemies[0].instanceId);
  engine.useBasic(second.state, "normal", second.state.enemies[0].instanceId);

  assert.deepEqual(first.state.lastBreakdown, second.state.lastBreakdown);
  assert.deepEqual(first.state.log.map((entry) => entry.id), second.state.log.map((entry) => entry.id));
});

test("timeline previews use the same Speed tie-breaker as turn selection", () => {
  const state = engine.makeInitialState(data);
  [...state.players, ...state.enemies].forEach((unit) => { unit.av = 100; });
  state.players[0].av = 0;
  state.players[1].av = 0;

  assert.equal(engine.timelinePreview(state)[0].id, state.players[1].instanceId);
});

test("runtime data validation rejects unsupported actions and duplicate formation cells", () => {
  assert.deepEqual(engine.validateData(data), []);

  const invalidAction = engine.clone(data);
  invalidAction.units[0].skill.type = "unimplemented";
  assert.ok(engine.validateData(invalidAction).some((error) => error.includes("not supported")));

  const invalidEnergy = engine.clone(data);
  invalidEnergy.config.initialEnergyPercent = -1;
  assert.ok(engine.validateData(invalidEnergy).some((error) => error.includes("between 0 and 100")));

  const duplicateCell = engine.clone(data);
  duplicateCell.enemies[1].lane = duplicateCell.enemies[0].lane;
  duplicateCell.enemies[1].column = duplicateCell.enemies[0].column;
  assert.ok(engine.validateData(duplicateCell).some((error) => error.includes("duplicates formation cell")));
});
