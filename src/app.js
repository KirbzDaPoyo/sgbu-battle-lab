(function () {
  const root = document.querySelector("#app");
  const defaults = window.SGBU.data;
  const engine = window.SGBU.engine;
  const storageKey = "sgbu-battle-lab:data-v1";

  let runtimeData = loadRuntimeData();
  let setup = makeSetupState(runtimeData);
  let carriedResources = null;
  let state = engine.makeInitialState(runtimeData, { autoStart: false, seed: setup.seed });
  let history = [];
  let pendingAction = null;
  let selectedDebugId = state.players[0].instanceId;
  let editorOpen = false;
  let debugOpen = true;
  let logOpen = true;
  let enemyTimer = null;
  let defenseFrame = null;
  let defenseTimeout = null;
  let defenseStartedAt = 0;
  let defenseProgress = 0;
  let timersPaused = false;

  let notice = "";
  let noticeTimer = null;

  function loadRuntimeData() {
    try {
      const stored = localStorage.getItem(storageKey);
      if (!stored) return engine.clone(defaults);
      const parsed = JSON.parse(stored);
      const errors = engine.validateData(parsed);
      if (errors.length) throw new Error(errors[0]);
      return parsed;
    } catch {
      return engine.clone(defaults);
    }
  }

  function makeSetupState(source, previous = {}) {
    const availableUnitIds = source.units.map((unit) => unit.id);
    const retainedDeployed = (previous.deployedIds || []).filter((id) => availableUnitIds.includes(id)).slice(0, 4);
    const deployedIds = [...retainedDeployed];
    for (const id of availableUnitIds) {
      if (deployedIds.length >= 4) break;
      if (!deployedIds.includes(id)) deployedIds.push(id);
    }
    const availableEnemyIds = source.enemies.map((enemy) => enemy.id);
    const enemyIds = previous.enemyIds
      ? previous.enemyIds.filter((id) => availableEnemyIds.includes(id))
      : [...availableEnemyIds];
    return {
      deployedIds,
      enemyIds,
      seed: Number.isFinite(previous.seed) ? previous.seed : 137,

      rules: {
        baseAp: previous.rules?.baseAp ?? source.config.baseAp,
        initialSp: previous.rules?.initialSp ?? source.config.initialSp,
        initialEnergyPercent: previous.rules?.initialEnergyPercent ?? source.config.initialEnergyPercent,
        enemyDelayMs: previous.rules?.enemyDelayMs ?? source.config.enemyDelayMs,
        defenseDurationMs: previous.rules?.defenseDurationMs ?? source.config.defenseDurationMs,
        parryWindowScale: previous.rules?.parryWindowScale ?? source.config.parryWindowScale,
      },
    };
  }

  function buildEncounterData() {
    const encounter = engine.clone(runtimeData);
    const deployed = new Set(setup.deployedIds);
    const unitsById = new Map(encounter.units.map((unit) => [unit.id, unit]));
    encounter.units = [
      ...setup.deployedIds.map((id) => unitsById.get(id)).filter(Boolean),
      ...encounter.units.filter((unit) => !deployed.has(unit.id)),
    ];
    const enemies = new Set(setup.enemyIds);
    encounter.enemies = encounter.enemies.filter((enemy) => enemies.has(enemy.id));
    Object.assign(encounter.config, setup.rules);
    return encounter;
  }

  function saveHistory() {
    history.push(engine.clone(state));
    if (history.length > 40) history.shift();
  }

  function mutate(operation) {
    saveHistory();
    const result = operation();
    if (result && result.ok === false) {
      history.pop();
      showNotice(result.reason);
    }
    render();
  }

  function showNotice(message) {
    notice = message;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      notice = "";
      render();
    }, 2800);
  }

  function pct(value, max) {
    return max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  }

  function formatAv(value) {
    return Number(value).toFixed(1);
  }

  function currentActor() {
    return engine.findUnit(state, state.currentId);
  }

  function selectedEnemy() {
    const selected = engine.findUnit(state, state.selectedTargetId);
    if (selected?.alive) return selected;
    return state.enemies.find((unit) => unit.alive) || null;
  }

  function selectedAlly() {
    const selected = engine.findUnit(state, state.selectedAllyId);
    if (selected?.alive && selected.onField) return selected;
    return state.players.find((unit) => unit.alive && unit.onField) || null;
  }

  function actionTargetFor(unit, action) {
    if (["buff", "heal"].includes(action.type)) return selectedAlly()?.instanceId;
    return selectedEnemy()?.instanceId;
  }

  function queueBasic(kind) {
    const actor = currentActor();
    const target = selectedEnemy();
    const definitions = {
      normal: { name: "Normal ATK", description: `Deal ${Math.round(state.config.normalBasicMultiplier * 100)}% ATK damage and gain ${state.config.normalSpGain} SP.`, cost: "1 AP" },
      charged: { name: "Charged ATK", description: `Deal ${Math.round(state.config.chargedBasicMultiplier * 100)}% ATK damage and spend ${state.config.chargedSpCost} SP.`, cost: `1 AP · ${state.config.chargedSpCost} SP` },
      plunge: { name: "Plunging ATK", description: `Deal ${Math.round(state.config.plungeBasicMultiplier * 100)}% ATK damage. Requires Above Ground and consumes that state.`, cost: "1 AP" },
    };
    if (!actor || !target || !definitions[kind]) return;
    pendingAction = { type: "basic", kind, actorName: actor.name, targetId: target.instanceId, targetName: target.name, ...definitions[kind] };
    render();
  }

  function queueSkill() {
    const actor = currentActor();
    if (!actor) return;
    const targetId = actionTargetFor(actor, actor.skill);
    const target = engine.findUnit(state, targetId);
    if (!target) return;
    pendingAction = {
      type: "skill",
      actorName: actor.name,
      name: actor.skill.name,
      description: actor.skill.description,
      cost: `2 AP · ${actor.skill.spCost} SP`,
      targetId,
      targetName: target.name,
    };
    render();
  }

  function confirmPendingAction() {
    const action = pendingAction;
    if (!action) return;
    pendingAction = null;
    if (action.type === "basic") mutate(() => engine.useBasic(state, action.kind, action.targetId));
    else mutate(() => engine.useSkill(state, action.targetId));
  }

  function statusBadges(unit) {
    const badges = [];
    if (unit.shield > 0) badges.push(`<span class="status shield">Shield ${Math.round(unit.shield)}</span>`);
    if (unit.airborne) badges.push('<span class="status airborne">Above ground</span>');
    if (unit.crowdControlled) badges.push('<span class="status cc">Crowd control</span>');
    unit.statuses.forEach((status) => badges.push(`<span class="status">${status.name} · ${status.duration}</span>`));
    return badges.join("");
  }

  function resourceBar(label, value, max, className) {
    return `<div class="resource ${className}"><span>${label}</span><div class="track"><i style="width:${pct(value, max)}%"></i></div><strong>${Math.round(value)}/${max}</strong></div>`;
  }

  function renderEnemy(unit, lane, column) {
    if (!unit) return `<div class="enemy-cell empty" style="grid-column:${column}"></div>`;
    const protectedTarget = engine.protectedRearTarget(state, unit);
    const selected = state.selectedTargetId === unit.instanceId;
    return `
      <button class="enemy-block ${selected ? "selected" : ""} ${!unit.alive ? "defeated" : ""}" style="--unit:${unit.color};grid-column:${column}" data-enemy="${unit.instanceId}" ${!unit.alive ? "disabled" : ""}>
        <span class="enemy-shape">${lane === "rear" ? "R" : "F"}${column}</span>
        <span class="enemy-copy"><strong>${unit.name}</strong><small>${lane} lane · SPD ${unit.speed}</small></span>
        ${protectedTarget ? '<span class="protected">Protected</span>' : ""}
        ${resourceBar("HP", unit.hp, unit.maxHp, "hp")}
        <span class="status-row">${statusBadges(unit)}</span>
      </button>`;
  }

  function renderEnemyLane(lane) {
    const cells = [];
    for (let column = 1; column <= 5; column += 1) {
      const unit = state.enemies.find((enemy) => enemy.lane === lane && enemy.column === column);
      cells.push(renderEnemy(unit, lane, column));
    }
    return `<div class="enemy-lane"><span class="lane-label">${lane}</span><div class="lane-grid">${cells.join("")}</div></div>`;
  }

  function renderPlayerCard(unit) {
    const active = state.currentId === unit.instanceId && state.phase === "player";
    const selected = state.selectedAllyId === unit.instanceId;
    return `
      <button class="unit-card ${active ? "active" : ""} ${selected ? "selected" : ""}" data-ally="${unit.instanceId}" style="--unit:${unit.color}" ${!unit.alive ? "disabled" : ""}>
        <div class="unit-heading"><span class="unit-mark">${unit.slot + 1}</span><span><strong>${unit.name}</strong><small>${unit.className} · ${unit.subclass}</small></span><b>AV ${formatAv(unit.av)}</b></div>
        ${resourceBar("HP", unit.hp, unit.maxHp, "hp")}
        ${resourceBar("SP", unit.sp, unit.maxSp, "sp")}
        ${resourceBar("EN", unit.energy, unit.maxEnergy, "energy")}
        <div class="status-row">${statusBadges(unit) || '<span class="muted">No statuses</span>'}</div>
      </button>`;
  }

  function renderReserve(unit) {
    const canSwitch = state.phase === "player" && !state.switchUsed && unit.alive;
    return `
      <div class="reserve-card ${!unit.alive ? "defeated" : ""}" style="--unit:${unit.color}">
        <span class="reserve-mark"></span>
        <span><strong>${unit.name}</strong><small>${unit.className} · ${unit.subclass}</small></span>
        <span class="reserve-values">HP ${Math.round(unit.hp)} · SP ${Math.round(unit.sp)} · EN ${Math.round(unit.energy)}</span>
        <button class="small-button" data-switch="${unit.instanceId}" ${canSwitch ? "" : "disabled"}>Switch</button>
      </div>`;
  }

  function renderTimeline() {
    return engine.timelinePreview(state).map((item, index) => `
      <div class="timeline-item ${item.id === state.currentId ? "current" : ""}" style="--unit:${item.color}">
        <span>${index + 1}</span><i></i><strong>${item.name}</strong><b>${formatAv(item.av)}</b>
      </div>`).join("");
  }

  function renderActions() {
    const actor = currentActor();
    if (state.phase === "interrupt") {
      const continuation = state.interrupt?.continuation;
      const detail = continuation === "resumePlayer"
        ? `${actor?.name || "The active unit"} has ${state.currentAp} AP remaining.`
        : continuation === "finishTurn"
          ? "The active turn will end when you continue."
          : "The Action Value timeline will advance when you continue.";
      return `<div class="waiting-state ultimate-window"><span class="interrupt-mark">U</span><div><strong>Ultimate window</strong><small>${detail} Use any ready Ultimate now, or continue without one.</small></div><button class="continue-button" data-continue-battle>Continue</button></div>`;
    }
    const enabled = actor?.team === "player" && state.phase === "player";
    if (!enabled) {
      return `<div class="waiting-state"><span class="pulse-dot"></span><div><strong>${state.phase === "enemy" ? "Enemy action approaching" : state.phase === "defense" ? "Defense input required" : state.phase === "victory" ? "Simulation complete" : "Waiting for timeline"}</strong><small>${state.phase === "enemy" ? "The enemy is selecting its targets." : "Use the controls shown for the current phase."}</small></div></div>`;
    }
    const skill = actor.skill;
    return `
      <div class="turn-summary">
        <div><span>Active sequence</span><strong>${actor.name}</strong><small>${actor.className} · ${actor.subclass}</small></div>
        <div class="ap-pips" aria-label="${state.currentAp} AP remaining">${Array.from({ length: Math.max(2, state.currentAp) }, (_, index) => `<i class="${index < state.currentAp ? "filled" : ""}"></i>`).join("")}<b>${state.currentAp} AP</b></div>
      </div>
      <div class="action-grid">
        <button class="action-button" data-basic="normal" ${state.currentAp < 1 ? "disabled" : ""}><span>1 AP</span><strong>Normal ATK</strong><small>${Math.round(state.config.normalBasicMultiplier * 100)}% ATK · +${state.config.normalSpGain} SP</small></button>
        <button class="action-button" data-basic="charged" ${state.currentAp < 1 || actor.sp < state.config.chargedSpCost ? "disabled" : ""}><span>1 AP</span><strong>Charged ATK</strong><small>${Math.round(state.config.chargedBasicMultiplier * 100)}% ATK · −${state.config.chargedSpCost} SP</small></button>
        <button class="action-button" data-basic="plunge" ${state.currentAp < 1 || !actor.airborne ? "disabled" : ""}><span>1 AP</span><strong>Plunging ATK</strong><small>${Math.round(state.config.plungeBasicMultiplier * 100)}% ATK · requires Above Ground</small></button>
        <button class="action-button skill-button" data-skill ${state.currentAp < 2 || actor.sp < skill.spCost ? "disabled" : ""}><span>2 AP · ${skill.spCost} SP</span><strong>${skill.name}</strong><small>${skill.description}</small></button>
      </div>
      <div class="action-footer"><span>Enemy target: <strong>${selectedEnemy()?.name || "None"}</strong></span><span>Ally target: <strong>${selectedAlly()?.name || "None"}</strong></span><button class="text-button" data-end-turn>End sequence</button></div>`;
  }

  function renderUltimates() {
    return state.players.filter((unit) => unit.onField).sort((a, b) => a.slot - b.slot).map((unit) => {
      const ready = unit.alive && unit.energy >= unit.maxEnergy && !state.replacementIds.length && !["defense", "victory", "defeat"].includes(state.phase);
      return `<button class="ultimate-button ${ready ? "ready" : ""}" data-ultimate="${unit.instanceId}" style="--unit:${unit.color}" ${ready ? "" : "disabled"}><span>${unit.name}</span><strong>${unit.ultimate.name}</strong><small class="ultimate-description">${unit.ultimate.description}</small><small class="ultimate-meta">${Math.round(unit.energy)}/${unit.maxEnergy} Energy · 0 AP interrupt</small></button>`;
    }).join("");
  }

  function renderActionConfirmation() {
    if (!pendingAction) return "";
    return `<div class="modal-backdrop"><div class="modal action-confirmation" role="dialog" aria-modal="true" aria-labelledby="action-confirmation-title"><h2 id="action-confirmation-title">Confirm ${pendingAction.name}</h2><p>${pendingAction.description}</p><dl><div><dt>Actor</dt><dd>${pendingAction.actorName}</dd></div><div><dt>Target</dt><dd>${pendingAction.targetName}</dd></div><div><dt>Cost</dt><dd>${pendingAction.cost}</dd></div></dl><div class="confirmation-actions"><button type="button" data-cancel-action>Cancel</button><button type="button" class="confirm-action" data-confirm-action>Use ${pendingAction.name}</button></div></div></div>`;
  }
  function renderLog() {
    return state.log.map((entry) => `<li class="log-${entry.type}"><span>T${entry.turn}</span><p>${entry.message}</p></li>`).join("");
  }

  function renderBreakdown() {
    const item = state.lastBreakdown;
    if (!item) return '<p class="empty-copy">Deal damage to populate the calculation inspector.</p>';
    return `<dl class="breakdown"><div><dt>Hit</dt><dd>${item.attacker} → ${item.target}</dd></div><div><dt>Base</dt><dd>${item.base}</dd></div><div><dt>DEF mult.</dt><dd>${item.defMultiplier.toFixed(3)}</dd></div><div><dt>Vulnerability</dt><dd>×${item.vulnerable.toFixed(2)}</dd></div><div><dt>Weaken</dt><dd>×${item.weaken.toFixed(2)}</dd></div><div><dt>CRIT</dt><dd>${item.crit ? "Yes ×1.50" : "No"}</dd></div><div><dt>Variance</dt><dd>×${item.variance.toFixed(3)}</dd></div><div><dt>Shield</dt><dd>${item.absorbed}</dd></div><div class="total"><dt>Final damage</dt><dd>${item.total}</dd></div></dl>`;
  }

  function renderDebugPanel() {
    const unit = engine.findUnit(state, selectedDebugId) || state.players[0];
    const unitOptions = [...state.players, ...state.enemies].map((item) => `<option value="${item.instanceId}" ${item.instanceId === unit.instanceId ? "selected" : ""}>${item.name} (${item.team})</option>`).join("");
    return `
      <aside class="debug-panel ${debugOpen ? "open" : ""}">
        <button class="panel-heading" data-toggle-debug><span><b>DEBUG</b> Runtime controls</span><i>${debugOpen ? "−" : "+"}</i></button>
        ${debugOpen ? `<div class="debug-body">
          <label class="field wide"><span>Combatant</span><select data-debug-select>${unitOptions}</select></label>
          <label class="field"><span>HP</span><input data-stat="hp" type="number" min="0" max="${unit.maxHp}" value="${Math.round(unit.hp)}"></label>
          <label class="field"><span>SP</span><input data-stat="sp" type="number" min="0" max="${unit.maxSp || 0}" value="${Math.round(unit.sp || 0)}"></label>
          <label class="field"><span>Energy</span><input data-stat="energy" type="number" min="0" max="${unit.maxEnergy || 0}" value="${Math.round(unit.energy || 0)}"></label>
          <label class="field"><span>Action Value</span><input data-stat="av" type="number" min="0" value="${unit.av.toFixed(1)}"></label>
          <label class="check"><input data-flag="airborne" type="checkbox" ${unit.airborne ? "checked" : ""}><span>Above Ground</span></label>
          <label class="check"><input data-flag="crowdControlled" type="checkbox" ${unit.crowdControlled ? "checked" : ""}><span>Crowd Control</span></label>
          <label class="check"><input data-force-crit type="checkbox" ${state.forceCrit ? "checked" : ""}><span>Force CRIT</span></label>
          <label class="check"><input data-pause-timers type="checkbox" ${timersPaused ? "checked" : ""}><span>Pause timing meter</span></label>
          <label class="field wide"><span>Defense outcome</span><select data-force-defense><option value="timed" ${state.forceDefense === "timed" ? "selected" : ""}>Use timing</option><option value="success" ${state.forceDefense === "success" ? "selected" : ""}>Force success</option><option value="fail" ${state.forceDefense === "fail" ? "selected" : ""}>Force failure</option></select></label>

          <div class="debug-buttons"><button data-ready-ults>Fill Ultimates</button><button data-bank-ap>Bank +1 AP</button><button data-undo ${history.length ? "" : "disabled"}>Undo</button><button data-new-encounter>New encounter</button><button data-reset>Full reset</button></div>
          <div class="debug-buttons"><button data-export-log>Export log</button><button data-editor>Open data editor</button></div>
          <section class="inspector"><h3>Damage breakdown</h3>${renderBreakdown()}</section>
        </div>` : ""}
      </aside>`;
  }

  function renderReplacement() {
    if (!state.replacementIds.length) return "";
    const defeated = engine.findUnit(state, state.replacementIds[0]);
    const reserves = state.players.filter((unit) => unit.alive && !unit.onField);
    return `<div class="modal-backdrop"><div class="modal replacement-modal"><span class="eyebrow">Forced deployment</span><h2>${defeated.name} was defeated</h2><p>Select a living reserve to occupy slot ${defeated.slot + 1}. The timeline will resume after replacement.</p><div class="replacement-list">${reserves.map((unit) => `<button data-replace="${unit.instanceId}" style="--unit:${unit.color}"><i></i><span><strong>${unit.name}</strong><small>${unit.className} · ${unit.subclass}</small></span></button>`).join("")}</div></div></div>`;
  }

  function renderDefense() {
    if (state.phase !== "defense" || !state.pendingDefense) return "";
    const enemy = engine.findUnit(state, state.pendingDefense.enemyId);
    const targets = state.pendingDefense.targetIds.map((id) => engine.findUnit(state, id)).filter(Boolean);
    const dodge = engine.reactionWindow(state, "dodge");
    const parry = engine.reactionWindow(state, "parry");
    return `<div class="modal-backdrop defense-backdrop"><div class="modal defense-modal">
      <span class="eyebrow">Enemy reaction window</span><h2>${enemy.name} attacks ${targets.map((unit) => unit.name).join(" + ")}</h2>
      <p>One input resolves this entire ${targets.length > 1 ? "multi-target" : "single-target"} attack. Crowd-controlled allies cannot benefit.</p>
      <div class="timing-meter" style="--dodge:${dodge * 100}%;--parry:${parry * 100}%"><div class="dodge-zone"></div><div class="parry-zone"></div><i data-cursor></i></div>
      <div class="timing-legend"><span><i class="dodge-key"></i>Dodge window ${(dodge * 100).toFixed(1)}%</span><span><i class="parry-key"></i>Parry window ${(parry * 100).toFixed(1)}%</span></div>
      <div class="defense-actions"><button data-defense="dodge"><kbd>D</kbd><span><strong>Dodge</strong><small>Avoid the hit</small></span></button><button class="parry" data-defense="parry"><kbd>P</kbd><span><strong>Parry</strong><small>Bank +1 AP next turn</small></span></button><button class="take-hit" data-defense="hit"><span><strong>Take hit</strong><small>Skip reaction</small></span></button></div>
    </div></div>`;
  }

  function renderEditor() {
    if (!editorOpen) return "";
    return `<div class="modal-backdrop"><div class="modal editor-modal"><div class="editor-heading"><div><span class="eyebrow">Runtime data</span><h2>Unit and rules editor</h2></div><button data-close-editor aria-label="Close editor">×</button></div><p>Edit the JSON and apply it to reopen encounter setup. Changes are stored only in this browser.</p><textarea data-editor-json spellcheck="false">${escapeHtml(JSON.stringify(runtimeData, null, 2))}</textarea><div class="editor-actions"><button data-download-data>Download JSON</button><button data-restore-data>Restore defaults</button><button class="primary" data-apply-data>Apply to setup</button></div></div></div>`;
  }

  function escapeHtml(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function renderSetupUnit(unit) {
    const fieldIndex = setup.deployedIds.indexOf(unit.id);
    const selected = fieldIndex >= 0;
    return `
      <button type="button" class="setup-unit ${selected ? "selected" : ""}" data-setup-unit="${unit.id}" style="--unit:${unit.color}" aria-pressed="${selected}">
        <span class="setup-unit-mark">${selected ? fieldIndex + 1 : "R"}</span>
        <span class="setup-unit-copy"><strong>${unit.name}</strong><small>${unit.className} · ${unit.subclass}</small></span>
        <span class="setup-unit-stats"><b>SPD ${unit.speed}</b><b>HP ${unit.maxHp}</b></span>
        <span class="setup-unit-state">${selected ? "On field" : "Reserve"}</span>
      </button>`;
  }

  function renderSetupEnemy(enemy) {
    const selected = setup.enemyIds.includes(enemy.id);
    return `
      <button type="button" class="setup-enemy ${selected ? "selected" : ""}" data-setup-enemy="${enemy.id}" style="--unit:${enemy.color}" aria-pressed="${selected}">
        <span class="setup-enemy-mark">${enemy.lane === "front" ? "F" : "R"}${enemy.column}</span>
        <span><strong>${enemy.name}</strong><small>${enemy.lane} lane · column ${enemy.column}</small></span>
        <b>${selected ? "Included" : "Excluded"}</b>
      </button>`;
  }

  function renderSetup() {
    const ready = setup.deployedIds.length === 4 && setup.enemyIds.length > 0;
    const reserveCount = Math.max(0, runtimeData.units.length - setup.deployedIds.length);
    return `
      <header class="app-header"><div class="brand"><span class="brand-mark">S</span><div><strong>SGBU Battle Lab</strong><small>MECHANICS SIMULATOR · BUILD 0.1</small></div></div><div class="header-state"><span class="phase phase-setup">setup</span><span>Battle paused</span><span>Seed ${setup.seed}</span></div></header>
      <main class="setup-shell">
        <section class="setup-lead">
          <div>
            <h1>Configure the encounter</h1>
            <p>Choose the active formation, opposition, and test conditions. The Action Value timeline begins only after you confirm this screen.</p>
          </div>
          <dl class="setup-summary">
            <div><dt>On field</dt><dd>${setup.deployedIds.length}/4</dd></div>
            <div><dt>Reserves</dt><dd>${reserveCount}</dd></div>
            <div><dt>Enemies</dt><dd>${setup.enemyIds.length}</dd></div>
          </dl>
        </section>
        <div class="setup-layout">
          <section class="panel setup-section setup-roster">
            <div class="setup-section-heading"><div><h2>Player formation</h2><p>Select exactly four units. Selection order determines field slots; everyone else begins in reserve.</p></div><span>${setup.deployedIds.length === 4 ? "Formation ready" : "Select " + (4 - setup.deployedIds.length) + " more"}</span></div>
            <div class="setup-unit-grid">${runtimeData.units.map(renderSetupUnit).join("")}</div>
          </section>
          <aside class="setup-side">
            <section class="panel setup-section">
              <div class="setup-section-heading"><div><h2>Test conditions</h2><p>Common encounter controls. Every other value remains available in the JSON editor.</p></div></div>
              <div class="setup-rule-grid">
                <label><span>Seed</span><input data-setup-seed type="number" min="0" step="1" value="${setup.seed}"></label>

                <label><span>Base AP</span><input data-setup-rule="baseAp" type="number" min="1" max="10" step="1" value="${setup.rules.baseAp}"></label>
                <label><span>Initial SP</span><input data-setup-rule="initialSp" type="number" min="0" step="1" value="${setup.rules.initialSp}"></label>
                <label><span>Initial Energy (%)</span><input data-setup-rule="initialEnergyPercent" type="number" min="0" max="100" step="1" value="${setup.rules.initialEnergyPercent}"><small>percent of each unit's maximum</small></label>
                <label><span>Enemy delay</span><input data-setup-rule="enemyDelayMs" type="number" min="0" step="50" value="${setup.rules.enemyDelayMs}"><small>milliseconds</small></label>
                <label><span>Defense meter</span><input data-setup-rule="defenseDurationMs" type="number" min="250" step="50" value="${setup.rules.defenseDurationMs}"><small>milliseconds</small></label>
                <label><span>Parry scale</span><input data-setup-rule="parryWindowScale" type="number" min="0.1" max="1" step="0.01" value="${setup.rules.parryWindowScale}"></label>
              </div>
            </section>
            <section class="panel setup-section setup-enemies">
              <div class="setup-section-heading"><div><h2>Enemy formation</h2><p>Toggle combatants without changing their configured lane or column.</p></div><span>${setup.enemyIds.length} active</span></div>
              <div class="setup-enemy-list">${runtimeData.enemies.map(renderSetupEnemy).join("")}</div>
            </section>
            <section class="setup-launch">
              <div><strong>${ready ? "Encounter ready" : "Configuration incomplete"}</strong><small>${carriedResources ? "Personal SP and Energy will carry into this encounter." : "Units begin with the configured personal resources."}</small></div>
              <div class="setup-launch-actions"><button type="button" data-setup-defaults>Reset setup</button><button type="button" data-editor>Advanced JSON</button><button type="button" class="setup-start" data-start-battle ${ready ? "" : "disabled"}>Start battle</button></div>
            </section>
          </aside>
        </div>
      </main>
      ${notice ? `<div class="toast">${notice}</div>` : ""}
      ${renderEditor()}`;
  }

  function render() {
    if (state.phase === "setup") {
      root.innerHTML = renderSetup();
      bindSetupEvents();
      return;
    }
    const deployed = state.players.filter((unit) => unit.onField).sort((a, b) => a.slot - b.slot);
    const reserves = state.players.filter((unit) => !unit.onField);
    root.innerHTML = `
      <header class="app-header"><div class="brand"><span class="brand-mark">S</span><div><strong>SGBU Battle Lab</strong><small>MECHANICS SIMULATOR · BUILD 0.1</small></div></div><div class="header-state"><span class="phase phase-${state.phase}">${state.phase}</span><span>Turn ${state.turn}</span><span>Seed ${state.seed}</span></div></header>
      <main class="workspace">
        <section class="battle-column">
          <div class="arena panel"><div class="panel-title"><span><b>ENCOUNTER</b> Front / rear formation</span><span>${state.enemies.filter((unit) => unit.alive).length} targets online</span></div>${renderEnemyLane("rear")}${renderEnemyLane("front")}</div>
          <div class="party-grid">${deployed.map(renderPlayerCard).join("")}</div>
          <div class="action-panel panel">${renderActions()}<div class="ultimate-strip"><span class="strip-label">Interrupt Ultimates</span>${renderUltimates()}</div></div>
          <div class="reserve-panel panel"><div class="panel-title"><span><b>RESERVES</b> Free switch during the active turn</span><span>${reserves.filter((unit) => unit.alive).length} available</span></div><div class="reserve-list">${reserves.map(renderReserve).join("") || '<p class="empty-copy">No reserve units.</p>'}</div></div>
        </section>
        <aside class="side-column"><section class="timeline panel"><div class="panel-title"><span><b>TIMELINE</b> Live Action Value</span></div><div class="timeline-list">${renderTimeline()}</div></section>${renderDebugPanel()}<section class="combat-log panel ${logOpen ? "open" : ""}"><button class="panel-heading" data-toggle-log><span><b>LOG</b> Combat events</span><i>${logOpen ? "−" : "+"}</i></button>${logOpen ? `<ol>${renderLog()}</ol>` : ""}</section></aside>
      </main>
      ${notice ? `<div class="toast">${notice}</div>` : ""}
      ${renderDefense()}${renderReplacement()}${renderActionConfirmation()}${renderEditor()}`;
    bindEvents();
    if (!editorOpen && state.phase === "enemy") scheduleEnemyAttack();
    if (!editorOpen && state.phase === "defense") startDefenseMeter();
  }

  function bindSetupEvents() {
    root.querySelectorAll("[data-setup-unit]").forEach((button) => button.addEventListener("click", () => {
      const id = button.dataset.setupUnit;
      if (setup.deployedIds.includes(id)) {
        setup.deployedIds = setup.deployedIds.filter((unitId) => unitId !== id);
      } else if (setup.deployedIds.length < 4) {
        setup.deployedIds.push(id);
      } else {
        showNotice("Four field slots are already assigned. Remove one before adding another.");
      }
      render();
    }));
    root.querySelectorAll("[data-setup-enemy]").forEach((button) => button.addEventListener("click", () => {
      const id = button.dataset.setupEnemy;
      setup.enemyIds = setup.enemyIds.includes(id)
        ? setup.enemyIds.filter((enemyId) => enemyId !== id)
        : [...setup.enemyIds, id];
      render();
    }));
    root.querySelectorAll("[data-setup-rule]").forEach((input) => input.addEventListener("change", () => {
      setup.rules[input.dataset.setupRule] = Number(input.value);
      render();
    }));
    root.querySelector("[data-setup-seed]")?.addEventListener("change", (event) => {
      setup.seed = Math.max(0, Math.floor(Number(event.target.value) || 0));
      render();
    });

    root.querySelector("[data-setup-defaults]")?.addEventListener("click", () => {
      setup = makeSetupState(runtimeData);
      render();
    });
    root.querySelector("[data-start-battle]")?.addEventListener("click", startConfiguredBattle);
    root.querySelector("[data-editor]")?.addEventListener("click", () => {
      editorOpen = true;
      render();
    });
    root.querySelector("[data-close-editor]")?.addEventListener("click", () => {
      editorOpen = false;
      render();
    });
    root.querySelector("[data-apply-data]")?.addEventListener("click", applyEditorData);
    root.querySelector("[data-restore-data]")?.addEventListener("click", restoreDefaults);
    root.querySelector("[data-download-data]")?.addEventListener("click", () => download("sgbu-battle-data.json", JSON.stringify(runtimeData, null, 2), "application/json"));
  }

  function bindEvents() {
    root.querySelectorAll("[data-enemy]").forEach((button) => button.addEventListener("click", () => {
      state.selectedTargetId = button.dataset.enemy;
      render();
    }));
    root.querySelectorAll("[data-ally]").forEach((button) => button.addEventListener("click", () => {
      state.selectedAllyId = button.dataset.ally;
      render();
    }));
    root.querySelectorAll("[data-basic]").forEach((button) => button.addEventListener("click", () => queueBasic(button.dataset.basic)));
    root.querySelector("[data-skill]")?.addEventListener("click", queueSkill);
    root.querySelector("[data-cancel-action]")?.addEventListener("click", () => {
      pendingAction = null;
      render();
    });
    root.querySelector("[data-confirm-action]")?.addEventListener("click", confirmPendingAction);
    root.querySelector("[data-continue-battle]")?.addEventListener("click", () => mutate(() => engine.continueBattle(state)));
    root.querySelectorAll("[data-ultimate]").forEach((button) => button.addEventListener("click", () => {
      const actor = engine.findUnit(state, button.dataset.ultimate);
      mutate(() => engine.useUltimate(state, actor.instanceId, actionTargetFor(actor, actor.ultimate)));
    }));
    root.querySelectorAll("[data-switch]").forEach((button) => button.addEventListener("click", () => mutate(() => engine.switchUnits(state, button.dataset.switch))));
    root.querySelector("[data-end-turn]")?.addEventListener("click", () => mutate(() => engine.endPlayerTurn(state)));

    root.querySelectorAll("[data-defense]").forEach((button) => button.addEventListener("click", () => submitDefense(button.dataset.defense)));
    root.querySelectorAll("[data-replace]").forEach((button) => button.addEventListener("click", () => mutate(() => engine.replaceDefeated(state, state.replacementIds[0], button.dataset.replace))));
    root.querySelector("[data-toggle-debug]")?.addEventListener("click", () => { debugOpen = !debugOpen; render(); });
    root.querySelector("[data-toggle-log]")?.addEventListener("click", () => { logOpen = !logOpen; render(); });
    root.querySelector("[data-debug-select]")?.addEventListener("change", (event) => { selectedDebugId = event.target.value; render(); });
    root.querySelectorAll("[data-stat]").forEach((input) => input.addEventListener("change", () => {
      const unit = engine.findUnit(state, selectedDebugId);
      if (!unit) return;
      saveHistory();
      const key = input.dataset.stat;
      if (key === "hp") {
        const result = engine.setUnitHp(state, unit.instanceId, input.value);
        if (!result.ok) showNotice(result.reason);
      } else {
        const maximum = key === "sp" ? unit.maxSp : key === "energy" ? unit.maxEnergy : Number.POSITIVE_INFINITY;
        unit[key] = Math.max(0, Math.min(maximum, Number(input.value) || 0));
      }
      render();
    }));
    root.querySelectorAll("[data-flag]").forEach((input) => input.addEventListener("change", () => {
      const unit = engine.findUnit(state, selectedDebugId);
      if (!unit) return;
      saveHistory();
      unit[input.dataset.flag] = input.checked;
      render();
    }));
    root.querySelector("[data-force-crit]")?.addEventListener("change", (event) => { state.forceCrit = event.target.checked; render(); });
    root.querySelector("[data-pause-timers]")?.addEventListener("change", (event) => { timersPaused = event.target.checked; render(); });
    root.querySelector("[data-force-defense]")?.addEventListener("change", (event) => { state.forceDefense = event.target.value; });

    root.querySelector("[data-ready-ults]")?.addEventListener("click", () => mutate(() => {
      state.players.filter((unit) => unit.onField && unit.alive).forEach((unit) => { unit.energy = unit.maxEnergy; });
      return { ok: true };
    }));
    root.querySelector("[data-bank-ap]")?.addEventListener("click", () => mutate(() => {
      const unit = engine.findUnit(state, selectedDebugId);
      if (!unit || unit.team !== "player") return { ok: false, reason: "Select an allied unit." };
      unit.apBonus += 1;
      return { ok: true };
    }));
    root.querySelector("[data-undo]")?.addEventListener("click", undo);
    root.querySelector("[data-new-encounter]")?.addEventListener("click", newEncounter);
    root.querySelector("[data-reset]")?.addEventListener("click", resetBattle);
    root.querySelector("[data-export-log]")?.addEventListener("click", exportLog);
    root.querySelector("[data-editor]")?.addEventListener("click", () => {
      clearTimeout(enemyTimer);
      enemyTimer = null;
      editorOpen = true;
      render();
    });
    root.querySelector("[data-close-editor]")?.addEventListener("click", () => { editorOpen = false; render(); });
    root.querySelector("[data-apply-data]")?.addEventListener("click", applyEditorData);
    root.querySelector("[data-restore-data]")?.addEventListener("click", restoreDefaults);
    root.querySelector("[data-download-data]")?.addEventListener("click", () => download("sgbu-battle-data.json", JSON.stringify(runtimeData, null, 2), "application/json"));
  }

  function scheduleEnemyAttack() {
    if (enemyTimer) return;
    enemyTimer = setTimeout(() => {
      enemyTimer = null;
      if (state.phase !== "enemy") return;
      saveHistory();
      engine.prepareEnemyAttack(state);
      render();
    }, state.config.enemyDelayMs);
  }

  function startDefenseMeter() {
    cancelDefenseTimers();
    defenseStartedAt = performance.now();
    const duration = state.config.defenseDurationMs;
    const cursor = root.querySelector("[data-cursor]");
    function frame(now) {
      if (state.phase !== "defense") return;
      if (!timersPaused) defenseProgress = Math.min(1, (now - defenseStartedAt) / duration);
      else defenseStartedAt = now - defenseProgress * duration;
      if (cursor) cursor.style.left = `${defenseProgress * 100}%`;
      if (defenseProgress < 1) defenseFrame = requestAnimationFrame(frame);
    }
    defenseFrame = requestAnimationFrame(frame);
    defenseTimeout = setTimeout(() => {
      if (state.phase === "defense" && !timersPaused) submitDefense("hit");
    }, duration + state.config.defenseTimeoutGraceMs);
  }

  function cancelDefenseTimers() {
    if (defenseFrame) cancelAnimationFrame(defenseFrame);
    if (defenseTimeout) clearTimeout(defenseTimeout);
    defenseFrame = null;
    defenseTimeout = null;
  }

  function submitDefense(mode) {
    cancelDefenseTimers();
    const actualMode = mode === "hit" ? "dodge" : mode;
    const windowSize = engine.reactionWindow(state, actualMode);
    const success = mode !== "hit" && Math.abs(defenseProgress - 0.5) <= windowSize / 2;
    mutate(() => engine.resolveDefense(state, actualMode, success));
  }

  function undo() {
    if (!history.length) return;
    clearTimeout(enemyTimer);
    enemyTimer = null;
    cancelDefenseTimers();
    state = history.pop();
    pendingAction = null;
    render();
  }

  function openSetup(resources = null, resetConfiguration = false, message = "") {
    clearTimeout(enemyTimer);
    enemyTimer = null;
    cancelDefenseTimers();
    history = [];
    pendingAction = null;
    if (resetConfiguration) setup = makeSetupState(runtimeData);
    carriedResources = resources;
    state = engine.makeInitialState(runtimeData, { autoStart: false, resources: carriedResources || undefined, seed: setup.seed });
    selectedDebugId = state.players[0].instanceId;
    editorOpen = false;
    if (message) showNotice(message);
    render();
  }

  function startConfiguredBattle() {
    if (setup.deployedIds.length !== 4 || !setup.enemyIds.length) {
      showNotice("Select four on-field units and at least one enemy.");
      render();
      return;
    }
    try {
      const encounterData = buildEncounterData();
      const errors = engine.validateData(encounterData);
      if (errors.length) throw new Error(errors.join(" "));
      state = engine.makeInitialState(encounterData, {
        autoStart: false,
        resources: carriedResources || undefined,
        seed: setup.seed,
      });
      const result = engine.startBattle(state);
      if (!result.ok) throw new Error(result.reason);
      history = [];
      pendingAction = null;
      carriedResources = null;

      selectedDebugId = state.players[0].instanceId;
      render();
    } catch (error) {
      showNotice("Setup error: " + error.message);
      render();
    }
  }

  function resetBattle() {
    openSetup(null, true, "Battle reset. Configure the next encounter.");
  }

  function newEncounter() {
    openSetup(engine.capturePersistentResources(state), false, "Encounter setup opened; personal SP and Energy are preserved.");
  }

  function applyEditorData() {
    const textarea = root.querySelector("[data-editor-json]");
    try {
      const parsed = JSON.parse(textarea.value);
      const errors = engine.validateData(parsed);
      if (errors.length) throw new Error(errors.join(" "));
      runtimeData = parsed;
      localStorage.setItem(storageKey, JSON.stringify(runtimeData));
      setup = makeSetupState(runtimeData);
      openSetup(null, false, "Runtime data applied. Review the encounter before starting.");
    } catch (error) {
      showNotice(`JSON error: ${error.message}`);
      render();
    }
  }

  function restoreDefaults() {
    runtimeData = engine.clone(defaults);
    localStorage.removeItem(storageKey);
    setup = makeSetupState(runtimeData);
    openSetup(null, false, "Default data restored. Review the encounter before starting.");
  }

  function exportLog() {
    const lines = [...state.log].reverse().map((entry) => `[Turn ${entry.turn}] ${entry.message}`);
    const breakdown = state.lastBreakdown ? `\n\nLast damage breakdown:\n${JSON.stringify(state.lastBreakdown, null, 2)}` : "";
    download("sgbu-combat-log.txt", lines.join("\n") + breakdown, "text/plain");
  }

  function download(name, contents, type) {
    const blob = new Blob([contents], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
  }

  document.addEventListener("keydown", (event) => {
    if (state.phase !== "defense") return;
    if (event.key.toLowerCase() === "d") submitDefense("dodge");
    if (event.key.toLowerCase() === "p") submitDefense("parry");
  });

  render();
})();
