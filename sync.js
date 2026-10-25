"use strict";
/* Aguacater · sincronización entre dispositivos a través de un repositorio privado de GitHub.
   Cada dispositivo guarda en local como siempre; este módulo sube y baja datos.json.
   Fusión por registro: gana la modificación más reciente; los borrados se recuerdan. */
(function () {
  const CFG_KEY = "aguacater.sync";
  const FMT = "aguacater-sync-1";
  const TRACK = ["parcelas", "registros", "compras", "recuentos", "productos", "aplicadores", "equipos"];
  let cfg = {};
  try { cfg = JSON.parse(localStorage.getItem(CFG_KEY) || "{}"); } catch (e) {}
  if (!cfg.owner) cfg.owner = "estherdompal-sys";
  if (!cfg.repo) cfg.repo = "aguacater-datos";
  const saveCfg = () => { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) {} };
  const ready = () => !!(cfg.token && cfg.owner && cfg.repo);
  let st = {state: ready() ? "idle" : "off", msg: ""};

  /* ---------- detección de cambios ---------- */
  const strip = o => { const c = Object.assign({}, o); delete c.mod; return JSON.stringify(c); };
  const settingsObj = () => ({explot: S.explot, receta: S.ajustes.receta || null, inicioMes: S.ajustes.inicioMes || 1});
  function takeSnap() {
    const m = {};
    TRACK.forEach(k => (S[k] || []).forEach(it => { m[k + "/" + it.id] = strip(it); }));
    m._ajustes = JSON.stringify(settingsObj());
    return m;
  }
  let snap = null;
  function stamp() {
    S.borrados = S.borrados || {}; S.syncMod = S.syncMod || {};
    if (!snap) { snap = takeSnap(); return false; }
    const now = Date.now(); const cur = takeSnap(); let changed = false;
    TRACK.forEach(k => (S[k] || []).forEach(it => { const key = k + "/" + it.id; if (snap[key] !== cur[key]) { it.mod = now; changed = true; } }));
    for (const key in snap) if (key !== "_ajustes" && !(key in cur)) { S.borrados[key] = now; changed = true; }
    if (snap._ajustes !== cur._ajustes) { S.syncMod.ajustes = now; changed = true; }
    snap = takeSnap();
    return changed;
  }

  /* ---------- fusión ---------- */
  function payload() {
    const o = {formato: FMT, borrados: S.borrados || {}, syncMod: S.syncMod || {}, ajustes: settingsObj()};
    TRACK.forEach(k => { o[k] = (S[k] || []).filter(x => !x.ejemplo); });
    return o;
  }
  function merge(remote) {
    S.borrados = S.borrados || {}; S.syncMod = S.syncMod || {};
    const tomb = Object.assign({}, remote.borrados || {});
    for (const k in S.borrados) tomb[k] = Math.max(tomb[k] || 0, S.borrados[k]);
    const remoteReal = ["parcelas", "registros"].some(k => (remote[k] || []).length);
    TRACK.forEach(k => {
      const map = new Map();
      (S[k] || []).forEach(it => { if (!(remoteReal && it.ejemplo)) map.set(it.id, it); });
      (remote[k] || []).forEach(it => { const l = map.get(it.id); if (!l || (it.mod || 0) > (l.mod || 0)) map.set(it.id, it); });
      S[k] = [...map.values()].filter(it => !((tomb[k + "/" + it.id] || 0) >= (it.mod || 0) && tomb[k + "/" + it.id]));
    });
    S.borrados = tomb;
    const rm = (remote.syncMod && remote.syncMod.ajustes) || 0;
    if (rm > (S.syncMod.ajustes || 0) && remote.ajustes) {
      if (remote.ajustes.explot) S.explot = remote.ajustes.explot;
      if (remote.ajustes.receta) S.ajustes.receta = remote.ajustes.receta;
      if (remote.ajustes.inicioMes) S.ajustes.inicioMes = remote.ajustes.inicioMes;
      S.syncMod.ajustes = rm;
    }
  }

  /* ---------- GitHub ---------- */
  const enc = s => { const b = new TextEncoder().encode(s); let bin = ""; for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(bin); };
  const dec = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), c => c.charCodeAt(0)));
  const url = () => `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/datos.json`;
  async function gh(method, body) {
    const h = {Authorization: "Bearer " + cfg.token, Accept: "application/vnd.github+json"};
    if (body) h["Content-Type"] = "application/json";
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
    try { return await fetch(url(), {method, headers: h, cache: "no-store", signal: ctl.signal, body: body ? JSON.stringify(body) : undefined}); }
    finally { clearTimeout(t); }
  }
  function httpMsg(code, writing) {
    if (code === 401) return "La clave de acceso no es válida o ha caducado. Crea una nueva y pégala en Más → Sincronización.";
    if (code === 403) return "La clave no tiene permiso de escritura en el repositorio. Revisa que tenga «Contents: Read and write».";
    if (code === 404) return writing ? "No encuentro el repositorio " + cfg.owner + "/" + cfg.repo + ", o la clave no da acceso a él." : "";
    return "GitHub respondió con el código " + code + ". Prueba más tarde.";
  }

  let busy = false, again = false, timer = null;
  async function sync() {
    if (!ready()) { setStatus("off"); return; }
    if (!navigator.onLine) { setStatus("offline"); return; }
    if (busy) { again = true; return; }
    busy = true; setStatus("busy");
    try {
      let done = false;
      for (let i = 0; i < 3 && !done; i++) {
        const r = await gh("GET");
        let remote = null, sha = null;
        if (r.status === 200) {
          const j = await r.json(); sha = j.sha;
          try { remote = JSON.parse(dec(j.content)); } catch (e) { throw new Error("El archivo datos.json del repositorio está dañado."); }
          if (remote.formato !== FMT) throw new Error("El archivo datos.json no es de Aguacater.");
        } else if (r.status !== 404) throw new Error(httpMsg(r.status, false));
        if (stamp()) baseSave();
        const before = JSON.stringify(S);
        if (remote) merge(remote);
        snap = takeSnap();
        if (JSON.stringify(S) !== before) { baseSave(); afterPull(); }
        const body = JSON.stringify(payload(), null, 1);
        if (remote && body === JSON.stringify(remote, null, 1)) { done = true; break; }
        const w = await gh("PUT", {message: `Datos desde ${cfg.device || "un dispositivo"}`, content: enc(body), ...(sha ? {sha} : {})});
        if (w.status === 200 || w.status === 201) { done = true; break; }
        if (w.status === 409 || w.status === 422) continue;
        throw new Error(httpMsg(w.status, true));
      }
      if (!done) throw new Error("Otro dispositivo está guardando a la vez. Vuelve a intentarlo.");
      cfg.last = new Date().toISOString(); saveCfg(); setStatus("ok");
    } catch (e) {
      setStatus(navigator.onLine ? "error" : "offline", e.name === "AbortError" ? "GitHub no responde. Prueba más tarde." : (e.message || String(e)));
    } finally {
      busy = false;
      if (again) { again = false; sync(); }
    }
  }
  const schedule = (ms = 4000) => { if (!ready()) return; clearTimeout(timer); setStatus("pending"); timer = setTimeout(sync, ms); };

  function afterPull() {
    try {
      refreshChrome();
      const sheetOpen = !document.getElementById("sheet").hidden;
      if (!sheetOpen && current !== "nuevo" && current !== "mapa") {
        const y = window.scrollY; show(current); window.scrollTo(0, y);
      }
      toast("Datos actualizados desde la nube");
    } catch (e) {}
  }

  /* ---------- enganches con la app ---------- */
  const baseSave = window.save;
  window.save = function () { const ch = stamp(); baseSave(); if (ch) schedule(); };

  const baseChrome = window.refreshChrome;
  window.refreshChrome = function () { baseChrome(); paintChip(); };

  function hhmm(iso) { if (!iso) return ""; const d = new Date(iso); return d.toLocaleTimeString("es-ES", {hour: "2-digit", minute: "2-digit"}); }
  function setStatus(state, msg) { st = {state, msg: msg || ""}; paintChip(); paintPanel(); }
  function chipText() {
    switch (st.state) {
      case "off": return "Sin sincronizar";
      case "busy": return "Sincronizando…";
      case "pending": return "Cambios por subir";
      case "offline": return "Sin conexión";
      case "error": return "Error al sincronizar";
      case "ok": return "Sincronizado " + hhmm(cfg.last);
      default: return cfg.last ? "Sincronizado " + hhmm(cfg.last) : "Sincronizar";
    }
  }
  function paintChip() {
    let c = document.getElementById("syncChip");
    if (!c) {
      c = document.createElement("button"); c.id = "syncChip"; c.type = "button";
      c.style.cssText = "border:0;border-radius:999px;padding:3px 9px;font:600 .8rem var(--f-body);cursor:pointer;white-space:nowrap;color:inherit;background:color-mix(in srgb,currentColor 18%,transparent)";
      c.addEventListener("click", () => { if (!ready()) { show("mas"); setTimeout(() => { const d = document.getElementById("syncCard"); if (d) { d.open = true; d.scrollIntoView({block: "start"}); } }, 50); } else sync(); });
      const camp = document.getElementById("hdrCamp"); camp.parentNode.insertBefore(c, camp);
      const css = document.createElement("style"); css.textContent = "@media (max-width:480px){#hdrCamp{display:none}}"; document.head.appendChild(css);
    }
    const short = {off: "☁ Activar", busy: "↻ …", pending: "↑ Pendiente", offline: "Sin red", error: "⚠ Error", ok: "✓ " + hhmm(cfg.last)}[st.state] || (cfg.last ? "✓ " + hhmm(cfg.last) : "☁");
    c.textContent = short;
    c.title = chipText() + (st.msg ? ". " + st.msg : "");
    c.setAttribute("aria-label", c.title);
  }
  function paintPanel() {
    const p = document.getElementById("syncStatus"); if (!p) return;
    p.className = "banner " + (st.state === "error" ? "crit" : st.state === "offline" || st.state === "pending" ? "warn" : "info");
    p.innerHTML = `<div><b>${esc(chipText())}</b>${st.msg ? esc(st.msg) : ready() ? "Los cambios se suben solos unos segundos después de guardar, y se descargan al abrir la app." : "Configura la clave para empezar."}</div>`;
  }

  const baseMas = window.renderMas;
  window.renderMas = function () {
    baseMas();
    const v = document.getElementById("v-mas");
    const card = document.createElement("details"); card.className = "card"; card.id = "syncCard"; card.open = !ready();
    card.innerHTML = `<summary>Sincronización (móvil y ordenador)</summary><div class="stack">
      <div id="syncStatus"></div>
      <div class="grid2">${F("sy-owner", "Usuario de GitHub", cfg.owner)}${F("sy-repo", "Repositorio privado de datos", cfg.repo)}</div>
      <label class="f"><span>Clave de acceso (token)</span><input id="sy-token" type="password" autocomplete="off" placeholder="${cfg.token ? "Guardada en este dispositivo" : "github_pat_…"}"></label>
      ${F("sy-device", "Nombre de este dispositivo", cfg.device || "", "text", 'placeholder="iPhone, ordenador de casa…"')}
      <div class="btn-row"><button class="btn primary grow" id="sy-save">Guardar y sincronizar</button>${ready() ? `<button class="btn" id="sy-now">Sincronizar ahora</button><button class="btn danger" id="sy-off">Desconectar este dispositivo</button>` : ""}</div>
      <details><summary class="small">Cómo crear la clave (una vez)</summary><ol class="small">
        <li>En GitHub: foto de perfil → Settings → Developer settings → Personal access tokens → <b>Fine-grained tokens</b> → Generate new token.</li>
        <li>Nombre «Aguacater», caducidad la que quieras (al caducar habrá que crear otra).</li>
        <li><b>Repository access</b>: Only select repositories → <b>${esc(cfg.repo)}</b>.</li>
        <li><b>Permissions</b> → Repository permissions → <b>Contents: Read and write</b>. Nada más.</li>
        <li>Genera, copia la clave y pégala aquí. Haz lo mismo en el ordenador (puedes usar la misma clave).</li></ol>
        <p class="small muted">La clave queda guardada solo en este dispositivo y solo da acceso a ese repositorio. Si pierdes el móvil, bórrala en GitHub. Las fotos de facturas no se sincronizan: se quedan en el dispositivo donde las hiciste.</p></details>
    </div>`;
    const anchor = [...v.querySelectorAll("details.card")].find(d => /Copias y exportación/.test(d.querySelector("summary")?.textContent || ""));
    v.insertBefore(card, anchor || v.lastElementChild);
    paintPanel();
    document.getElementById("sy-save").onclick = () => {
      cfg.owner = document.getElementById("sy-owner").value.trim();
      cfg.repo = document.getElementById("sy-repo").value.trim();
      const t = document.getElementById("sy-token").value.trim(); if (t) cfg.token = t;
      cfg.device = document.getElementById("sy-device").value.trim();
      saveCfg();
      if (!ready()) { setStatus("off", "Falta el usuario, el repositorio o la clave."); return; }
      window.renderMas(); sync();
    };
    const now = document.getElementById("sy-now"); if (now) now.onclick = () => sync();
    const off = document.getElementById("sy-off");
    if (off) off.onclick = () => {
      if (!off.dataset.armed) { off.dataset.armed = "1"; off.textContent = "Toca otra vez para desconectar"; return; }
      delete cfg.token; delete cfg.last; saveCfg(); setStatus("off"); window.renderMas(); toast("Clave borrada de este dispositivo");
    };
  };

  /* ---------- arranque ---------- */
  stamp();
  paintChip();
  if (current === "mas") window.renderMas();
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") sync(); });
  window.addEventListener("online", () => sync());
  setTimeout(sync, 800);
  window.aguacaterSync = {sync, merge, payload, cfg: () => cfg};
})();
