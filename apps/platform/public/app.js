"use strict";
// SPA minimale: parla con l'API JSON, niente innerHTML con dati utente.
const $ = (id) => document.getElementById(id);
const views = ["login", "register", "account", "env", "admin", "forgot", "reset"];
let me = null;
let currentResetToken = "";

function show(name) {
  for (const v of views) $("view-" + v).hidden = v !== name;
}

function setErr(id, msg) {
  const el = $(id);
  if (!msg) { el.hidden = true; el.textContent = ""; return; }
  el.textContent = msg;
  el.hidden = false;
}

async function api(path, opts) {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "Errore (" + r.status + ")");
  return data;
}

function fmtDate(ms) {
  return new Date(ms).toLocaleDateString("it-IT", { day: "numeric", month: "long", year: "numeric" });
}

async function refreshMe() {
  try {
    const d = await api("/api/me");
    me = d.user;
  } catch { me = null; return false; }
  return true;
}

let env = null;

function envStatusLabel(s) {
  return s === "running" ? "In esecuzione" : s === "stopped" ? "Spento" : String(s);
}

function renderEnv() {
  $("createForm").hidden = !!env;
  $("envDetail").hidden = !env;
  if (!env) return;
  const link = $("envUrl");
  link.textContent = env.url;
  link.href = env.url;
  $("envStatus").textContent = envStatusLabel(env.status);
  $("envStart").hidden = env.status === "running";
  $("envStop").hidden = env.status !== "running";
  const setup = $("envSetupUrl");
  setup.href = env.setupUrl;
  setup.textContent = "Apri il link di primo accesso";
  $("envConfirm").value = "";
}

async function loadEnv() {
  setErr("envErr", "");
  try {
    const d = await api("/api/workspace");
    env = d.workspace;
    renderEnv();
  } catch (e) { setErr("envErr", e.message); }
}

async function loadWorkspaces() {
  const d = await api("/api/admin/workspaces");
  const body = $("wsBody");
  body.textContent = "";
  for (const w of d.workspaces) {
    const tr = document.createElement("tr");
    const tdU = document.createElement("td"); tdU.textContent = w.email;
    const tdUrl = document.createElement("td");
    const a = document.createElement("a");
    a.textContent = w.url; a.href = w.url;
    a.target = "_blank"; a.rel = "noopener";
    tdUrl.append(a);
    const tdS = document.createElement("td"); tdS.textContent = w.status === "running" ? "In esecuzione" : w.status === "stopped" ? "Spento" : String(w.status);
    const tdC = document.createElement("td"); tdC.textContent = fmtDate(w.created_at);
    const tdA = document.createElement("td");
    if (w.status === "running") {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = "Ferma";
      b.addEventListener("click", async () => {
        try { await api("/api/admin/workspaces/" + w.id + "/stop", { method: "POST" }); await renderAdmin(); }
        catch (e) { setErr("adminErr", e.message); }
      });
      tdA.append(b);
    } else {
      tdA.textContent = "—";
    }
    tr.append(tdU, tdUrl, tdS, tdC, tdA);
    body.append(tr);
  }
}

function renderAccount() {
  $("meEmail").textContent = me.email;
  $("meStatus").textContent = me.status === "active" ? "Attivo" : me.status === "suspended" ? "Sospeso" : "In attesa di conferma";
  $("meCreated").textContent = fmtDate(me.created_at);
  $("meName").value = me.name || "";
  $("menu").hidden = false;
  $("adminTab").hidden = me.role !== "admin";
}

async function renderAdmin() {
  setErr("adminErr", "");
  try {
    const s = await api("/api/admin/stats");
    const stats = $("stats");
    stats.textContent = "";
    const voci = [["Utenti totali", s.users], ["Attivi", s.active], ["In attesa", s.pending], ["Sospesi", s.suspended], ["Nuovi (7 giorni)", s.newLast7Days], ["Amministratori", s.admins]];
    for (const [k, v] of voci) {
      const box = document.createElement("div");
      const dt = document.createElement("dt"); dt.textContent = k;
      const dd = document.createElement("dd"); dd.textContent = String(v);
      const dl = document.createElement("dl"); dl.append(dt, dd);
      box.append(dl); stats.append(box);
    }
    await loadUsers();
    await loadWorkspaces();
  } catch (e) { setErr("adminErr", e.message); }
}

async function loadUsers() {
  const q = $("q").value.trim();
  const d = await api("/api/admin/users" + (q ? "?q=" + encodeURIComponent(q) : ""));
  const body = $("usersBody");
  body.textContent = "";
  for (const u of d.users) {
    const tr = document.createElement("tr");
    const tdE = document.createElement("td"); tdE.textContent = u.email;
    const tdN = document.createElement("td"); tdN.textContent = u.name || "—";
    const tdR = document.createElement("td"); tdR.textContent = u.role === "admin" ? "Admin" : "Utente";
    const tdS = document.createElement("td"); tdS.textContent = u.status;
    const tdA = document.createElement("td");
    const mk = (label, fn) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = label;
      b.addEventListener("click", async () => { try { await fn(); await renderAdmin(); } catch (e) { setErr("adminErr", e.message); } });
      return b;
    };
    tdA.append(
      u.status === "suspended"
        ? mk("Riattiva", () => api("/api/admin/users/" + u.id, { method: "PATCH", body: JSON.stringify({ status: "active" }) }))
        : mk("Sospendi", () => api("/api/admin/users/" + u.id, { method: "PATCH", body: JSON.stringify({ status: "suspended" }) })),
      u.role === "admin"
        ? mk("Rendi utente", () => api("/api/admin/users/" + u.id, { method: "PATCH", body: JSON.stringify({ role: "user" }) }))
        : mk("Rendi admin", () => api("/api/admin/users/" + u.id, { method: "PATCH", body: JSON.stringify({ role: "admin" }) })),
      mk("Elimina", async () => {
        if (!window.confirm("Eliminare " + u.email + "?")) return;
        await api("/api/admin/users/" + u.id, { method: "DELETE" });
      }),
    );
    tr.append(tdE, tdN, tdR, tdS, tdA);
    body.append(tr);
  }
}

document.querySelectorAll("[data-view]").forEach((b) => {
  b.addEventListener("click", () => {
    const v = b.getAttribute("data-view");
    if (v === "admin") renderAdmin();
    if (v === "env") loadEnv();
    show(v);
  });
});

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault(); setErr("loginErr", "");
  try {
    const d = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email: $("loginEmail").value, password: $("loginPass").value }) });
    me = d.user; renderAccount(); show("account");
  } catch (err) { setErr("loginErr", err.message); }
});

$("regForm").addEventListener("submit", async (e) => {
  e.preventDefault(); setErr("regErr", "");
  try {
    const d = await api("/api/auth/register", { method: "POST", body: JSON.stringify({ name: $("regName").value, email: $("regEmail").value, password: $("regPass").value }) });
    const banner = $("banner");
    banner.textContent = d.message + ": controlla la posta per confermare l'account.";
    banner.hidden = false;
    show("login");
  } catch (err) { setErr("regErr", err.message); }
});

$("nameForm").addEventListener("submit", async (e) => {
  e.preventDefault(); setErr("nameErr", "");
  try {
    const d = await api("/api/me", { method: "PATCH", body: JSON.stringify({ name: $("meName").value }) });
    me = d.user; renderAccount();
  } catch (err) { setErr("nameErr", err.message); }
});

$("passForm").addEventListener("submit", async (e) => {
  e.preventDefault(); setErr("passErr", "");
  const ok = $("passOk"); ok.hidden = true; ok.textContent = "";
  try {
    const d = await api("/api/me/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword: $("curPass").value, newPassword: $("newPass").value }),
    });
    ok.textContent = d.message; ok.hidden = false;
    $("curPass").value = ""; $("newPass").value = "";
  } catch (err) { setErr("passErr", err.message); }
});

$("forgotForm").addEventListener("submit", async (e) => {
  e.preventDefault(); setErr("forgotErr", "");
  try {
    const d = await api("/api/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email: $("forgotEmail").value }),
    });
    const banner = $("banner");
    banner.textContent = d.message;
    banner.hidden = false;
    $("forgotEmail").value = "";
    show("login");
  } catch (err) { setErr("forgotErr", err.message); }
});

$("resetForm").addEventListener("submit", async (e) => {
  e.preventDefault(); setErr("resetErr", "");
  try {
    const d = await api("/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token: currentResetToken, newPassword: $("resetPass").value }),
    });
    const banner = $("banner");
    banner.textContent = d.message;
    banner.hidden = false;
    $("resetPass").value = "";
    currentResetToken = "";
    show("login");
  } catch (err) { setErr("resetErr", err.message); }
});

$("logoutBtn").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  me = null; $("menu").hidden = true; show("login");
});

$("searchForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try { await loadUsers(); } catch (err) { setErr("adminErr", err.message); }
});

$("createForm").addEventListener("submit", async (e) => {
  e.preventDefault(); setErr("envErr", "");
  const btn = $("createBtn");
  btn.disabled = true; btn.textContent = "Creazione in corso…";
  try {
    const d = await api("/api/workspace", { method: "POST", body: JSON.stringify({ subdomain: $("envName").value.trim() }) });
    env = d.workspace; renderEnv();
  } catch (err) { setErr("envErr", err.message); }
  finally { btn.disabled = false; btn.textContent = "Crea il mio ambiente"; }
});

$("envStart").addEventListener("click", async () => {
  setErr("envErr", "");
  try { env = (await api("/api/workspace/start", { method: "POST" })).workspace; renderEnv(); }
  catch (e) { setErr("envErr", e.message); }
});

$("envStop").addEventListener("click", async () => {
  setErr("envErr", "");
  try { env = (await api("/api/workspace/stop", { method: "POST" })).workspace; renderEnv(); }
  catch (e) { setErr("envErr", e.message); }
});

$("deleteForm").addEventListener("submit", async (e) => {
  e.preventDefault(); setErr("envErr", "");
  try {
    await api("/api/workspace?confirm=" + encodeURIComponent($("envConfirm").value.trim()), { method: "DELETE" });
    env = null; $("envName").value = ""; renderEnv();
  } catch (err) { setErr("envErr", err.message); }
});

// Avvio: banner conferma, poi stato sessione.
(async () => {
  const params = new URLSearchParams(location.search);
  if (params.get("confermato") === "1") {
    const banner = $("banner");
    banner.textContent = "Email confermata: ora puoi accedere.";
    banner.hidden = false;
    history.replaceState(null, "", location.pathname);
  }
  const reset = params.get("reset");
  if (reset) {
    currentResetToken = reset;
    history.replaceState(null, "", location.pathname);
    show("reset");
    return;
  }
  if (await refreshMe()) { renderAccount(); show("account"); }
  else show("login");
})();
