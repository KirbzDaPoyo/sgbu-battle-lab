(function () {
  const root = document.querySelector("#app");
  const defaults = window.SGBU.data;
  const engine = window.SGBU.engine;
  const storageKey = "sgbu-battle-lab:data-v1";

  let runtimeData = loadRuntimeData();
  let state = engine.makeInitialState(runtimeData);
  let history = [];
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
  let battleSpeed = 1;
  let notice = "";
  let noticeTimer = null;

  function loadRuntimeData() {
    try {
      const stored = localStorage.getItem(storageKey);
      if (!stored) return engine.clone(defaults);
      const parsed = JSON.parse(stored);
      if (!Array.isArray(parsed.units) || !Array.isArray(parsed.enemies) || !parsed.config) throw new Error("Invalid data");
      return parsed;
    } catch {
      return engine.clone(defaults);
    }
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
        <button class="action-button" data-basic="normal" ${state.currentAp < 1 ? "disabled" : ""}><span>1 AP</span><strong>Normal ATK</strong><small>100% ATK · +${state.config.normalSpGain} SP</small></button>
        <button class="action-button" data-basic="charged" ${state.currentAp < 1 || actor.sp < state.config.chargedSpCost ? "disabled" : ""}><span>1 AP</span><strong>Charged ATK</strong><small>155% ATK · −${state.config.chargedSpCost} SP</small></button>
        <button class="action-button" data-basic="plunge" ${state.currentAp < 1 || !actor.airborne ? "disabled" : ""}><span>1 AP</span><strong>Plunging ATK</strong><small>135% ATK · requires Above Ground</small></button>
        <button class="action-button skill-button" data-skill ${state.currentAp < 2 || actor.sp < skill.spCost ? "disabled" : ""}><span>2 AP · ${skill.spCost} SP</span><strong>${skill.name}</strong><small>${skill.description}</small></button>
      </div>
      <div class="action-footer"><span>Enemy target: <strong>${selectedEnemy()?.name || "None"}</strong></span><span>Ally target: <strong>${selectedAlly()?.name || "None"}</strong></span><button class="text-button" data-end-turn>End sequence</button></div>`;
  }

  function renderUltimates() {
    return state.players.filter((unit) => unit.onField).sort((a, b) => a.slot - b.slot).map((unit) => {
      const ready = unit.alive && unit.energy >= unit.maxEnergy && !["defense", "victory", "defeat"].includes(state.phase);
      return `<button class="ultimate-button ${ready ? "ready" : ""}" data-ultimate="${unit.instanceId}" style="--unit:${unit.color}" ${ready ? "" : "disabled"}><span>${unit.name}</span><strong>${unit.ultimate.name}</strong><small>${Math.round(unit.energy)}/${unit.maxEnergy} Energy · 0 AP interrupt</small></button>`;
    }).join("");
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
          <label class="field wide"><span>Battle speed</span><input data-speed type="range" min="0.5" max="2" step="0.25" value="${battleSpeed}"><output>${battleSpeed.toFixed(2)}×</output></label>
          <div class="debug-buttons"><button data-ready-ults>Fill Ultimates</button><button data-bank-ap>Bank +1 AP</button><button data-undo ${history.length ? "" : "disabled"}>Undo</button><button data-reset>Reset battle</button></div>
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
    return `<div class="modal-backdrop"><div class="modal editor-modal"><div class="editor-heading"><div><span class="eyebrow">Runtime data</span><h2>Unit and rules editor</h2></div><button data-close-editor aria-label="Close editor">×</button></div><p>Edit the JSON, apply it, and the battle will reset. Changes are stored only in this browser.</p><textarea data-editor-json spellcheck="false">${escapeHtml(JSON.stringify(runtimeData, null, 2))}</textarea><div class="editor-actions"><button data-download-data>Download JSON</button><button data-restore-data>Restore defaults</button><button class="primary" data-apply-data>Apply and reset</button></div></div></div>`;
  }

  function escapeHtml(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function render() {
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
      ${renderDefense()}${renderReplacement()}${renderEditor()}`;
    bindEvents();
    if (!editorOpen && state.phase === "enemy") scheduleEnemyAttack();
    if (!editorOpen && state.phase === "defense") startDefenseMeter();
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
    root.querySelectorAll("[data-basic]").forEach((button) => button.addEventListener("click", () => mutate(() => engine.useBasic(state, button.dataset.basic, selectedEnemy()?.instanceId))));
    root.querySelector("[data-skill]")?.addEventListener("click", () => {
      const actor = currentActor();
      mutate(() => engine.useSkill(state, actionTargetFor(actor, actor.skill)));
    });
    root.querySelectorAll("[data-ultimate]").forEach((button) => button.addEventListener("click", () => {
      const actor = engine.findUnit(state, button.dataset.ultimate);
      mutate(() => engine.useUltimate(state, actor.instanceId, actionTargetFor(actor, actor.ultimate)));
    }));
    root.querySelectorAll("[data-switch]").forEach((button) => button.addEventListener("click", () => mutate(() => engine.switchUnits(state, button.dataset.switch))));
    root.querySelector("[data-end-turn]")?.addEventListener("click", () => mutate(() => {
      engine.finishCurrentTurn(state);
      return { ok: true };
    }));
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
      const maximum = key === "hp" ? unit.maxHp : key === "sp" ? unit.maxSp : key === "energy" ? unit.maxEnergy : Number.POSITIVE_INFINITY;
      unit[key] = Math.max(0, Math.min(maximum, Number(input.value) || 0));
      if (key === "hp") unit.alive = unit.hp > 0;
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
    root.querySelector("[data-speed]")?.addEventListener("input", (event) => { battleSpeed = Number(event.target.value); event.target.nextElementSibling.value = `${battleSpeed.toFixed(2)}×`; });
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
    }, 550 / battleSpeed);
  }

  function startDefenseMeter() {
    cancelDefenseTimers();
    defenseStartedAt = performance.now();
    const duration = 2100 / battleSpeed;
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
    }, duration + 120);
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
    render();
  }

  function resetBattle() {
    clearTimeout(enemyTimer);
    enemyTimer = null;
    cancelDefenseTimers();
    history = [];
    state = engine.makeInitialState(runtimeData);
    selectedDebugId = state.players[0].instanceId;
    render();
  }

  function applyEditorData() {
    const textarea = root.querySelector("[data-editor-json]");
    try {
      const parsed = JSON.parse(textarea.value);
      if (!Array.isArray(parsed.units) || !parsed.units.length || !Array.isArray(parsed.enemies) || !parsed.enemies.length || !parsed.config) throw new Error("Data requires config, units, and enemies.");
      runtimeData = parsed;
      localStorage.setItem(storageKey, JSON.stringify(runtimeData));
      editorOpen = false;
      resetBattle();
      showNotice("Runtime data applied.");
    } catch (error) {
      showNotice(`JSON error: ${error.message}`);
    }
  }

  function restoreDefaults() {
    runtimeData = engine.clone(defaults);
    localStorage.removeItem(storageKey);
    editorOpen = false;
    resetBattle();
    showNotice("Default data restored.");
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
