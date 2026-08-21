(function () {
  const data = window.SGBU.data;
  const clamp = (min, max, value) => Math.max(min, Math.min(max, value));
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const baseAv = (speed) => 10000 / Math.max(1, speed);
  const actionTypes = new Set(["damage", "laneDamage", "allDamage", "buff", "debuffDamage", "allDebuffDamage", "heal", "teamHeal", "teamShield", "teamShieldCleanse", "teamAdvance"]);
  const requiredConfigNumbers = [
    "baseAp", "initialSp", "initialEnergyPercent", "normalBasicMultiplier", "chargedBasicMultiplier", "plungeBasicMultiplier",
    "normalSpGain", "chargedSpCost", "ultimateSpGain", "normalEnergyGain", "chargedEnergyGain", "plungeEnergyGain",
    "skillEnergyGain", "critRate", "critMultiplier", "damageVariance", "defenseBase", "defenseLevelScale", "healHpScale",
    "level", "vulnerableMultiplier", "weakenMultiplier", "reactionWindowMin", "reactionWindowBase", "reactionWindowMax",
    "reactionWindowFallback", "parryWindowScale", "enemySingleMultiplier", "enemyLaneMultiplier", "introAtkUp",
    "introDuration", "enemyDelayMs", "defenseDurationMs", "defenseTimeoutGraceMs", "maxLogEntries",
  ];

  function validateData(source) {
    const errors = [];
    const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
    const finite = (value) => typeof value === "number" && Number.isFinite(value);
    const requireText = (value, path) => {
      if (typeof value !== "string" || !value.trim()) errors.push(path + " must be a non-empty string.");
    };
    const requireNumber = (value, path, minimum = 0) => {
      if (!finite(value) || value < minimum) errors.push(path + " must be a finite number >= " + minimum + ".");
    };
    const validateAction = (action, path, isSkill) => {
      if (!isObject(action)) {
        errors.push(path + " must be an object.");
        return;
      }
      requireText(action.name, path + ".name");
      requireText(action.description, path + ".description");
      if (!actionTypes.has(action.type)) errors.push(path + ".type is not supported.");
      requireNumber(action.multiplier, path + ".multiplier");
      if (isSkill) requireNumber(action.spCost, path + ".spCost");
      if (["buff", "debuffDamage", "allDebuffDamage", "teamAdvance"].includes(action.type)) requireNumber(action.duration, path + ".duration", 1);
      if (action.type === "teamAdvance") requireNumber(action.advance, path + ".advance");
      for (const key of ["selfHpCost", "vulnerability", "weaken"]) {
        if (action[key] !== undefined && (!finite(action[key]) || action[key] < 0 || action[key] > 1)) errors.push(path + "." + key + " must be between 0 and 1.");
      }
    };

    if (!isObject(source)) return ["Runtime data must be an object."];
    if (!isObject(source.config)) errors.push("config must be an object.");
    else {
      requiredConfigNumbers.forEach((key) => requireNumber(source.config[key], "config." + key));
      if (finite(source.config.initialEnergyPercent) && (source.config.initialEnergyPercent < 0 || source.config.initialEnergyPercent > 100)) errors.push("config.initialEnergyPercent must be between 0 and 100.");
      if (finite(source.config.reactionWindowMin) && finite(source.config.reactionWindowBase) && finite(source.config.reactionWindowMax)
        && !(source.config.reactionWindowMin <= source.config.reactionWindowBase && source.config.reactionWindowBase <= source.config.reactionWindowMax)) {
        errors.push("Reaction windows must satisfy min <= base <= max.");
      }
    }

    if (!Array.isArray(source.units) || !source.units.length) errors.push("units must be a non-empty array.");
    else {
      const ids = new Set();
      source.units.forEach((unit, index) => {
        const path = "units[" + index + "]";
        if (!isObject(unit)) {
          errors.push(path + " must be an object.");
          return;
        }
        for (const key of ["id", "name", "className", "subclass"]) requireText(unit[key], path + "." + key);
        if (ids.has(unit.id)) errors.push(path + ".id must be unique.");
        ids.add(unit.id);
        for (const key of ["maxHp", "atk", "def", "speed", "maxSp", "maxEnergy"]) requireNumber(unit[key], path + "." + key, key === "def" ? 0 : 1);
        for (const key of ["accuracy", "evasion"]) requireNumber(unit[key], path + "." + key);
        validateAction(unit.skill, path + ".skill", true);
        validateAction(unit.ultimate, path + ".ultimate", false);
      });
    }

    if (!Array.isArray(source.enemies) || !source.enemies.length) errors.push("enemies must be a non-empty array.");
    else {
      if (source.enemies.length > 10) errors.push("enemies cannot contain more than ten combatants.");
      const ids = new Set();
      const cells = new Set();
      source.enemies.forEach((enemy, index) => {
        const path = "enemies[" + index + "]";
        if (!isObject(enemy)) {
          errors.push(path + " must be an object.");
          return;
        }
        for (const key of ["id", "name"]) requireText(enemy[key], path + "." + key);
        if (ids.has(enemy.id)) errors.push(path + ".id must be unique.");
        ids.add(enemy.id);
        for (const key of ["maxHp", "atk", "def", "speed"]) requireNumber(enemy[key], path + "." + key, key === "def" ? 0 : 1);
        for (const key of ["accuracy", "evasion"]) requireNumber(enemy[key], path + "." + key);
        if (!["front", "rear"].includes(enemy.lane)) errors.push(path + ".lane must be front or rear.");
        if (!Number.isInteger(enemy.column) || enemy.column < 1 || enemy.column > 5) errors.push(path + ".column must be an integer from 1 to 5.");
        if (!["single", "lane"].includes(enemy.attackType)) errors.push(path + ".attackType must be single or lane.");
        const cell = enemy.lane + ":" + enemy.column;
        if (cells.has(cell)) errors.push(path + " duplicates formation cell " + cell + ".");
        cells.add(cell);
      });
    }
    return errors;
  }

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

  function makeCombatant(template, team, index, onField = true, config = {}, persisted = null) {
    const initialSp = persisted?.sp ?? config.initialSp ?? 0;
    const initialEnergy = persisted?.energy ?? Math.round(template.maxEnergy * (config.initialEnergyPercent ?? 0) / 100);
    return {
      ...clone(template),
      instanceId: `${team}-${template.id}-${index}`,
      team,
      hp: template.maxHp,
      sp: team === "player" ? clamp(0, template.maxSp, initialSp) : 0,
      energy: team === "player" ? clamp(0, template.maxEnergy, initialEnergy) : 0,
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

  function makeInitialState(overrideData, options = {}) {
    const source = overrideData || data;
    const errors = validateData(source);
    if (errors.length) throw new Error(errors[0]);
    const resources = options.resources || {};
    const players = source.units.map((unit, index) => makeCombatant(unit, "player", index, index < 4, source.config, resources[unit.id]));
    const enemies = source.enemies.map((enemy, index) => makeCombatant(enemy, "enemy", index, true, source.config));
    const state = {
      version: 2,
      seed: options.seed ?? 137,
      rngCalls: 0,
      logSequence: 0,
      config: clone(source.config),
      players,
      enemies,
      currentId: null,
      currentAp: 0,
      phase: options.autoStart === false ? "setup" : "ready",
      turn: 0,
      switchUsed: false,
      selectedTargetId: enemies[0]?.instanceId || null,
      selectedAllyId: players[0]?.instanceId || null,
      pendingDefense: null,
      replacementIds: [],
      interrupt: null,
      forceCrit: false,
      forceDefense: "timed",
      log: [],
      lastBreakdown: null,
    };
    if (options.autoStart === false) {
      addLog(state, "Encounter setup is ready. Combat has not started.", "system");
    } else {
      addLog(state, "Battle initialized. The timeline is ready.", "system");
      advanceTimeline(state);
    }
    return state;
  }

  function openUltimateWindow(state, continuation, message) {
    state.phase = "interrupt";
    state.interrupt = { continuation };
    addLog(state, message || "Ultimate window opened before the next action.", "system");
  }

  function startBattle(state) {
    if (state.phase !== "setup") return { ok: false, reason: "This encounter has already started." };
    openUltimateWindow(state, "advanceTimeline", "Encounter confirmed. Ultimates may be used before the timeline begins.");
    return { ok: true };
  }

  function continueBattle(state) {
    if (state.phase !== "interrupt" || !state.interrupt) return { ok: false, reason: "No Ultimate window is active." };
    if (state.replacementIds.length) return { ok: false, reason: "Complete the forced replacement first." };
    const continuation = state.interrupt.continuation;
    state.interrupt = null;
    if (continuation === "resumePlayer") {
      state.phase = "player";
    } else {
      state.phase = "ready";
      advanceTimeline(state);
    }
    return { ok: true };
  }

  function addLog(state, message, type = "info") {
    const sequence = state.logSequence || 0;
    state.logSequence = sequence + 1;
    state.log.unshift({ id: "event-" + sequence, turn: state.turn, message, type });
    state.log = state.log.slice(0, state.config?.maxLogEntries || 240);
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

  function finishCurrentTurn(state, advance = true) {
    const actor = findUnit(state, state.currentId);
    if (actor && actor.alive) actor.av = baseAv(actor.speed);
    state.currentId = null;
    state.currentAp = 0;
    state.pendingDefense = null;
    if (advance && !state.replacementIds.length) advanceTimeline(state);
  }

  function endPlayerTurn(state) {
    const actor = findUnit(state, state.currentId);
    if (!actor || actor.team !== "player" || state.phase !== "player") return { ok: false, reason: "No player turn is active." };
    finishCurrentTurn(state, false);
    if (!checkEnd(state)) openUltimateWindow(state, "advanceTimeline", "Turn ended. Ultimates may be used before the timeline advances.");
    return { ok: true };
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

  function statusMultiplier(unit, id, fallback) {
    return unit.statuses.find((status) => status.id === id)?.multiplier ?? fallback;
  }

  function damageBreakdown(state, attacker, defender, multiplier, options = {}) {
    const atkMultiplier = statusMultiplier(attacker, "atkUp", 1);
    const base = attacker.atk * multiplier * atkMultiplier;
    const defMultiplier = 1 - defender.def / (defender.def + state.config.defenseBase + state.config.defenseLevelScale * state.config.level);
    const vulnerable = statusMultiplier(defender, "vulnerable", 1);
    const weaken = statusMultiplier(attacker, "weaken", 1);
    const debuffBonus = options.debuffBonus && defender.statuses.length ? 1 + options.debuffBonus : 1;
    const crit = state.forceCrit || randomForState(state) < state.config.critRate;
    const critMultiplier = crit ? state.config.critMultiplier : 1;
    const variance = 1 - state.config.damageVariance + randomForState(state) * state.config.damageVariance * 2;
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
    const amount = Math.max(1, Math.round(source.atk * multiplier + source.maxHp * state.config.healHpScale));
    const restored = Math.min(amount, target.maxHp - target.hp);
    target.hp += restored;
    addLog(state, `${source.name} restores ${restored} HP to ${target.name}.`, "heal");
  }

  function livingReserves(state) {
    return state.players.filter((unit) => unit.alive && !unit.onField);
  }

  function reconcileReplacementQueue(state) {
    const pending = state.replacementIds.filter((id) => {
      const unit = findUnit(state, id);
      return unit?.team === "player" && unit.onField && !unit.alive;
    });
    state.replacementIds = pending.slice(0, livingReserves(state).length);
  }

  function handleDefeat(state, target) {
    if (target.hp > 0 || !target.alive) return;
    target.alive = false;
    addLog(state, `${target.name} is defeated.`, "defeat");
    if (target.team === "player" && target.onField && !state.replacementIds.includes(target.instanceId)) {
      const capacity = livingReserves(state).length;
      if (state.replacementIds.length < capacity) state.replacementIds.push(target.instanceId);
    }
  }

  function checkEnd(state) {
    if (state.phase === "victory" || state.phase === "defeat") return true;
    reconcileReplacementQueue(state);
    if (!state.enemies.some((unit) => unit.alive)) {
      state.phase = "victory";
      state.currentId = null;
      state.currentAp = 0;
      addLog(state, "Victory. All enemy targets are offline.", "victory");
      return true;
    }
    if (!state.players.some((unit) => unit.alive && unit.onField)) {
      if (state.replacementIds.length) return false;
      state.phase = "defeat";
      state.currentId = null;
      state.currentAp = 0;
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
    if (state.currentAp === 0) {
      finishCurrentTurn(state, false);
      if (!checkEnd(state)) openUltimateWindow(state, "advanceTimeline", "Turn ended. Ultimates may be used before the timeline advances.");
      return;
    }
    openUltimateWindow(state, "resumePlayer", "Action resolved. Ultimates may be used before the next AP action.");
  }

  function useBasic(state, kind, targetId) {
    const actor = findUnit(state, state.currentId);
    const target = findUnit(state, targetId);
    if (!actor || actor.team !== "player" || state.phase !== "player") return { ok: false, reason: "No player turn is active." };
    if (state.currentAp < 1) return { ok: false, reason: "Not enough AP." };
    if (!target || !target.alive || target.team !== "enemy") return { ok: false, reason: "Select a living enemy." };
    if (protectedRearTarget(state, target)) return { ok: false, reason: "That rear target is protected by its front-column guard." };
    const definitions = {
      normal: { name: "Normal ATK", multiplier: state.config.normalBasicMultiplier, sp: state.config.normalSpGain, energy: state.config.normalEnergyGain },
      charged: { name: "Charged ATK", multiplier: state.config.chargedBasicMultiplier, sp: -state.config.chargedSpCost, energy: state.config.chargedEnergyGain },
      plunge: { name: "Plunging ATK", multiplier: state.config.plungeBasicMultiplier, sp: 0, energy: state.config.plungeEnergyGain },
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
        applyStatus(ally, { id: "atkUp", name: "ATK Up", duration: action.duration, multiplier: 1 + action.multiplier });
        addLog(state, `${ally.name} gains ATK Up for ${action.duration} turns.`, "buff");
        break;
      }
      case "debuffDamage":
        if (!target || target.team !== "enemy") return "Select an enemy.";
        if (protectedRearTarget(state, target)) return "That rear target is protected by its front-column guard.";
        dealDamage(state, actor, target, action.multiplier);
        applyStatus(target, {
          id: "vulnerable",
          name: "Vulnerable",
          duration: action.duration,
          multiplier: 1 + (action.vulnerability ?? state.config.vulnerableMultiplier - 1),
        });
        addLog(state, `${target.name} becomes Vulnerable.`, "debuff");
        break;
      case "allDebuffDamage":
        livingEnemies.forEach((unit) => {
          dealDamage(state, actor, unit, action.multiplier);
          applyStatus(unit, {
            id: "weaken",
            name: "Weaken",
            duration: action.duration,
            multiplier: 1 - (action.weaken ?? 1 - state.config.weakenMultiplier),
          });
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
          applyStatus(unit, { id: "atkUp", name: "ATK Up", duration: action.duration, multiplier: 1 + action.multiplier });
          unit.av = Math.max(0, unit.av - baseAv(unit.speed) * action.advance);
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
    if (actor.skill.selfHpCost > 0) {
      const hpCost = Math.max(1, Math.floor(actor.hp * actor.skill.selfHpCost));
      actor.hp = Math.max(0, actor.hp - hpCost);
      addLog(state, `${actor.name} loses ${hpCost} HP to ${actor.skill.name}.`, "resource");
      handleDefeat(state, actor);
    }
    addLog(state, `${actor.name} uses ${actor.skill.name}.`, "action");
    payAp(state, 2);
    checkEnd(state);
    return { ok: true };
  }

  function useUltimate(state, actorId, targetId) {
    const actor = findUnit(state, actorId);
    if (!actor || actor.team !== "player" || !actor.alive || !actor.onField) return { ok: false, reason: "Only a living deployed ally can use an Ultimate." };
    if (state.replacementIds.length || ["defense", "victory", "defeat"].includes(state.phase)) return { ok: false, reason: "The Ultimate cannot interrupt this phase." };
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
    applyStatus(incoming, {
      id: "atkUp",
      name: "Intro: ATK Up",
      duration: state.config.introDuration,
      multiplier: 1 + state.config.introAtkUp,
    });
    addLog(state, `${outgoing.name} uses Outro; ${incoming.name} enters slot ${slot + 1} and inherits ${state.currentAp} AP.`, "switch");
    return { ok: true };
  }

  function replaceDefeated(state, defeatedId, incomingId) {
    const defeated = findUnit(state, defeatedId);
    const incoming = findUnit(state, incomingId);
    const validDefeated = defeated?.team === "player" && defeated.onField && !defeated.alive && state.replacementIds.includes(defeatedId);
    const validIncoming = incoming?.team === "player" && !incoming.onField && incoming.alive;
    if (!validDefeated || !validIncoming) return { ok: false, reason: "Invalid replacement." };
    incoming.onField = true;
    incoming.slot = defeated.slot;
    incoming.av = baseAv(incoming.speed);
    defeated.onField = false;
    defeated.slot = null;
    state.replacementIds = state.replacementIds.filter((id) => id !== defeatedId);
    reconcileReplacementQueue(state);
    addLog(state, `${incoming.name} replaces defeated ${defeated.name}.`, "switch");
    if (!state.replacementIds.length && !state.currentId && !checkEnd(state) && !state.interrupt) advanceTimeline(state);
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
    state.pendingDefense = {
      enemyId: enemy.instanceId,
      targetIds: targets.map((unit) => unit.instanceId),
      multiplier: enemy.attackType === "lane" ? state.config.enemyLaneMultiplier : state.config.enemySingleMultiplier,
    };
    state.phase = "defense";
    return state.pendingDefense;
  }

  function reactionWindow(state, mode) {
    const pending = state.pendingDefense;
    if (!pending) return state.config.reactionWindowFallback;
    const enemy = findUnit(state, pending.enemyId);
    const eligible = pending.targetIds.map((id) => findUnit(state, id)).filter((unit) => unit && !unit.crowdControlled);
    const evasion = eligible.length ? eligible.reduce((sum, unit) => sum + unit.evasion, 0) / eligible.length : 0;
    const base = clamp(
      state.config.reactionWindowMin,
      state.config.reactionWindowMax,
      state.config.reactionWindowBase * (1 + evasion - enemy.accuracy),
    );
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
    finishCurrentTurn(state, false);
    if (!checkEnd(state)) openUltimateWindow(state, "advanceTimeline", "Enemy action resolved. Ultimates may be used before the next turn.");
    return { ok: true, success: finalSuccess };
  }

  function capturePersistentResources(state) {
    return Object.fromEntries(state.players.map((unit) => [unit.id, { sp: unit.sp, energy: unit.energy }]));
  }

  function setUnitHp(state, unitId, value) {
    const unit = findUnit(state, unitId);
    if (!unit) return { ok: false, reason: "Combatant not found." };
    const nextHp = clamp(0, unit.maxHp, Number(value) || 0);
    const wasAlive = unit.alive;
    unit.hp = nextHp;
    if (nextHp === 0) {
      handleDefeat(state, unit);
      if (unit.instanceId === state.currentId && !unit.alive) {
        state.currentId = null;
        state.currentAp = 0;
        state.pendingDefense = null;
      }
    } else if (!wasAlive) {
      unit.alive = true;
      state.replacementIds = state.replacementIds.filter((id) => id !== unit.instanceId);
      if ((state.phase === "defeat" && unit.team === "player") || (state.phase === "victory" && unit.team === "enemy")) state.phase = "ready";
      addLog(state, unit.name + " is restored by debug controls.", "heal");
    }
    reconcileReplacementQueue(state);
    const ended = checkEnd(state);
    if (!ended && !state.replacementIds.length && !state.currentId) advanceTimeline(state);
    return { ok: true };
  }

  function timelinePreview(state) {
    return timelineUnits(state)
      .slice()
      .sort((a, b) => a.av - b.av || b.speed - a.speed)
      .map((unit) => ({ id: unit.instanceId, name: unit.name, team: unit.team, av: unit.av, color: unit.color }))
      .slice(0, 10);
  }

  window.SGBU.engine = {
    addLog,
    advanceTimeline,
    baseAv,
    capturePersistentResources,
    checkEnd,
    continueBattle,
    clone,
    endPlayerTurn,
    findUnit,
    finishCurrentTurn,
    makeInitialState,
    prepareEnemyAttack,
    protectedRearTarget,
    reactionWindow,
    replaceDefeated,
    resolveDefense,
    setUnitHp,
    startBattle,
    switchUnits,
    timelinePreview,
    useBasic,
    useSkill,
    useUltimate,
    validateData,
    validEnemyTargets,
  };
})();
