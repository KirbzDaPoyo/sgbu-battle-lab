(function () {
  const data = window.SGBU.data;
  const clamp = (min, max, value) => Math.max(min, Math.min(max, value));
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const baseAv = (speed) => 10000 / Math.max(1, speed);

  function seededRandom(seed) {
    let value = seed >>> 0;
    return function () {
      value += 0x6d2b79f5;
      let result = value;
      result = Math.imul(result ^ (result >>> 15), result | 1);
      result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
      return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeCombatant(template, team, index, onField = true) {
    return {
      ...clone(template),
      instanceId: `${team}-${template.id}-${index}`,
      team,
      hp: template.maxHp,
      sp: team === "player" ? 40 : 0,
      energy: 0,
      apBonus: 0,
      shield: 0,
      av: baseAv(template.speed),
      onField,
      slot: onField ? index : null,
      alive: true,
      airborne: false,
      crowdControlled: false,
      statuses: [],
    };
  }

  function makeInitialState(overrideData) {
    const source = overrideData || data;
    const players = source.units.map((unit, index) => makeCombatant(unit, "player", index, index < 4));
    const enemies = source.enemies.map((enemy, index) => makeCombatant(enemy, "enemy", index, true));
    const state = {
      version: 1,
      seed: 137,
      rngCalls: 0,
      config: clone(source.config),
      players,
      enemies,
      currentId: null,
      currentAp: 0,
      phase: "ready",
      turn: 0,
      switchUsed: false,
      selectedTargetId: enemies[0]?.instanceId || null,
      selectedAllyId: players[0]?.instanceId || null,
      pendingDefense: null,
      replacementIds: [],
      forceCrit: false,
      forceDefense: "timed",
      log: [],
      lastBreakdown: null,
    };
    addLog(state, "Battle initialized. The timeline is ready.", "system");
    advanceTimeline(state);
    return state;
  }

  function addLog(state, message, type = "info") {
    state.log.unshift({ id: `${Date.now()}-${state.log.length}`, turn: state.turn, message, type });
    state.log = state.log.slice(0, 240);
  }

  function allCombatants(state) {
    return [...state.players, ...state.enemies];
  }

  function findUnit(state, id) {
    return allCombatants(state).find((unit) => unit.instanceId === id);
  }

  function timelineUnits(state) {
    return allCombatants(state).filter((unit) => unit.alive && (unit.team === "enemy" || unit.onField));
  }

  function tickStatuses(unit) {
    unit.statuses.forEach((status) => { status.duration -= 1; });
    unit.statuses = unit.statuses.filter((status) => status.duration > 0);
  }

  function advanceTimeline(state) {
    if (checkEnd(state)) return null;
    const eligible = timelineUnits(state);
    if (!eligible.length) return null;
    const minimum = Math.min(...eligible.map((unit) => unit.av));
    eligible.forEach((unit) => { unit.av = Math.max(0, unit.av - minimum); });
    const actor = eligible.sort((a, b) => a.av - b.av || b.speed - a.speed)[0];
    state.currentId = actor.instanceId;
    state.turn += 1;
    state.switchUsed = false;
    tickStatuses(actor);
    if (actor.team === "player") {
      state.phase = "player";
      state.currentAp = state.config.baseAp + actor.apBonus;
      if (actor.apBonus) addLog(state, `${actor.name} receives ${actor.apBonus} banked AP.`, "resource");
      actor.apBonus = 0;
      state.selectedAllyId = actor.instanceId;
      addLog(state, `${actor.name}'s turn begins with ${state.currentAp} AP.`, "turn");
    } else {
      state.phase = "enemy";
      state.currentAp = 0;
      addLog(state, `${actor.name} prepares an attack.`, "enemy");
    }
    return actor;
  }

  function finishCurrentTurn(state) {
    const actor = findUnit(state, state.currentId);
    if (actor && actor.alive) actor.av = baseAv(actor.speed);
    state.currentId = null;
    state.currentAp = 0;
    state.pendingDefense = null;
    if (!state.replacementIds.length) advanceTimeline(state);
  }

  function randomForState(state) {
    const rng = seededRandom(state.seed);
    let result = 0;
    for (let i = 0; i <= state.rngCalls; i += 1) result = rng();
    state.rngCalls += 1;
    return result;
  }

  function hasStatus(unit, id) {
    return unit.statuses.some((status) => status.id === id);
  }

  function applyStatus(unit, status) {
    const existing = unit.statuses.find((item) => item.id === status.id);
    if (existing) Object.assign(existing, status);
    else unit.statuses.push({ ...status });
  }

  function damageBreakdown(state, attacker, defender, multiplier, options = {}) {
    const atkMultiplier = hasStatus(attacker, "atkUp") ? 1.25 : 1;
    const base = attacker.atk * multiplier * atkMultiplier;
    const defMultiplier = 1 - defender.def / (defender.def + 200 + 10 * state.config.level);
    const vulnerable = hasStatus(defender, "vulnerable") ? 1.2 : 1;
    const weaken = hasStatus(attacker, "weaken") ? 0.8 : 1;
    const debuffBonus = options.debuffBonus && defender.statuses.length ? 1 + options.debuffBonus : 1;
    const crit = state.forceCrit || randomForState(state) < 0.05;
    const critMultiplier = crit ? 1.5 : 1;
    const variance = 0.95 + randomForState(state) * 0.1;
    const total = Math.max(1, Math.round(base * defMultiplier * vulnerable * weaken * debuffBonus * critMultiplier * variance));
    return { base: Math.round(base), defMultiplier, vulnerable, weaken, debuffBonus, crit, critMultiplier, variance, total };
  }

  function dealDamage(state, attacker, target, multiplier, options) {
    const breakdown = damageBreakdown(state, attacker, target, multiplier, options);
    const absorbed = Math.min(target.shield, breakdown.total);
    target.shield -= absorbed;
    const hpDamage = breakdown.total - absorbed;
    target.hp = Math.max(0, target.hp - hpDamage);
    state.lastBreakdown = { attacker: attacker.name, target: target.name, ...breakdown, absorbed };
    addLog(state, `${attacker.name} deals ${breakdown.total} damage to ${target.name}${breakdown.crit ? " (CRIT)" : ""}${absorbed ? `; ${absorbed} absorbed` : ""}.`, "damage");
    handleDefeat(state, target);
    return breakdown.total;
  }

  function heal(state, source, target, multiplier) {
    const amount = Math.max(1, Math.round(source.atk * multiplier + source.maxHp * 0.08));
    const restored = Math.min(amount, target.maxHp - target.hp);
    target.hp += restored;
    addLog(state, `${source.name} restores ${restored} HP to ${target.name}.`, "heal");
  }

  function handleDefeat(state, target) {
    if (target.hp > 0 || !target.alive) return;
    target.alive = false;
    addLog(state, `${target.name} is defeated.`, "defeat");
    if (target.team === "player" && target.onField) {
      const reserves = state.players.filter((unit) => unit.alive && !unit.onField);
      if (reserves.length) state.replacementIds.push(target.instanceId);
    }
  }

  function checkEnd(state) {
    if (state.phase === "victory" || state.phase === "defeat") return true;
    if (!state.enemies.some((unit) => unit.alive)) {
      state.phase = "victory";
      state.currentId = null;
      addLog(state, "Victory. All enemy targets are offline.", "victory");
      return true;
    }
    if (!state.players.some((unit) => unit.alive && unit.onField)) {
      state.phase = "defeat";
      state.currentId = null;
      addLog(state, "Defeat. No deployed allies remain.", "defeat");
      return true;
    }
    return false;
  }

  function protectedRearTarget(state, target) {
    if (!target || target.team !== "enemy" || target.lane !== "rear") return false;
    return state.enemies.some((enemy) => enemy.alive && enemy.lane === "front" && enemy.column === target.column);
  }

  function validEnemyTargets(state, allowProtectedRear = false) {
    return state.enemies.filter((enemy) => enemy.alive && (allowProtectedRear || !protectedRearTarget(state, enemy)));
  }

  function gainActionResources(state, actor, sp, energy) {
    actor.sp = clamp(0, actor.maxSp, actor.sp + sp);
    actor.energy = clamp(0, actor.maxEnergy, actor.energy + energy);
  }

  function payAp(state, amount) {
    state.currentAp = Math.max(0, state.currentAp - amount);
    if (state.currentAp === 0 && !state.replacementIds.length) finishCurrentTurn(state);
  }

  function useBasic(state, kind, targetId) {
    const actor = findUnit(state, state.currentId);
    const target = findUnit(state, targetId);
    if (!actor || actor.team !== "player" || state.phase !== "player") return { ok: false, reason: "No player turn is active." };
    if (state.currentAp < 1) return { ok: false, reason: "Not enough AP." };
    if (!target || !target.alive || target.team !== "enemy") return { ok: false, reason: "Select a living enemy." };
    if (protectedRearTarget(state, target)) return { ok: false, reason: "That rear target is protected by its front-column guard." };
    const definitions = {
      normal: { name: "Normal ATK", multiplier: 1, sp: state.config.normalSpGain, energy: state.config.normalEnergyGain },
      charged: { name: "Charged ATK", multiplier: 1.55, sp: -state.config.chargedSpCost, energy: state.config.chargedEnergyGain },
      plunge: { name: "Plunging ATK", multiplier: 1.35, sp: 0, energy: state.config.plungeEnergyGain },
    };
    const action = definitions[kind];
    if (!action) return { ok: false, reason: "Unknown Basic ATK." };
    if (kind === "charged" && actor.sp < state.config.chargedSpCost) return { ok: false, reason: "Not enough SP." };
    if (kind === "plunge" && !actor.airborne) return { ok: false, reason: "The active unit is not above ground." };
    addLog(state, `${actor.name} uses ${action.name}.`, "action");
    dealDamage(state, actor, target, action.multiplier);
    gainActionResources(state, actor, action.sp, action.energy);
    if (kind === "plunge") actor.airborne = false;
    payAp(state, 1);
    checkEnd(state);
    return { ok: true };
  }

  function executeEffect(state, actor, action, targetId) {
    const target = findUnit(state, targetId);
    const livingEnemies = state.enemies.filter((unit) => unit.alive);
    const deployed = state.players.filter((unit) => unit.alive && unit.onField);
    switch (action.type) {
      case "damage":
        if (!target || target.team !== "enemy") return "Select an enemy.";
        if (protectedRearTarget(state, target)) return "That rear target is protected by its front-column guard.";
        dealDamage(state, actor, target, action.multiplier, { debuffBonus: action.debuffBonus });
        break;
      case "laneDamage": {
        if (!target || target.team !== "enemy") return "Select an enemy to choose its lane.";
        livingEnemies.filter((unit) => unit.lane === target.lane).forEach((unit) => dealDamage(state, actor, unit, action.multiplier));
        break;
      }
      case "allDamage":
        livingEnemies.forEach((unit) => dealDamage(state, actor, unit, action.multiplier));
        break;
      case "buff": {
        const ally = findUnit(state, targetId);
        if (!ally || ally.team !== "player" || !ally.onField || !ally.alive) return "Select a deployed ally.";
        applyStatus(ally, { id: "atkUp", name: "ATK Up", duration: action.duration });
        addLog(state, `${ally.name} gains ATK Up for ${action.duration} turns.`, "buff");
        break;
      }
      case "debuffDamage":
        if (!target || target.team !== "enemy") return "Select an enemy.";
        if (protectedRearTarget(state, target)) return "That rear target is protected by its front-column guard.";
        dealDamage(state, actor, target, action.multiplier);
        applyStatus(target, { id: "vulnerable", name: "Vulnerable", duration: action.duration });
        addLog(state, `${target.name} becomes Vulnerable.`, "debuff");
        break;
      case "allDebuffDamage":
        livingEnemies.forEach((unit) => {
          dealDamage(state, actor, unit, action.multiplier);
          applyStatus(unit, { id: "weaken", name: "Weaken", duration: action.duration });
        });
        break;
      case "heal": {
        const ally = findUnit(state, targetId);
        if (!ally || ally.team !== "player" || !ally.onField || !ally.alive) return "Select a deployed ally.";
        heal(state, actor, ally, action.multiplier);
        break;
      }
      case "teamHeal":
        deployed.forEach((unit) => heal(state, actor, unit, action.multiplier));
        break;
      case "teamShield":
      case "teamShieldCleanse":
        deployed.forEach((unit) => {
          unit.shield += Math.round(actor.maxHp * action.multiplier);
          if (action.type === "teamShieldCleanse") unit.crowdControlled = false;
        });
        addLog(state, `${actor.name} shields the deployed team.`, "buff");
        break;
      case "teamAdvance":
        deployed.forEach((unit) => {
          applyStatus(unit, { id: "atkUp", name: "ATK Up", duration: 2 });
          unit.av = Math.max(0, unit.av - baseAv(unit.speed) * 0.2);
        });
        addLog(state, `${actor.name} advances and empowers the deployed team.`, "buff");
        break;
      default:
        return "That effect is not implemented.";
    }
    return null;
  }

  function useSkill(state, targetId) {
    const actor = findUnit(state, state.currentId);
    if (!actor || actor.team !== "player" || state.phase !== "player") return { ok: false, reason: "No player turn is active." };
    if (state.currentAp < 2) return { ok: false, reason: "Skills require 2 AP." };
    if (actor.sp < actor.skill.spCost) return { ok: false, reason: "Not enough SP." };
    const reason = executeEffect(state, actor, actor.skill, targetId);
    if (reason) return { ok: false, reason };
    actor.sp -= actor.skill.spCost;
    actor.energy = clamp(0, actor.maxEnergy, actor.energy + state.config.skillEnergyGain);
    addLog(state, `${actor.name} uses ${actor.skill.name}.`, "action");
    payAp(state, 2);
    checkEnd(state);
    return { ok: true };
  }

  function useUltimate(state, actorId, targetId) {
    const actor = findUnit(state, actorId);
    if (!actor || actor.team !== "player" || !actor.alive || !actor.onField) return { ok: false, reason: "Only a living deployed ally can use an Ultimate." };
    if (["defense", "victory", "defeat"].includes(state.phase)) return { ok: false, reason: "The Ultimate cannot interrupt this phase." };
    if (actor.energy < actor.maxEnergy) return { ok: false, reason: "Energy is not full." };
    const reason = executeEffect(state, actor, actor.ultimate, targetId);
    if (reason) return { ok: false, reason };
    actor.energy = 0;
    actor.sp = clamp(0, actor.maxSp, actor.sp + state.config.ultimateSpGain);
    addLog(state, `${actor.name} interrupts with ${actor.ultimate.name}.`, "ultimate");
    checkEnd(state);
    return { ok: true };
  }

  function switchUnits(state, incomingId) {
    const outgoing = findUnit(state, state.currentId);
    const incoming = findUnit(state, incomingId);
    if (!outgoing || outgoing.team !== "player" || state.phase !== "player") return { ok: false, reason: "Switching requires a player turn." };
    if (state.switchUsed) return { ok: false, reason: "The incoming unit cannot switch out during the inherited turn." };
    if (!incoming || incoming.team !== "player" || incoming.onField || !incoming.alive) return { ok: false, reason: "Select a living reserve." };
    const slot = outgoing.slot;
    outgoing.onField = false;
    outgoing.slot = null;
    incoming.onField = true;
    incoming.slot = slot;
    incoming.av = outgoing.av;
    state.currentId = incoming.instanceId;
    state.switchUsed = true;
    state.selectedAllyId = incoming.instanceId;
    applyStatus(incoming, { id: "atkUp", name: "Intro: ATK Up", duration: 1 });
    addLog(state, `${outgoing.name} uses Outro; ${incoming.name} enters slot ${slot + 1} and inherits ${state.currentAp} AP.`, "switch");
    return { ok: true };
  }

  function replaceDefeated(state, defeatedId, incomingId) {
    const defeated = findUnit(state, defeatedId);
    const incoming = findUnit(state, incomingId);
    if (!defeated || !incoming || incoming.onField || !incoming.alive) return { ok: false, reason: "Invalid replacement." };
    incoming.onField = true;
    incoming.slot = defeated.slot;
    incoming.av = baseAv(incoming.speed);
    defeated.onField = false;
    defeated.slot = null;
    state.replacementIds = state.replacementIds.filter((id) => id !== defeatedId);
    addLog(state, `${incoming.name} replaces defeated ${defeated.name}.`, "switch");
    if (!state.replacementIds.length && !state.currentId) advanceTimeline(state);
    return { ok: true };
  }

  function prepareEnemyAttack(state) {
    const enemy = findUnit(state, state.currentId);
    if (!enemy || enemy.team !== "enemy" || state.phase !== "enemy") return null;
    const deployed = state.players.filter((unit) => unit.alive && unit.onField).sort((a, b) => a.slot - b.slot);
    if (!deployed.length) return null;
    let targets;
    if (enemy.attackType === "lane") {
      const parity = Math.floor(randomForState(state) * 2);
      targets = deployed.filter((unit) => unit.slot % 2 === parity);
      if (!targets.length) targets = deployed;
    } else {
      targets = [deployed[Math.floor(randomForState(state) * deployed.length)]];
    }
    state.pendingDefense = { enemyId: enemy.instanceId, targetIds: targets.map((unit) => unit.instanceId), multiplier: enemy.attackType === "lane" ? 0.9 : 1.25 };
    state.phase = "defense";
    return state.pendingDefense;
  }

  function reactionWindow(state, mode) {
    const pending = state.pendingDefense;
    if (!pending) return 0.2;
    const enemy = findUnit(state, pending.enemyId);
    const eligible = pending.targetIds.map((id) => findUnit(state, id)).filter((unit) => unit && !unit.crowdControlled);
    const evasion = eligible.length ? eligible.reduce((sum, unit) => sum + unit.evasion, 0) / eligible.length : 0;
    const base = clamp(0.1, 0.34, 0.22 * (1 + evasion - enemy.accuracy));
    return mode === "parry" ? base * state.config.parryWindowScale : base;
  }

  function resolveDefense(state, mode, success) {
    const pending = state.pendingDefense;
    if (!pending) return { ok: false, reason: "No enemy attack is pending." };
    const enemy = findUnit(state, pending.enemyId);
    const targets = pending.targetIds.map((id) => findUnit(state, id)).filter(Boolean);
    const finalSuccess = state.forceDefense === "success" ? true : state.forceDefense === "fail" ? false : success;
    targets.forEach((target) => {
      const eligible = !target.crowdControlled;
      if (finalSuccess && eligible && mode === "dodge") {
        addLog(state, `${target.name} dodges ${enemy.name}'s attack.`, "defense");
      } else if (finalSuccess && eligible && mode === "parry") {
        target.apBonus += 1;
        addLog(state, `${target.name} fully parries and banks +1 AP.`, "defense");
      } else {
        dealDamage(state, enemy, target, pending.multiplier);
        if (target.crowdControlled) addLog(state, `${target.name} could not react while crowd-controlled.`, "debuff");
      }
    });
    state.pendingDefense = null;
    state.phase = "enemy";
    finishCurrentTurn(state);
    checkEnd(state);
    return { ok: true, success: finalSuccess };
  }

  function timelinePreview(state) {
    return timelineUnits(state)
      .map((unit) => ({ id: unit.instanceId, name: unit.name, team: unit.team, av: unit.av, color: unit.color }))
      .sort((a, b) => a.av - b.av)
      .slice(0, 10);
  }

  window.SGBU.engine = {
    addLog,
    advanceTimeline,
    baseAv,
    checkEnd,
    clone,
    findUnit,
    finishCurrentTurn,
    makeInitialState,
    prepareEnemyAttack,
    protectedRearTarget,
    reactionWindow,
    replaceDefeated,
    resolveDefense,
    switchUnits,
    timelinePreview,
    useBasic,
    useSkill,
    useUltimate,
    validEnemyTargets,
  };
})();
