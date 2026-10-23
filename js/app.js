// The whole site: worklist, registration, report writing, printing, cash, stats and settings.
// Pages and wording follow the clinic's desktop program; the data lives in Firestore so several
// people work at once, and the report editor adds sentence suggestions from the report library.
import { createStore, LIBRARY_FILES } from "./store.js";
import { createEditor, prepareLibrary, norm, sentenceKey } from "./editor.js";
import { AR } from "./i18n.js";
import { SETTINGS, EXAM_TYPES, TEMPLATES, SNIPPETS } from "./defaults.js";

// ------------------------------------------------------------ helpers
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const local = {
  get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } },
};
let LANG = local.get("lang") || "ar";
const T = (s, vars) => {
  let out = LANG === "ar" ? (AR[s] || s) : s;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split("%(" + k + ")s").join(v);
  return out;
};
const iqd = (n) => Number(n || 0).toLocaleString("en-US");
const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d) => { d = new Date(d); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const today = () => dayKey(new Date());
const nowIso = () => new Date().toISOString();
const fmtDate = (d) => { d = new Date(d); return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`; };
const fmtTime = (d) => { d = new Date(d); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDateTime = (d) => `${fmtDate(d)} ${fmtTime(d)}`;
const addDays = (key, n) => { const d = new Date(key + "T12:00:00"); d.setDate(d.getDate() + n); return dayKey(d); };
const longDate = (key) => new Date(key + "T12:00:00").toLocaleDateString(LANG === "ar" ? "ar-IQ-u-nu-latn" : "en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const MODALITIES = { MRI: "MRI", CT: "CT", US: "Ultrasound", XR: "X-ray" };
const STATUS = { waiting: "Waiting", draft: "Draft", final: "Final", printed: "Printed", cancelled: "Cancelled" };
const ROLES = { reception: "Reception", typist: "Typist", radiologist: "Doctor", admin: "Admin" };
const AGE_UNITS = { Y: ["y", "سنة", "Years"], M: ["m", "شهر", "Months"], D: ["d", "يوم", "Days"] };
// Exams of the last WINDOW_DAYS days stay live in memory; older ones are fetched when a page needs them
const WINDOW_DAYS = 30;
const windowStart = addDays(today(), -WINDOW_DAYS);
const EMPTY_LIB = { phrases: [], next: {}, ngrams: {}, vocab: {}, typos: {}, titles: [] };
const LIB_MODALITY = { MRI: "MRI", CT: "CT", US: "US", XR: "" };

function toast(text) {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const el = document.createElement("div");
  el.className = "toast"; el.textContent = text; document.body.append(el);
  setTimeout(() => el.remove(), 2600);
}

// Code 39 barcode, same as the printed reports of the old program.
const CODE39 = { "0": "nnnwwnwnn", "1": "wnnwnnnnw", "2": "nnwwnnnnw", "3": "wnwwnnnnn", "4": "nnnwwnnnw", "5": "wnnwwnnnn", "6": "nnwwwnnnn", "7": "nnnwnnwnw", "8": "wnnwnnwnn", "9": "nnwwnnwnn", "*": "nwnnwnwnn" };
function barcode(value, height = 40) {
  const text = `*${value}*`; let x = 0; const rects = [];
  [...text].forEach((ch, i) => {
    [...CODE39[ch]].forEach((el, j) => { const w = el === "w" ? 4 : 1.6; if (j % 2 === 0) rects.push(`<rect x="${x.toFixed(1)}" y="0" width="${w}" height="${height}"/>`); x += w; });
    if (i < text.length - 1) x += 1.6;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${x.toFixed(1)}" height="${height}" viewBox="0 0 ${x.toFixed(1)} ${height}" fill="#000">${rects.join("")}</svg>`;
}

// Report text is plain text; the printout turns numbered and dashed lines into lists and bolds "HEADING:"
function textToHtml(text) {
  const out = []; let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trimEnd();
    const item = line.match(/^\s*(\d+[.)]|[-•*])\s+(.*)$/);
    if (item) {
      const kind = /\d/.test(item[1]) ? "ol" : "ul";
      if (list !== kind) { close(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${esc(item[2])}</li>`); continue;
    }
    close();
    if (!line.trim()) { out.push(`<div class="gap"></div>`); continue; }
    const h = line.match(/^([A-Z][A-Z0-9 ,/&()'-]{2,}:)(.*)$/);
    out.push(h ? `<p><b>${esc(h[1])}</b>${esc(h[2])}</p>` : `<p>${esc(line)}</p>`);
  }
  close();
  return out.join("");
}

// ------------------------------------------------------------ state
let store = null;
const db = {
  settings: { ...SETTINGS }, letterhead: {}, examTypes: EXAM_TYPES, snippets: SNIPPETS, templates: [], people: [], learned: new Map(),
  exams: [], payments: [],
};
const live = { exams: new Map(), payments: new Map() };                       // window listeners
const extra = { exams: new Map(), payments: new Map(), patients: new Map() };  // fetched on demand
let lib = null, libState = "loading"; // loading | ready | missing | error
const ignored = new Set();
let unsubs = [];
let loadError = "";
let seeded = false;

function rebuild() {
  db.exams = [...new Map([...extra.exams, ...live.exams]).values()];
  db.payments = [...new Map([...extra.payments, ...live.payments]).values()];
}

// ------------------------------------------------------------ data helpers
const byId = (list, id) => list.find((x) => String(x.id) === String(id));
const examById = (id) => byId(db.exams, id);
const patientOf = (e) => ({ id: e.patientId, name: e.patientName || "?", sex: e.sex, phone: e.phone });
const paidFor = (e) => e.paid || 0;
const net = (e) => e.price - (e.discount || 0);
const due = (e) => e.status === "cancelled" ? 0 : net(e) - paidFor(e);
const isSigned = (e) => e.status === "final" || e.status === "printed";
const ageText = (e) => e.ageValue ? `${e.ageValue}${LANG === "ar" ? " " + AGE_UNITS[e.ageUnit][1] : AGE_UNITS[e.ageUnit][0]}` : "";
const ageArabic = (e) => e.ageValue ? `${e.ageValue} ${AGE_UNITS[e.ageUnit][1]}` : "";
const sexText = (s) => s === "M" ? T("Male") : s === "F" ? T("Female") : "";
const uid = () => store.user.uid;
const me = () => db.people.find((p) => p.id === uid()) || store.user;
const meName = () => me()?.name || T("Unknown");
const role = () => me()?.role || "";
const isDoctor = () => role() === "radiologist";
const canManage = () => role() === "admin" || role() === "radiologist";
// Everyone with a role writes and edits reports, including reception; only the doctor signs
const canWriteReport = () => !!ROLES[role()];
const distinct = (values) => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
const newestFirst = (a, b) => b.registeredAt.localeCompare(a.registeredAt);

// Exams older than the live window have no listener, so a change to one is read back by hand
async function refreshExam(id) {
  if (live.exams.has(String(id))) return;
  const e = await store.getDoc("exams", id);
  if (e) { extra.exams.set(e._id, e); rebuild(); liveUpdate(); }
}
async function updateExam(id, patch) {
  await store.updateDoc("exams", id, patch);
  refreshExam(id).catch(console.error);
}

async function addPayment(exam, amount, kind, note, patch = {}) {
  const id = await store.tx(async (t) => {
    const c = (await t.get("meta", "counters")) || {};
    const e = await t.get("exams", exam.id);
    const id = c.payment || 1; c.payment = id + 1;
    const at = nowIso();
    t.set("meta", "counters", c);
    t.set("payments", id, { id, examId: e.id, kind, amount, note: note || "", by: meName(), byUid: uid(), at, day: dayKey(at), patientName: e.patientName, examName: e.examName });
    t.update("exams", exam.id, { paid: (e.paid || 0) + amount, ...patch });
    return id;
  });
  refreshExam(exam.id).catch(console.error);
  return id;
}

// ------------------------------------------------------------ loading
function startListeners() {
  const fail = (err) => {
    console.error(err);
    loadError = err.code === "permission-denied"
      ? T("The Firestore rules refuse access. Paste firestore.rules in the Firebase console and press Publish.")
      : T("Could not load the data: %(error)s", { error: err.code || err.message });
    renderBanner();
  };
  unsubs = [
    store.watchDoc("settings", "clinic", (d) => { db.settings = { ...SETTINGS, ...(d || {}) }; liveUpdate(); }, fail),
    store.watchDoc("settings", "letterhead", (d) => { db.letterhead = d || {}; liveUpdate(); }, fail),
    store.watchDoc("settings", "examTypes", (d) => { db.examTypes = d?.items || EXAM_TYPES; liveUpdate(); }, fail),
    store.watchDoc("settings", "snippets", (d) => { db.snippets = d?.items || SNIPPETS; liveUpdate(); }, fail),
    store.watchQuery("templates", {}, (rows) => {
      db.templates = rows.length ? rows.map((r) => ({ ...r, id: r._id })) : TEMPLATES;
      // The program's ready-made templates are written once, so they can be edited like any other
      if (!rows.length && !seeded && canWriteReport()) { seeded = true; TEMPLATES.forEach((t) => store.setDoc("templates", t.id, t).catch(console.error)); }
      liveUpdate();
    }, fail),
    store.watchQuery("learned", {}, (rows) => { db.learned = new Map(rows.map((r) => [r._id, r])); }, fail),
    store.watchQuery("users", {}, (rows) => { db.people = rows.map((r) => ({ ...r, id: r._id })); liveUpdate(); }, fail),
    store.watchQuery("exams", { where: [["day", ">=", windowStart]] }, (rows) => {
      live.exams = new Map(rows.map((r) => [r._id, r])); rebuild(); onExamsChanged();
    }, fail),
    store.watchQuery("payments", { where: [["day", ">=", windowStart]] }, (rows) => {
      live.payments = new Map(rows.map((r) => [r._id, r])); rebuild(); liveUpdate();
    }, fail),
  ];
}

async function loadLibrary() {
  try {
    (await store.loadDictionary()).forEach((w) => ignored.add(w));
    const l = await store.loadLibrary();
    if (l) { prepareLibrary(l); lib = l; libState = "ready"; } else libState = "missing";
  } catch (err) {
    console.error(err); libState = "error";
  }
  renderBanner();
  // An open report editor picks up the suggestions as soon as the library arrives
  if (page() === "report" && editing && !editing.ro && !editing.dirty) render(true);
}

const loaded = new Set(), loading = new Set();
function need(key, fn) {
  if (loaded.has(key)) return true;
  if (!loading.has(key)) {
    loading.add(key);
    fn().catch((err) => { console.error(key, err); toast(T("Could not load the data: %(error)s", { error: err.code || err.message })); })
      .finally(() => { loading.delete(key); loaded.add(key); rebuild(); if (busy()) stale = true; else render(true); });
  }
  return false;
}
const addExams = (rows) => rows.forEach((r) => extra.exams.set(r._id, r));
const addPays = (rows) => rows.forEach((r) => extra.payments.set(r._id, r));
const needRange = (from, to) => from >= windowStart || need(`range:${from}:${to}`, async () => {
  const w = [["day", ">=", from], ["day", "<=", to]];
  const [e, p] = await Promise.all([store.getQuery("exams", { where: w }), store.getQuery("payments", { where: w })]);
  addExams(e); addPays(p);
});
const needExam = (id) => !!examById(id) || need(`exam:${id}`, async () => { const e = await store.getDoc("exams", id); if (e) addExams([e]); });
const needExamPayments = (e) => e.day >= windowStart || need(`pays:${e.id}`, async () => addPays(await store.getQuery("payments", { where: [["examId", "==", e.id]] })));
const needHistory = (pid) => need(`history:${pid}`, async () => addExams(await store.getQuery("exams", { where: [["patientId", "==", pid]] })));
const needPatient = (pid) => extra.patients.has(String(pid)) || need(`patient:${pid}`, async () => { const p = await store.getDoc("patients", pid); if (p) extra.patients.set(String(pid), p); });
const needPayment = (id) => !!byId(db.payments, id) || need(`payment:${id}`, async () => { const p = await store.getDoc("payments", id); if (p) addPays([p]); });
const loadingCard = () => `<section class="card"><div class="empty">${T("Loading…")}</div></section>`;

// Pages with forms are not redrawn under the user's hands; the others follow every change live
const LIVE_PAGES = new Set(["", "exam", "search", "cash", "stats", "print", "receipt"]);
let stale = false;
const page = () => (location.hash.slice(1) || "/").split("?")[0].split("/").filter(Boolean)[0] || "";
function busy() {
  const a = document.activeElement;
  return !!(a && a.closest && a.closest("#root") && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) || !!$("#root form[data-dirty]");
}
function liveUpdate() {
  if (!store?.user) return;
  renderBanner();
  if (page() === "register" && $("#today-list")) { $("#today-list").innerHTML = todayList(); $("#today-count").textContent = db.exams.filter((e) => e.day === today() && e.status !== "cancelled").length; }
  if (!LIVE_PAGES.has(page())) return;
  if (busy()) { stale = true; return; }
  render(true);
}
document.addEventListener("focusout", () => setTimeout(() => {
  if (stale && !busy() && LIVE_PAGES.has(page())) { stale = false; render(true); }
}, 60));

// ------------------------------------------------------------ layout
const NAV = [
  ["#/", "Today's worklist", "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"],
  ["#/register", "Register patient", "M15 19a6 6 0 0 0-12 0M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM19 8v6M22 11h-6"],
  ["#/search", "Search reports", "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3"],
  ["#/cash", "Cash", "M3 7h18v12H3zM3 11h18M7 15h3"],
  ["#/stats", "Stats", "M4 20V10M10 20V4M16 20v-7M22 20H2"],
  ["#/settings", "Settings", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"],
];
const icon = (d) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
function shell(content) {
  const path = location.hash.split("?")[0] || "#/";
  const s = db.settings; const m = me();
  const nav = NAV.filter(([h]) => h !== "#/settings" || canManage() || canWriteReport());
  return `<div class="app">
    <nav class="nav no-print">
      <div class="brand"><div class="brand-mark">${esc((s.nameAr || s.nameEn || "R").slice(0, 1))}</div>
        <div><strong>${esc(s.nameEn)}</strong>${s.nameAr ? `<small>${esc(s.nameAr)}</small>` : ""}</div></div>
      <div class="links">${nav.map(([h, label, ic]) => `<a href="${h}" class="${path === h || (h === "#/" && path === "#") ? "on" : ""}">${icon(ic)}<span>${T(label)}</span></a>`).join("")}</div>
      <div class="grow"></div>
      <div class="me">
        <div class="who"><span class="label">${T("Signed in as")}</span><strong><bdi>${esc(m.name)}</bdi></strong><span class="sub">${ROLES[m.role] ? T(ROLES[m.role]) : "—"}</span></div>
        <div class="actions">
          <button class="btn small" data-action="lang">${LANG === "ar" ? "English" : "العربية"}</button>
          <button class="btn small" data-action="resetPassword" title="${T("Send a password reset email")}">${T("Change password")}</button>
          <button class="btn small" data-action="signOut">${T("Sign out")}</button>
        </div>
      </div>
    </nav>
    <main class="main"><div id="banner"></div>${content}</main></div>`;
}

function renderBanner() {
  const el = $("#banner"); if (!el) return;
  const out = [];
  if (store.mode === "demo") out.push(`<div class="notice">${T("Demo mode: the data stays in this browser only.")}</div>`);
  if (loadError) out.push(`<div class="notice err">${esc(loadError)}</div>`);
  if (canManage() && db.examTypes.every((t) => !t.price)) out.push(`<div class="notice">${T("Start in Settings: add the people who use the program, then enter the exam prices.")} <a class="btn small" href="#/settings?tab=prices">${T("Settings")}</a></div>`);
  if (canManage() && libState === "missing") out.push(`<div class="notice">${T("The report library is not uploaded yet, so there are no sentence suggestions.")} <a class="btn small" href="#/settings?tab=library">${T("Upload library")}</a></div>`);
  el.innerHTML = out.join("");
}

// ------------------------------------------------------------ pages
function statusBadge(st) { return `<span class="badge ${st}">${T(STATUS[st])}</span>`; }

function pageWorklist(q) {
  const day = q.get("day") || today();
  const mod = q.get("modality") || ""; const st = q.get("status") || ""; const text = (q.get("q") || "").trim().toLowerCase();
  const ready = needRange(day, day);
  const dayExams = db.exams.filter((e) => e.day === day);
  const liveRows = dayExams.filter((e) => e.status !== "cancelled");
  let rows = dayExams;
  if (mod) rows = rows.filter((e) => e.modality === mod);
  if (st === "open") rows = rows.filter((e) => e.status === "waiting" || e.status === "draft");
  else if (st) rows = rows.filter((e) => e.status === st);
  if (text) rows = rows.filter((e) => [e.patientName, e.phone, String(e.id)].some((v) => (v || "").toLowerCase().includes(text)));
  rows.sort((a, b) => a.registeredAt.localeCompare(b.registeredAt));
  const link = (k, v) => { const n = new URLSearchParams(q); v ? n.set(k, v) : n.delete(k); return "#/?" + n; };
  const action = (e) => e.status === "cancelled" ? ""
    : isSigned(e) ? `<a href="#/print/${e.id}">${e.status === "printed" ? T("Reprint") : T("Print")}</a>`
    : `<a href="#/report/${e.id}">${e.status === "waiting" ? T("Write report") : T("Continue")}</a>`;
  // A week strip like a calendar: Saturday to Friday around the chosen day
  const d0 = new Date(day + "T12:00:00"); const weekStart = addDays(day, -((d0.getDay() + 1) % 7));
  const week = [...Array(7).keys()].map((k) => addDays(weekStart, k));
  const dayName = (k) => new Date(k + "T12:00:00").toLocaleDateString(LANG === "ar" ? "ar-IQ" : "en-GB", { weekday: "short" });
  const paidToday = db.payments.filter((x) => x.day === day).reduce((a, x) => a + x.amount, 0);
  return `<div class="page-head"><div class="grow"><span class="eyebrow">${esc(longDate(day))}</span><h1>${T("Welcome back, %(name)s", { name: `<bdi>${esc(meName())}</bdi>` })}</h1>
        <p class="sub">${T("Today's patients, reports waiting and money taken, at a glance.")}</p></div>
      <a class="btn primary" href="#/register">+ ${T("Register patient")}</a></div>
    <div class="week no-print">
      <a class="week-arrow" href="${link("day", addDays(day, -7))}" aria-label="${T("Previous")}">${LANG === "ar" ? "›" : "‹"}</a>
      ${week.map((k) => `<a class="week-day ${k === day ? "on" : ""} ${k === today() ? "today" : ""}" href="${link("day", k)}"><span>${esc(dayName(k))}</span><b>${+k.slice(8)}</b></a>`).join("")}
      <a class="week-arrow" href="${link("day", addDays(day, 7))}" aria-label="${T("Next")}">${LANG === "ar" ? "‹" : "›"}</a>
      <input type="date" value="${day}" data-change="goDay" class="week-date">
    </div>
    <div class="stats">
      <div class="card stat tint-blue"><span class="label">${T("Registered")}</span><span class="value">${liveRows.length}</span></div>
      <div class="card stat tint-yellow"><span class="label">${T("Waiting for report")}</span><span class="value">${liveRows.filter((e) => e.status === "waiting" || e.status === "draft").length}</span></div>
      <div class="card stat tint-green"><span class="label">${T("Ready to print")}</span><span class="value">${liveRows.filter((e) => e.status === "final").length}</span></div>
      <div class="card stat tint-purple"><span class="label">${T("Payments today")}</span><span class="value num">${iqd(paidToday)}</span><span class="sub">${T("Printed")}: ${liveRows.filter((e) => e.status === "printed").length}</span></div>
    </div>
    <section class="card stack">
      <div class="toolbar">
        <div class="chips"><a class="chip ${!mod ? "on" : ""}" href="${link("modality", "")}">${T("All")}</a>
          ${Object.entries(MODALITIES).map(([k, v]) => `<a class="chip ${mod === k ? "on" : ""}" href="${link("modality", k)}">${T(v)}</a>`).join("")}</div>
        <select data-change="filterStatus"><option value="">${T("Any status")}</option><option value="open" ${st === "open" ? "selected" : ""}>${T("Waiting for report")}</option>
          ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${st === k ? "selected" : ""}>${T(v)}</option>`).join("")}</select>
        <input type="search" placeholder="${T("Name, phone or ID")}" value="${esc(q.get("q") || "")}" data-change="filterText">
      </div>
      ${!ready ? `<div class="empty">${T("Loading…")}</div>` : rows.length ? `<div class="table-wrap"><table class="list cards"><thead><tr><th>${T("ID")}</th><th>${T("Patient")}</th><th>${T("Exam")}</th><th>${T("Referring doctor")}</th><th>${T("Time")}</th><th>${T("Status")}</th><th></th></tr></thead><tbody>
        ${rows.map((e) => { const p = patientOf(e); const owe = due(e); return `<tr>
          <td class="c-id"><a href="#/exam/${e.id}">${e.id}</a></td>
          <td class="c-patient"><a href="#/exam/${e.id}" class="strong plain"><bdi>${esc(p.name)}</bdi></a><div class="sub">${[ageText(e), sexText(p.sex), p.phone ? `<span class="ltr">${esc(p.phone)}</span>` : ""].filter(Boolean).join(" · ")}</div></td>
          <td class="c-exam">${esc(e.examName)}<div class="sub">${T(MODALITIES[e.modality])}${e.contrast ? " · " + T("Contrast") : ""}</div></td>
          <td class="c-doctor"><bdi>${esc(e.referringDoctor || "—")}</bdi></td><td class="c-time num">${fmtTime(e.registeredAt)}</td>
          <td class="c-status">${statusBadge(e.status)}${owe > 0 ? `<div class="sub owed">${T("Owes %(amount)s IQD", { amount: iqd(owe) })}</div>` : ""}</td>
          <td class="c-action end">${action(e)}</td></tr>`; }).join("")}
        </tbody></table></div>` : `<div class="empty"><strong>${dayExams.length ? T("No exams match these filters") : T("No patients on this day")}</strong></div>`}
    </section>`;
}

function examTypeOptions(mod, selected) {
  return db.examTypes.filter((t) => t.active && t.modality === mod).map((t) => `<option value="${t.id}" ${String(selected) === String(t.id) ? "selected" : ""}>${esc(t.name)}${t.price ? ` — ${iqd(t.price)}` : ""}</option>`).join("");
}

// Today's patients beside the registration form, like an agenda; refreshed live without touching the form
function todayList() {
  const rows = db.exams.filter((e) => e.day === today()).sort((a, b) => b.registeredAt.localeCompare(a.registeredAt));
  if (!rows.length) return `<div class="empty small">${T("No patients registered today yet.")}</div>`;
  return `<div class="agenda">${rows.map((e) => `<a class="agenda-item ${e.status}" href="#/exam/${e.id}">
      <span class="agenda-time num">${fmtTime(e.registeredAt)}</span>
      <span class="agenda-main"><bdi class="strong">${esc(e.patientName)}</bdi><span class="sub">${esc(e.examName)}${e.contrast ? " · " + T("Contrast") : ""}</span></span>
      <span class="agenda-end">${statusBadge(e.status)}<span class="sub num">${iqd(net(e))}</span></span></a>`).join("")}</div>`;
}

function pageRegister(q) {
  const pid = q.get("patient") || "";
  if (pid && !needPatient(pid)) return loadingCard();
  const p = pid ? extra.patients.get(String(pid)) : null;
  const doctors = distinct(db.exams.map((e) => e.referringDoctor));
  const techs = distinct(db.exams.map((e) => e.technician));
  const todays = db.exams.filter((e) => e.day === today() && e.status !== "cancelled");
  return `<div class="page-head"><div class="grow"><span class="eyebrow">${esc(longDate(today()))}</span><h1>${T("Register patient")}</h1></div></div>
  <div class="row">
  <form id="register-form" class="grow stack" autocomplete="off">
    <section class="card stack">
      <h2>${T("Patient")}</h2>
      <input type="hidden" name="patientId" value="${p ? p.id : ""}">
      ${p ? `<div class="notice ok">${T("Returning patient")}: <bdi>${esc(p.name)}</bdi> <a href="#/register" class="btn small">${T("New patient")}</a></div>` : `
      <div class="field"><label for="patient-search">${T("Been here before?")}</label><input type="search" id="patient-search" placeholder="${T("Name, phone or ID")}" data-input="findPatient"><div id="patient-matches"></div></div>`}
      <div class="grid2">
        <div class="field wide"><label for="r-name">${T("Name")}</label><input id="r-name" name="name" required dir="auto" value="${esc(p?.name || "")}"></div>
        <div class="field"><label for="r-sex">${T("Sex")}</label><select id="r-sex" name="sex"><option value=""></option><option value="M" ${p?.sex === "M" ? "selected" : ""}>${T("Male")}</option><option value="F" ${p?.sex === "F" ? "selected" : ""}>${T("Female")}</option></select></div>
        <div class="field"><label for="r-phone">${T("Phone")}</label><input id="r-phone" name="phone" type="tel" dir="ltr" value="${esc(p?.phone || "")}"></div>
        <div class="field"><label for="r-age">${T("Age")}</label><div class="age"><input id="r-age" name="ageValue" type="number" min="0" max="130" inputmode="numeric"><select name="ageUnit">${Object.entries(AGE_UNITS).map(([k, v]) => `<option value="${k}">${T(v[2])}</option>`).join("")}</select></div></div>
        <div class="field"><label for="r-doctor">${T("Referring doctor")}</label><input id="r-doctor" name="referringDoctor" list="doctor-list" dir="auto"><datalist id="doctor-list">${doctors.map((d) => `<option value="${esc(d)}">`).join("")}</datalist></div>
      </div>
    </section>
    <section class="card stack">
      <h2>${T("Exam and price")}</h2>
      <div class="grid2">
        <div class="field"><label for="r-mod">${T("Modality")}</label><select id="r-mod" name="modality" data-change="regModality">${Object.entries(MODALITIES).map(([k, v]) => `<option value="${k}">${T(v)}</option>`).join("")}</select></div>
        <div class="field"><label for="r-type">${T("Exam")}</label><select id="r-type" name="examTypeId" data-change="regExam">${examTypeOptions("MRI")}</select></div>
        <label class="checkbox"><input type="checkbox" name="contrast" data-change="regExam"> ${T("With contrast")}</label>
        <div class="field"><label for="r-tech">${T("Technician")}</label><input id="r-tech" name="technician" list="tech-list" dir="auto"><datalist id="tech-list">${techs.map((d) => `<option value="${esc(d)}">`).join("")}</datalist></div>
        <div class="field"><label for="r-price">${T("Price (IQD)")}</label><input id="r-price" name="price" type="number" min="0" step="any" inputmode="numeric" class="price-input" data-input="regPriceTouched">
          <span class="sub" id="r-listprice"></span></div>
        <div class="field"><label for="r-disc">${T("Discount")} (${T("IQD")})</label><input id="r-disc" name="discount" type="number" min="0" step="any" value="0" inputmode="numeric" data-input="regPrice"></div>
        <div class="field wide"><label for="r-reason">${T("Reason for discount")}</label><input id="r-reason" name="discountReason" dir="auto"></div>
        <div class="field wide"><label for="r-notes">${T("Notes")}</label><textarea id="r-notes" name="notes" dir="auto"></textarea></div>
      </div>
    </section>
    <section class="card stack pay-card">
      <h2>${T("Payment")}</h2>
      <div class="pay-grid">
        <div class="pay-total"><span class="label">${T("To pay")}</span><strong class="num" id="r-total">0</strong><span class="sub">${T("IQD")}</span></div>
        <div class="field"><label for="r-paid">${T("Paid now")} (${T("IQD")})</label><input id="r-paid" name="paidNow" type="number" min="0" step="any" value="0" inputmode="numeric" data-input="regPaidTouched"><div class="sub owed" id="r-owed"></div></div>
      </div>
      <div id="r-error" class="sub error-text"></div>
      <div class="actions"><button class="btn primary" type="submit" name="then" value="receipt">${T("Save and print receipt")}</button>
        <button class="btn" type="submit" name="then" value="list">${T("Save without receipt")}</button></div>
    </section>
  </form>
  <aside class="side stack today-side">
    <section class="card stack">
      <div class="page-head tight"><h2 class="grow">${T("Today's patients")}</h2><span class="count-pill" id="today-count">${todays.length}</span></div>
      <div id="today-list">${todayList()}</div>
      <a class="btn small outline" href="#/">${T("Open the worklist")}</a>
    </section>
  </aside>
  </div>`;
}

// The price comes from the price list when the exam changes; whatever reception types instead is kept
function regRecalc(resetPrice) {
  const f = $("#register-form"); if (!f) return;
  const t = byId(db.examTypes, f.examTypeId.value);
  const listPrice = t ? t.price + (f.contrast.checked ? t.contrastPrice : 0) : 0;
  if (resetPrice || !f.dataset.priceTouched) { f.price.value = listPrice; delete f.dataset.priceTouched; }
  const price = Math.max(0, Number(f.price.value) || 0);
  $("#r-listprice").innerHTML = f.dataset.priceTouched && price !== listPrice
    ? `${T("From the price list: %(amount)s", { amount: iqd(listPrice) })} · <a href="#" data-action="regListPrice">${T("Use the list price")}</a>` : "";
  const disc = Math.max(0, Number(f.discount.value) || 0);
  const total = Math.max(0, price - disc);
  $("#r-total").textContent = iqd(total);
  if (!f.dataset.paidTouched) f.paidNow.value = total;
  const left = total - (Number(f.paidNow.value) || 0);
  $("#r-owed").textContent = left > 0 ? T("Still owed: %(amount)s IQD", { amount: iqd(left) }) : "";
  return { price, disc, total };
}

async function submitRegister(form, then) {
  const err = (m) => { $("#r-error").textContent = m; };
  const { price, disc, total } = regRecalc();
  const name = form.name.value.trim().replace(/\s+/g, " ");
  if (!name) return err(T("Enter the patient's name."));
  const type = byId(db.examTypes, form.examTypeId.value);
  if (!type) return err(T("Choose the exam."));
  if (disc > price) return err(T("The discount is more than the price."));
  if (disc > 0 && !form.discountReason.value.trim()) return err(T("Give a reason for the discount."));
  const paid = Number(form.paidNow.value) || 0;
  if (paid < 0 || paid > total) return err(T("The amount paid is more than the %(amount)s IQD due.", { amount: iqd(total) }));
  const pid0 = form.patientId.value;
  const at = nowIso(); const sex = form.sex.value; const phone = form.phone.value.trim();
  const buttons = $$("button[type=submit]", form); buttons.forEach((b) => (b.disabled = true));
  try {
    const { eid, payId } = await store.tx(async (t) => {
      const c = (await t.get("meta", "counters")) || {};
      const old = pid0 ? await t.get("patients", pid0) : null;
      const pid = old ? old.id : (c.patient || 1);
      if (!old) c.patient = pid + 1;
      const id = c.exam || 1; c.exam = id + 1;
      const pay = paid > 0 ? (c.payment || 1) : null;
      if (pay) c.payment = pay + 1;
      t.set("meta", "counters", c);
      t.set("patients", pid, { id: pid, name, nameLower: name.toLowerCase(), sex, phone, createdAt: old?.createdAt || at, updatedAt: at });
      t.set("exams", id, {
        id, patientId: pid, patientName: name, patientNameLower: name.toLowerCase(), sex, phone,
        registeredAt: at, day: dayKey(at), modality: type.modality, examTypeId: type.id, examName: type.name,
        contrast: form.contrast.checked, price, discount: disc, discountReason: form.discountReason.value.trim(), paid,
        ageValue: Number(form.ageValue.value) || null, ageUnit: form.ageUnit.value, referringDoctor: form.referringDoctor.value.trim().replace(/\s+/g, " "),
        technician: form.technician.value.trim(), notes: form.notes.value.trim(), status: "waiting",
        registeredBy: meName(), registeredByUid: uid(), report: null, printCount: 0,
      });
      if (pay) t.set("payments", pay, { id: pay, examId: id, kind: "payment", amount: paid, note: "", by: meName(), byUid: uid(), at, day: dayKey(at), patientName: name, examName: type.name });
      return { eid: id, payId: pay };
    });
    form.removeAttribute("data-dirty");
    toast(T("Registered. ID %(id)s", { id: eid }));
    go(payId && then === "receipt" ? `#/receipt/${payId}?print=1` : "#/");
  } catch (e) {
    console.error(e);
    buttons.forEach((b) => (b.disabled = false));
    err(T("Not saved: %(error)s", { error: e.code || e.message }));
  }
}

function pageExam(id) {
  if (!needExam(id)) return loadingCard();
  const e = examById(id); if (!e) return notFound();
  const p = patientOf(e); const r = e.report; const paid = paidFor(e); const owe = due(e);
  const paysReady = needExamPayments(e); const histReady = needHistory(e.patientId);
  const payments = db.payments.filter((x) => x.examId === e.id).sort((a, b) => a.id - b.id);
  const history = db.exams.filter((x) => x.patientId === e.patientId && x.id !== e.id).sort(newestFirst);
  const open = e.status !== "cancelled";
  const dis = open ? "" : "disabled";
  return `<div class="page-head"><div class="grow"><span class="eyebrow">${T("ID")} ${e.id} · ${fmtDateTime(e.registeredAt)}</span><h1><bdi>${esc(p.name)}</bdi></h1></div>
      ${statusBadge(e.status)}
      ${isSigned(e) ? `<a class="btn primary" href="#/print/${e.id}">${T("Print")}</a>` : ""}
      ${open && (canWriteReport() || r) ? `<a class="btn outline" href="#/report/${e.id}">${r ? T("Open report") : T("Write report")}</a>` : ""}</div>
    ${r && (r.title || (r.body || "").trim() || r.impression) ? `<section class="card" style="--title:${esc(db.settings.titleColor)}">
      <div class="page-head tight"><h2 class="grow">${T("Report")}</h2>${r.signedAt ? `<span class="sub">${T("Signed by")} <bdi>${esc(r.signedBy)}</bdi> · ${fmtDateTime(r.signedAt)}</span>` : statusBadge("draft")}</div>
      <div class="report-text" dir="${r.direction || "ltr"}">${r.title ? `<div class="title">${esc(r.title)}</div>` : ""}<div>${textToHtml(r.body)}</div>
      ${r.impression ? `<p><b>${r.direction === "rtl" ? "الانطباع:" : "Impression:"}</b> <span class="pre">${esc(r.impression)}</span></p>` : ""}</div></section>` : ""}
    <div class="row">
      <section class="card grow stack">
        <h2>${T("Exam")}</h2>
        <div class="grid2">
          <div class="field"><span class="label">${T("Exam")}</span><span>${esc(e.examName)} · ${T(MODALITIES[e.modality])}${e.contrast ? " · " + T("Contrast") : ""}</span></div>
          <div class="field"><span class="label">${T("Registered by")}</span><span><bdi>${esc(e.registeredBy || "—")}</bdi></span></div>
        </div>
        <form id="exam-form" class="stack" data-id="${e.id}">
          <div class="grid2">
            <div class="field wide"><label>${T("Name")}</label><input name="name" dir="auto" value="${esc(e.patientName)}" ${dis}></div>
            <div class="field"><label>${T("Sex")}</label><select name="sex" ${dis}><option value=""></option><option value="M" ${e.sex === "M" ? "selected" : ""}>${T("Male")}</option><option value="F" ${e.sex === "F" ? "selected" : ""}>${T("Female")}</option></select></div>
            <div class="field"><label>${T("Phone")}</label><input name="phone" type="tel" dir="ltr" value="${esc(e.phone)}" ${dis}></div>
            <div class="field"><label>${T("Age")}</label><div class="age"><input name="ageValue" type="number" min="0" value="${e.ageValue ?? ""}" ${dis}><select name="ageUnit" ${dis}>${Object.entries(AGE_UNITS).map(([k, v]) => `<option value="${k}" ${e.ageUnit === k ? "selected" : ""}>${T(v[2])}</option>`).join("")}</select></div></div>
            <div class="field"><label>${T("Referring doctor")}</label><input name="referringDoctor" dir="auto" value="${esc(e.referringDoctor)}" ${dis}></div>
            <div class="field"><label>${T("Technician")}</label><input name="technician" dir="auto" value="${esc(e.technician)}" ${dis}></div>
            <div class="field wide"><label>${T("Notes")}</label><textarea name="notes" dir="auto" ${dis}>${esc(e.notes)}</textarea></div>
          </div>
          ${open ? `<div class="actions"><button class="btn primary" type="submit">${T("Save changes")}</button>
            ${e.status === "waiting" ? `<button class="btn danger small" type="button" data-action="cancelExam" data-id="${e.id}">${T("Cancel exam")}</button>` : ""}</div>` : ""}
        </form>
      </section>
      <aside class="side stack">
        <section class="card stack">
          <h2>${T("Payment")}</h2>
          <div class="money-line"><span class="muted">${T("Price")}${e.contrast ? ` <span class="small">(${T("with contrast")})</span>` : ""}</span><span class="num">${iqd(e.price)}</span></div>
          ${e.discount ? `<div class="money-line"><span class="muted">${T("Discount")} <span class="small">· <bdi>${esc(e.discountReason)}</bdi></span></span><span class="num ltr">−${iqd(e.discount)}</span></div>` : ""}
          <div class="money-line"><span class="muted">${T("Paid")}</span><span class="num">${iqd(paid)}</span></div>
          <div class="money-line total"><strong>${e.status === "cancelled" ? T("Cancelled") : owe > 0 ? T("Still owed") : T("Paid in full")}</strong><span class="${owe > 0 ? "owed" : ""}"><span class="num">${iqd(owe)}</span> <small class="muted">${T("IQD")}</small></span></div>
          ${open && owe > 0 ? `<form class="toolbar" data-submit="takePayment" data-id="${e.id}"><input name="amount" type="number" min="1" max="${owe}" step="any" value="${owe}" inputmode="numeric" class="grow-input"><button class="btn primary small" type="submit">${T("Take payment")}</button></form>` : ""}
          ${!paysReady ? `<span class="sub">${T("Loading…")}</span>` : payments.length ? `<table class="list"><thead><tr><th>${T("Receipt")}</th><th>${T("Time")}</th><th class="n">${T("Amount")}</th></tr></thead><tbody>
            ${payments.map((x) => `<tr><td><a href="#/receipt/${x.id}">${x.id}</a>${x.kind === "refund" ? ` <span class="badge cancelled">${T("Refund")}</span>` : ""}<div class="sub"><bdi>${esc(x.by)}</bdi>${x.note ? ` · <bdi>${esc(x.note)}</bdi>` : ""}</div></td><td class="sub num">${fmtDateTime(x.at)}</td><td class="n">${iqd(x.amount)}</td></tr>`).join("")}</tbody></table>` : ""}
          ${open ? `<details><summary>${T("Change price or discount")}</summary><form class="stack" data-submit="changeDiscount" data-id="${e.id}">
            <div class="field"><label>${T("Price (IQD)")}</label><input name="price" type="number" min="0" step="any" value="${e.price || 0}"></div>
            <div class="field"><label>${T("Discount")} (${T("IQD")})</label><input name="discount" type="number" min="0" step="any" value="${e.discount || 0}"></div>
            <div class="field"><label>${T("Reason for discount")}</label><input name="reason" dir="auto" value="${esc(e.discountReason)}"></div>
            <button class="btn small" type="submit">${T("Save")}</button></form></details>` : ""}
          ${paid > 0 ? `<details><summary>${T("Give money back")}</summary><form class="stack" data-submit="refund" data-id="${e.id}">
            <div class="field"><label>${T("Amount")} (${T("IQD")})</label><input name="amount" type="number" min="1" max="${paid}" step="any" value="${paid}"></div>
            <div class="field"><label>${T("Reason")}</label><input name="note" dir="auto" required></div>
            <button class="btn danger small" type="submit">${T("Record refund")}</button></form></details>` : ""}
        </section>
        <section class="card stack"><h2>${T("Earlier exams")}</h2>
          ${!histReady ? `<span class="sub">${T("Loading…")}</span>` : history.length ? history.map((h) => `<div class="money-line"><div><a href="#/exam/${h.id}">${esc(h.examName)}</a><div class="sub">${fmtDate(h.registeredAt)}</div></div>${statusBadge(h.status)}</div>`).join("") : `<span class="muted">${T("This is the patient's first exam.")}</span>`}
          <a class="btn small outline" href="#/register?patient=${e.patientId}">${T("Register another exam")}</a>
        </section>
      </aside>
    </div>`;
}

// ---------- report editor
let editing = null; // { id, dirty, ro, seen, engine }
let autosaveTimer = null;
const narrow = matchMedia("(max-width: 800px)");

function pageEditor(id) {
  if (!needExam(id)) return loadingCard();
  const e = examById(id); if (!e || e.status === "cancelled") return notFound();
  const p = patientOf(e); const r = e.report || {}; const signed = isSigned(e);
  const ro = !canWriteReport();
  const tpls = db.templates.filter((t) => t.modality === e.modality)
    .sort((a, b) => (String(a.examTypeId) !== String(e.examTypeId)) - (String(b.examTypeId) !== String(e.examTypeId)) || a.name.localeCompare(b.name));
  const snips = db.snippets.filter((s) => !s.modality || s.modality === e.modality);
  editing = { id: String(e.id), dirty: false, ro, seen: r.updatedAt || "" };
  const roAttr = ro ? "readonly" : "";
  return `<section class="card patient-bar">
      <div class="item"><span>${T("Patient")} · ${T("ID")} ${e.id}</span><span class="big"><bdi>${esc(p.name)}</bdi></span></div>
      <div class="item"><span>${T("Age")} · ${T("Sex")}</span><span>${ageText(e) || "—"}${p.sex ? " · " + sexText(p.sex) : ""}</span></div>
      <div class="item"><span>${T("Exam")}</span><span>${esc(e.examName)}${e.contrast ? " · " + T("Contrast") : ""}</span></div>
      <div class="item"><span>${T("Referring doctor")}</span><span><bdi>${esc(e.referringDoctor || "—")}</bdi></span></div>
      ${e.notes ? `<div class="item"><span>${T("Notes")}</span><span dir="auto">${esc(e.notes)}</span></div>` : ""}
      <div class="grow"></div>${statusBadge(e.status)}</section>
    <div id="ed-notice"></div>
    <div class="row">
      <section class="card grow editor-card">
        <div class="head">
          ${signed ? `<div class="notice ok">${T("Signed by %(name)s on %(when)s.", { name: esc(r.signedBy), when: fmtDateTime(r.signedAt) })} ${T("Changes are still saved.")}</div>` : ""}
          <div class="grid2">
            <div class="field"><label for="ed-title">${T("Report title")}</label><input id="ed-title" class="title-input" style="color:${esc(db.settings.titleColor)}" value="${esc(r.title || "")}" dir="auto" ${roAttr} data-input="dirty" placeholder="${T("e.g. LUMBOSACRAL SPINE MRI WITH MYELOGRAM")}"></div>
            <div class="field"><label for="ed-dir">${T("Report language")}</label><select id="ed-dir" ${ro ? "disabled" : ""} data-change="edDir"><option value="ltr">${T("English (left to right)")}</option><option value="rtl" ${r.direction === "rtl" ? "selected" : ""}>${T("Arabic (right to left)")}</option></select></div>
          </div>
        </div>
        <div class="section-label">${T("Findings")}</div>
        <div id="sugg-slot"></div>
        <div class="editor-wrap" dir="${r.direction === "rtl" ? "rtl" : "ltr"}">
          <div id="mirror" class="editor mirror" aria-hidden="true"></div>
          <textarea id="editor" class="editor" spellcheck="false" autocomplete="off" ${roAttr} placeholder="${ro ? "" : T("Write the findings here… (Tab accepts the grey suggestion)")}"></textarea>
        </div>
        <div class="imp field"><label for="ed-imp">${T("Impression")}</label><textarea id="ed-imp" dir="auto" ${roAttr} data-input="dirty">${esc(r.impression || "")}</textarea></div>
        <div class="foot">
          <span class="status" id="ed-status">${r.updatedAt ? T("Saved by %(name)s at %(when)s", { name: esc(r.updatedBy), when: fmtTime(r.updatedAt) }) : ro ? "" : T("Saves by itself every few seconds while you type.")}</span>
          ${ro ? `<a class="btn outline" href="#/print/${e.id}">${T("Print preview")}</a>`
            : `<button class="btn" data-action="saveDraft">${T("Save")}</button>
               ${signed ? `<a class="btn primary" href="#/print/${e.id}">${T("Print")}</a>`
                 : `<a class="btn outline" href="#/print/${e.id}">${T("Print preview")}</a>
                    <button class="btn primary" data-action="sign" data-id="${e.id}" ${isDoctor() ? "" : `disabled title="${T("Only the doctor can sign the report.")}"`}>${T("Sign and finish")}</button>`}`}
        </div>
      </section>
      ${ro ? "" : `<aside class="side stack ed-side">
        <section class="card stack" id="sugg-panel"><h2>${T("Suggested sentences")}</h2>
          <ul id="suggestions" class="sugg" dir="ltr"></ul>
          <span class="sub hide-narrow">${T("Tab accepts the grey suggestion, Esc hides it. On a phone, tap a sentence in the list.")}</span></section>
        <section class="card stack"><h2>${T("Spelling")}</h2><ul id="spelling" class="sugg" dir="ltr"></ul></section>
        <section class="card stack"><h2>${T("Templates")}</h2>
          ${tpls.length ? `<div class="tpl-list">${tpls.map((t) => `<button type="button" data-action="useTemplate" data-id="${esc(t.id)}">${esc(t.name)}</button>`).join("")}</div>` : `<span class="muted small">${T("No templates for this modality yet.")}</span>`}
          ${snips.length ? `<h2>${T("Quick text")}</h2><span class="sub">${T("Click to add the sentence where the cursor is.")}</span><div class="snip">${snips.map((s) => `<button type="button" data-action="snippet" data-text="${esc(s.text)}" dir="auto">+ ${esc(s.text)}</button>`).join("")}</div>` : ""}
          <details><summary>${T("Save this report as a template")}</summary><div class="stack">
            <div class="field"><label for="tpl-name">${T("Template name")}</label><input id="tpl-name" dir="auto"></div>
            <button class="btn small outline" type="button" data-action="saveAsTemplate">${T("Save template")}</button></div></details>
        </section>
      </aside>`}
    </div>`;
}

// Fixed values standing in for the select boxes the suggestion engine reads
const fixedValue = (value) => ({ value, addEventListener() {} });
// Exam names the library's region words do not cover
const EXTRA_REGIONS = [[/kub|obstetric|pregnan|kidney|renal/, "Abdomen/Pelvis"], [/thyroid|neck/, "Neck"], [/breast/, "Chest"], [/thigh/, "Hip"]];
function regionFor(name) {
  if (!lib) return "";
  const n = (name || "").toLowerCase();
  const regions = distinct(lib.titles.map((t) => t[2])).filter((r) => r !== "Other");
  return regions.find((r) => r.toLowerCase().split("/").some((part) => n.includes(part.trim().slice(0, 5))))
    || (EXTRA_REGIONS.find(([re]) => re.test(n)) || [])[1] || "";
}

// Sentences that belong to another part of the same region, e.g. lumbar discs in a cervical spine report
function foreignPattern(e) {
  const n = (e.examName || "").toLowerCase(); const out = [];
  if (/cervical/.test(n)) out.push(/\b[LSD]\d{1,2}\b|\bT\d{1,2}\b|lumb|sacr|dorsal|thoracic spine|conus/i);
  if (/lumb|sacr/.test(n)) out.push(/\bC\d\b|cervical|dorsal|\bD\d{1,2}\b|cord compression at C/i);
  if (/dorsal|thoracic/.test(n)) out.push(/\bC[2-7]\b|cervical|\bL[1-5]\b|lumb|sacr/i);
  if (!e.contrast && !/contrast|mra|mrv/.test(n)) out.push(/enhanc|post[- ]?contrast|gadolinium|after (iv )?contrast/i);
  if (/\bleft\b/.test(n)) out.push(/\bright\b/i);
  if (/\bright\b/.test(n)) out.push(/\bleft\b/i);
  return out.length ? new RegExp(out.map((r) => r.source).join("|"), "i") : null;
}

// The library seen by the editor for one exam: only sentences from reports of the same modality and
// region, without sentences of other parts, with this exam's own past reports from the site first
function examLibrary(e) {
  if (!lib) return EMPTY_LIB;
  const mod = LIB_MODALITY[e.modality] || ""; const region = regionFor(e.examName); const foreign = foreignPattern(e);
  // A sentence counts for an exam when at least a quarter of its uses were in that modality and region
  const share = (counts, key) => (counts[key] || 0) >= Math.max(1, 0.25 * Object.values(counts).reduce((a, n) => a + n, 0));
  const fits = (p, useRegion) => (!mod || share(p.modalities, mod)) && (!useRegion || !region || share(p.regions, region)) && !(foreign && foreign.test(p.text));
  let phrases = lib.phrases.filter((p) => fits(p, true));
  if (phrases.length < 40) phrases = lib.phrases.filter((p) => fits(p, false));
  const learned = db.learned.get(String(e.examTypeId)) || { phrases: [], next: [] };
  const BOOST = 50;
  const byKey = new Map(phrases.map((p) => [sentenceKey(p.text), { text: p.text, count: p.count, modalities: {}, regions: {} }]));
  for (const [text, n] of learned.phrases || []) {
    const k = sentenceKey(text); const had = byKey.get(k);
    if (had) had.count += n * BOOST; else if (!(foreign && foreign.test(text))) byKey.set(k, { text, count: n * BOOST, modalities: {}, regions: {} });
  }
  const allowed = new Set(byKey.keys());
  const learnedNext = new Map();
  for (const [prev, text, n] of learned.next || []) (learnedNext.get(prev) || learnedNext.set(prev, []).get(prev)).push([text, n * BOOST]);
  const next = new Proxy({}, { get: (_, key) => {
    if (typeof key !== "string") return undefined;
    const merged = new Map();
    for (const [text, n] of [...(learnedNext.get(key) || []), ...(lib.next[key] || [])]) {
      const k = sentenceKey(text); if (!allowed.has(k)) continue;
      const had = merged.get(k); if (had) had[1] += n; else merged.set(k, [text, n]);
    }
    const list = [...merged.values()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    return list.length ? list : undefined;
  } });
  return { ...lib, phrases: [...byKey.values()], next };
}

// A finished report teaches the library: its sentences, and which sentence follows which, are counted
// for its exam type, once per exam (when it is signed or first printed)
const splitSentences = (text) => String(text || "").split("\n").map((l) => l.trim()).filter(Boolean)
  .flatMap((l) => l.replace(/^\s*(\d+[.)]|[-•*])\s+/, "").split(/(?<=[.;])\s+/)).map((x) => x.trim())
  .filter((x) => x.length > 3 && !/^[A-Z][A-Z0-9 ,/&()'-]*:$/.test(x));
async function learnReport(e) {
  if (!e || e.learned || !e.examTypeId || !(e.report?.body || "").trim()) return;
  const sents = splitSentences(e.report.body);
  if (!sents.length) return;
  const id = String(e.examTypeId);
  await store.tx(async (t) => {
    const cur = (await t.get("learned", id)) || { phrases: [], next: [] };
    const ph = new Map((cur.phrases || []).map(([text, n]) => [sentenceKey(text), [text, n]]));
    for (const x of sents) { const k = sentenceKey(x); const had = ph.get(k); if (had) had[1]++; else ph.set(k, [x, 1]); }
    const nx = new Map((cur.next || []).map(([prev, text, n]) => [prev + "\u0001" + sentenceKey(text), [prev, text, n]]));
    sents.slice(1).forEach((x, i) => { const prev = sentenceKey(sents[i]); const k = prev + "\u0001" + sentenceKey(x); const had = nx.get(k); if (had) had[2]++; else nx.set(k, [prev, x, 1]); });
    const top = (m, idx, max) => [...m.values()].sort((a, b) => b[idx] - a[idx]).slice(0, max);
    t.set("learned", id, { examTypeId: e.examTypeId, examName: e.examName, phrases: top(ph, 1, 2500), next: top(nx, 2, 4000), reports: (cur.reports || 0) + 1, updatedAt: nowIso() });
    t.update("exams", e.id, { learned: true });
  });
}

function mountEditor() {
  if (!editing) return;
  const e = examById(editing.id); if (!e) return;
  const ta = $("#editor");
  ta.value = e.report?.body || "";
  if (!editing.ro) {
    editing.engine = createEditor({
      lib: examLibrary(e), editor: ta, mirror: $("#mirror"), suggList: $("#suggestions"), spellList: $("#spelling"),
      modalitySel: fixedValue(""), regionSel: fixedValue(""),
      ignored, onIgnore: (w) => { ignored.add(w); store.addWord(w).catch(console.error); },
      onInput: () => { autosize(); markDirty(); },
    });
    editing.engine.refresh();
    if (!lib) $("#suggestions").innerHTML = `<li class="empty">${libState === "loading" ? T("Loading…") : T("The report library is not uploaded yet, so there are no sentence suggestions.")}</li>`;
  }
  autosize();
  placeSuggestions();
}

// The findings box grows with its text, so the page scrolls instead of the box
function autosize() {
  const e = $("#editor"); if (!e) return;
  const wrap = e.parentElement;
  wrap.style.minHeight = `${e.offsetHeight}px`; // keep the page height while measuring, so it does not jump
  e.style.height = "auto";
  e.style.height = `${e.scrollHeight}px`;
  wrap.style.minHeight = "";
}
window.addEventListener("resize", autosize);

// On a phone the suggestions sit just above the findings box, where the thumb is
function placeSuggestions() {
  const panel = $("#sugg-panel"), slot = $("#sugg-slot"), side = $(".ed-side");
  if (!panel || !slot || !side) return;
  if (narrow.matches) slot.append(panel); else side.prepend(panel);
}
narrow.addEventListener("change", placeSuggestions);

function editorContent() {
  return { title: $("#ed-title").value.trim(), body: $("#editor").value.replace(/\s+$/, ""), impression: $("#ed-imp").value.trim(), direction: $("#ed-dir").value };
}

async function saveReport(quiet) {
  clearTimeout(autosaveTimer);
  if (!editing || editing.ro || !$("#editor")) return;
  const e = examById(editing.id); if (!e) return;
  const c = editorContent();
  if (!e.report && !c.title && !c.body.trim() && !c.impression) return;
  editing.dirty = false;
  const at = nowIso(); const who = { updatedAt: at, updatedBy: meName(), updatedByUid: uid() };
  const patch = e.report
    ? Object.fromEntries(Object.entries({ ...c, ...who }).map(([k, v]) => [`report.${k}`, v]))
    : { report: { ...c, ...who, signedBy: null, signedByUid: null, signedAt: null } };
  if (e.status === "waiting") patch.status = "draft";
  editing.seen = at;
  const ed = editing;
  try {
    await updateExam(e.id, patch);
    const st = $("#ed-status"); if (st && ed === editing) st.textContent = T("Saved at %(time)s", { time: fmtTime(at) });
    if (!quiet) toast(T("Saved."));
  } catch (err) {
    console.error(err);
    ed.dirty = true;
    const st = $("#ed-status"); if (st && ed === editing) st.textContent = T("Could not save. Check the network; your text is still here.");
    if (ed === editing) autosaveTimer = setTimeout(() => saveReport(true), 5000);
  }
}
function markDirty() {
  if (!editing || editing.ro) return;
  editing.dirty = true;
  const st = $("#ed-status"); if (st) st.textContent = T("Saving…");
  clearTimeout(autosaveTimer); autosaveTimer = setTimeout(() => saveReport(true), 1500);
}

// Another person changed the report that is open here
function onExamsChanged() {
  if (editing && page() === "report") {
    const e = examById(editing.id); const r = e?.report;
    const box = $("#ed-notice");
    if (box && r?.updatedAt && r.updatedAt !== editing.seen && r.updatedByUid !== uid()) {
      editing.seen = r.updatedAt;
      box.innerHTML = `<div class="notice">${T("%(name)s changed this report at %(time)s. Copy anything you need, then reload the page to see their version.", { name: esc(r.updatedBy), time: fmtTime(r.updatedAt) })}</div>`;
    }
  }
  liveUpdate();
}

// ---------- printed report
function pagePrint(id) {
  if (!needExam(id)) return loadingCard();
  const e = examById(id); if (!e) return notFound();
  const p = patientOf(e); const r = e.report || { body: "", direction: "ltr" }; const s = db.settings; const draft = !isSigned(e);
  const signer = db.people.find((x) => (r.signedByUid ? x.id === r.signedByUid : x.name === r.signedBy) && (x.sigTitle || x.sigName));
  // A signer without their own signature lines gets the clinic's title with their name
  const sig = signer ? { t: signer.sigTitle, n: signer.sigName, d: signer.sigDegrees } : { t: s.sigTitle, n: s.sigName || r.signedBy || "", d: s.sigDegrees };
  const head = db.letterhead.header
    ? `<img class="letterhead" src="${db.letterhead.header}" alt="">`
    : `<div class="text-head" style="border-color:${esc(s.titleColor)}"><b>${esc(s.nameEn)}</b><b dir="rtl">${esc(s.nameAr)}</b></div>`;
  const back = canWriteReport() ? `<a class="btn" href="#/report/${e.id}">${T("Back to report")}</a>` : `<a class="btn" href="#/exam/${e.id}">${T("Back to exam")}</a>`;
  return `<div class="paper-wrap"><div class="paper-bar no-print">
      ${back}<a class="btn" href="#/">${T("Worklist")}</a>
      ${draft ? `<span class="note">${T("Preview only: the report is not signed, so it prints with DRAFT across it.")}</span><button class="btn" data-action="printNow">${T("Print draft")}</button>`
        : `${e.printCount ? `<span class="note">${T("Printed %(n)s times before", { n: e.printCount })}</span>` : ""}<button class="btn primary" data-action="printReport" data-id="${e.id}">${T("Print")}</button>`}
      <button class="btn outline" data-action="savePdf" data-id="${e.id}">${T("Save PDF")}</button>
      ${!db.letterhead.header && canManage() ? `<span class="note">${T("Upload the letterhead and footer images in Settings → Clinic.")}</span>` : ""}
    </div>
    <div class="sheet">${draft ? `<div class="watermark">DRAFT</div>` : ""}
      <table class="frame"><thead><tr><td>
        ${head}
        <div class="patient">
          <div><b>اسم المريض :</b> <span dir="auto">${esc(p.name)}</span></div>
          <div><b>العمر :</b> ${ageArabic(e)}</div>
          <div class="barcode">${barcode(e.id)}<span>${e.id}</span></div>
          <div><b>اسم الطبيب :</b> <span dir="auto">${esc(e.referringDoctor)}</span></div>
          <div><b>التاريخ :</b> <span dir="ltr">${fmtDate(e.registeredAt)}</span></div>
        </div><div class="rule" style="background:${esc(s.titleColor)}"></div>
      </td></tr></thead>
      <tfoot><tr><td><div class="footer-space"></div></td></tr></tfoot>
      <tbody><tr><td><div class="content" dir="${r.direction || "ltr"}">
        ${r.title ? `<div class="title" style="color:${esc(s.titleColor)}">${esc(r.title)}</div>` : ""}
        <div>${textToHtml(r.body)}</div>
        ${r.impression ? `<div class="impression"><b>${r.direction === "rtl" ? "الانطباع:" : "Impression:"}</b><span class="pre">${esc(r.impression)}</span></div>` : ""}
      </div></td></tr></tbody></table>
      <div class="footer"><div class="sign-row"><div class="printed">Printed: <span dir="ltr">${fmtDateTime(new Date())}</span></div>
        <div class="signature">${sig.t ? `<b>${esc(sig.t)}</b>` : ""}${sig.n ? `<b>${esc(sig.n)}</b>` : ""}${sig.d ? `<span>${esc(sig.d)}</span>` : ""}</div></div>
        ${db.letterhead.footer ? `<img class="strip" src="${db.letterhead.footer}" alt="">` : ""}</div>
    </div></div>`;
}

function pageReceipt(id) {
  if (!needPayment(id)) return loadingCard();
  const pay = byId(db.payments, id); if (!pay) return notFound();
  if (!needExam(pay.examId)) return loadingCard();
  const e = examById(pay.examId); const p = patientOf(e); const s = db.settings;
  if (!needExamPayments(e)) return loadingCard();
  const paid = db.payments.filter((x) => x.examId === e.id && x.id <= pay.id).reduce((a, x) => a + x.amount, 0);
  const left = e.status === "cancelled" ? 0 : net(e) - paid; const refund = pay.kind === "refund";
  const roll = s.receiptPaper === "80mm";
  return `<div class="paper-wrap"><div class="paper-bar no-print">
      <a class="btn" href="#/exam/${e.id}">${T("Back to exam")}</a><a class="btn" href="#/">${T("Worklist")}</a><a class="btn" href="#/register">${T("Register next patient")}</a>
      <button class="btn primary" data-action="printNow">${T("Print receipt")}</button></div>
    <div class="receipt ${roll ? "roll" : "a5"}">
      ${roll || !db.letterhead.header ? `<div class="clinic"><b>${esc(s.nameAr || s.nameEn)}</b>${s.nameAr ? `<span>${esc(s.nameEn)}</span>` : ""}</div>` : `<img class="letterhead" src="${db.letterhead.header}" alt="">`}
      <h1>${refund ? "وصل إرجاع مبلغ" : "وصل قبض"}</h1>
      <dl><dt>رقم الوصل :</dt><dd>${pay.id}</dd><dt>التاريخ :</dt><dd><span class="ltr">${fmtDateTime(pay.at)}</span></dd>
        <dt>اسم المريض :</dt><dd><bdi>${esc(p.name)}</bdi></dd><dt>رقم الفحص :</dt><dd>${e.id}</dd>
        <dt>الفحص :</dt><dd><bdi>${esc(e.examName)}</bdi>${e.contrast ? " · مع مادة ظليلة" : ""}</dd></dl>
      <table><tr><td>السعر</td><td class="n">${iqd(e.price)}</td></tr>
        ${e.discount ? `<tr><td>الخصم</td><td class="n">${iqd(e.discount)}</td></tr><tr><td>الصافي</td><td class="n">${iqd(net(e))}</td></tr>` : ""}
        <tr class="big"><td>${refund ? "المبلغ المُرجَع" : "المبلغ المستلم"}</td><td class="n"><span dir="rtl">${iqd(Math.abs(pay.amount))} دينار</span></td></tr>
        <tr><td>مجموع المدفوع</td><td class="n">${iqd(paid)}</td></tr>${left > 0 ? `<tr><td>المتبقي</td><td class="n">${iqd(left)}</td></tr>` : ""}</table>
      <div class="barcode">${barcode(e.id)}<span>${e.id}</span></div>
      <div class="foot"><span>${refund ? "سلّم المبلغ" : "استلم المبلغ"} : <bdi>${esc(pay.by)}</bdi></span><span>التوقيع : ............</span></div>
      ${refund ? "" : `<p class="note">يرجى الاحتفاظ بهذا الوصل لاستلام التقرير.</p>`}
    </div></div>`;
}

function pageSearch(q) {
  const text = (q.get("q") || "").trim().toLowerCase(); const from = q.get("from") || ""; const to = q.get("to") || "";
  const mod = q.get("modality") || ""; const st = q.get("status") || ""; const doc = q.get("doctor") || "";
  const any = text || from || to || mod || st || doc;
  let ready = true;
  if (from) ready = needRange(from, to || today());
  if (/^\d+$/.test(text)) ready = needExam(text) && ready;
  let rows = any ? db.exams.slice() : [];
  if (text) rows = rows.filter((e) => {
    const r = e.report || {};
    const hay = [e.patientName, e.phone, String(e.id), e.examName, r.title, r.impression, r.body].join(" ").toLowerCase();
    return text.split(/\s+/).every((w) => hay.includes(w));
  });
  if (from) rows = rows.filter((e) => e.day >= from);
  if (to) rows = rows.filter((e) => e.day <= to);
  if (mod) rows = rows.filter((e) => e.modality === mod);
  if (st) rows = rows.filter((e) => e.status === st);
  if (doc) rows = rows.filter((e) => e.referringDoctor === doc);
  rows.sort(newestFirst);
  const shown = rows.slice(0, 200);
  return `<div class="page-head"><div class="grow"><h1>${T("Search reports")}</h1></div></div>
    <form class="card toolbar" data-submit="search">
      <input type="search" name="q" value="${esc(q.get("q") || "")}" placeholder="${T("Name, phone, ID or words in the report")}" class="grow-input">
      <label class="small">${T("From")}</label><input type="date" name="from" value="${from}"><label class="small">${T("To")}</label><input type="date" name="to" value="${to}">
      <select name="modality"><option value="">${T("Any modality")}</option>${Object.entries(MODALITIES).map(([k, v]) => `<option value="${k}" ${mod === k ? "selected" : ""}>${T(v)}</option>`).join("")}</select>
      <select name="status"><option value="">${T("Any status")}</option>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${st === k ? "selected" : ""}>${T(v)}</option>`).join("")}</select>
      <select name="doctor"><option value="">${T("Any referring doctor")}</option>${distinct(db.exams.map((e) => e.referringDoctor)).map((d) => `<option ${doc === d ? "selected" : ""}>${esc(d)}</option>`).join("")}</select>
      <button class="btn primary" type="submit">${T("Search")}</button></form>
    ${from ? "" : `<div class="sub">${T("Searching the last %(n)s days. Pick a start date to search older reports.", { n: WINDOW_DAYS })}</div>`}
    <section class="card">${!any ? `<div class="empty">${T("Type a name, phone number, ID or words from the report.")}</div>` : !ready ? `<div class="empty">${T("Loading…")}</div>` : !rows.length ? `<div class="empty"><strong>${T("Nothing found")}</strong><div>${T("Try fewer filters or a shorter name.")}</div></div>` : `
      <div class="sub spaced">${T("%(n)s found", { n: rows.length })}${rows.length > 200 ? " · " + T("showing the newest 200") : ""}</div>
      <div class="table-wrap"><table class="list"><thead><tr><th>${T("ID")}</th><th>${T("Date")}</th><th>${T("Patient")}</th><th>${T("Exam")}</th><th>${T("Referring doctor")}</th><th>${T("Status")}</th><th></th></tr></thead><tbody>
      ${shown.map((e) => `<tr><td><a href="#/exam/${e.id}">${e.id}</a></td><td class="num">${fmtDate(e.registeredAt)}</td>
        <td class="strong"><a href="#/exam/${e.id}" class="plain"><bdi>${esc(e.patientName)}</bdi></a><div class="sub ltr">${esc(e.phone)}</div></td>
        <td>${esc(e.examName)}<div class="sub">${esc(e.report?.title || "")}</div></td><td><bdi>${esc(e.referringDoctor || "—")}</bdi></td><td>${statusBadge(e.status)}</td>
        <td class="end">${isSigned(e) ? `<a href="#/print/${e.id}">${T("Print")}</a>` : e.status !== "cancelled" ? `<a href="#/report/${e.id}">${T("Open report")}</a>` : ""}</td></tr>`).join("")}
      </tbody></table></div>`}</section>`;
}

function pageCash(q) {
  const day = q.get("day") || today();
  if (!needRange(day, day)) return loadingCard();
  const pays = db.payments.filter((p) => p.day === day).sort((a, b) => a.at.localeCompare(b.at));
  const received = pays.filter((p) => p.amount > 0).reduce((a, p) => a + p.amount, 0);
  const refunded = -pays.filter((p) => p.amount < 0).reduce((a, p) => a + p.amount, 0);
  const cashiers = {};
  for (const p of pays) { const c = cashiers[p.by] ||= { name: p.by, n: 0, in: 0, out: 0 }; c.n++; p.amount > 0 ? (c.in += p.amount) : (c.out -= p.amount); }
  const dayExams = db.exams.filter((e) => e.day === day && e.status !== "cancelled");
  const billed = dayExams.reduce((a, e) => a + net(e), 0); const owed = dayExams.reduce((a, e) => a + Math.max(0, due(e)), 0);
  return `<div class="page-head"><div class="grow"><span class="eyebrow">${esc(longDate(day))}</span><h1>${T("Daily cash")}</h1></div>
      <input type="date" value="${day}" data-change="cashDay" class="no-print auto"><button class="btn no-print" data-action="printNow">${T("Print")}</button></div>
    <div class="stats">
      <div class="card stat ok"><span class="label">${T("Received")}</span><span class="value num">${iqd(received)}</span></div>
      <div class="card stat"><span class="label">${T("Given back")}</span><span class="value num">${iqd(refunded)}</span></div>
      <div class="card stat"><span class="label">${T("In the drawer")}</span><span class="value num">${iqd(received - refunded)}</span></div>
      <div class="card stat warn"><span class="label">${T("Still owed for today's exams")}</span><span class="value num">${iqd(owed)}</span><span class="sub">${T("Billed")}: ${iqd(billed)}</span></div>
    </div>
    <section class="card"><h2>${T("By cashier")}</h2>${Object.keys(cashiers).length ? `<div class="table-wrap"><table class="list"><thead><tr><th>${T("Name")}</th><th class="n">${T("Receipts")}</th><th class="n">${T("Received")}</th><th class="n">${T("Given back")}</th><th class="n">${T("Net")}</th></tr></thead><tbody>
      ${Object.values(cashiers).map((c) => `<tr><td><bdi>${esc(c.name)}</bdi></td><td class="n">${c.n}</td><td class="n">${iqd(c.in)}</td><td class="n">${iqd(c.out)}</td><td class="n strong">${iqd(c.in - c.out)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">${T("No payments on this day")}<div class="sub">${T("Payments appear here as reception takes them.")}</div></div>`}</section>
    ${pays.length ? `<section class="card"><h2>${T("Payments")}</h2><div class="table-wrap"><table class="list"><thead><tr><th>${T("Time")}</th><th>${T("Receipt")}</th><th>${T("Patient")}</th><th>${T("Taken by")}</th><th class="n">${T("Amount")}</th></tr></thead><tbody>
      ${pays.map((p) => `<tr><td class="num">${fmtTime(p.at)}</td><td><a href="#/receipt/${p.id}">${p.id}</a>${p.kind === "refund" ? ` <span class="badge cancelled">${T("Refund")}</span>` : ""}</td><td><a href="#/exam/${p.examId}"><bdi>${esc(p.patientName)}</bdi></a><div class="sub">${esc(p.examName)}</div></td><td><bdi>${esc(p.by)}</bdi></td><td class="n">${iqd(p.amount)}</td></tr>`).join("")}</tbody></table></div></section>` : ""}`;
}

function statsData(from, to) {
  const inPeriod = db.exams.filter((e) => e.day >= from && e.day <= to);
  const exams = inPeriod.filter((e) => e.status !== "cancelled");
  const group = (keyFn) => { const m = new Map(); for (const e of exams) { const k = keyFn(e); const g = m.get(k) || { key: k, count: 0, net: 0, contrast: 0 }; g.count++; g.net += net(e); g.contrast += e.contrast ? 1 : 0; m.set(k, g); } return [...m.values()].sort((a, b) => b.count - a.count); };
  const cash = db.payments.filter((p) => p.day >= from && p.day <= to).reduce((a, p) => a + p.amount, 0);
  const signed = new Map(); for (const e of db.exams) { const r = e.report; if (r?.signedAt) { const k = dayKey(r.signedAt); if (k >= from && k <= to) signed.set(r.signedBy, (signed.get(r.signedBy) || 0) + 1); } }
  return { inPeriod, exams, cash, count: exams.length, net: exams.reduce((a, e) => a + net(e), 0), discounts: exams.reduce((a, e) => a + (e.discount || 0), 0),
    contrast: exams.filter((e) => e.contrast).length, cancelled: inPeriod.length - exams.length,
    byModality: group((e) => e.modality), byDay: group((e) => e.day).sort((a, b) => a.key.localeCompare(b.key)),
    byDoctor: group((e) => e.referringDoctor || ""), byExam: group((e) => e.examName), byTech: group((e) => e.technician || ""),
    byRadiologist: [...signed.entries()].sort((a, b) => b[1] - a[1]) };
}
function pageStats(q) {
  const t = today(); const first = t.slice(0, 8) + "01";
  const lastMonthEnd = addDays(first, -1);
  const presets = [["Today", t, t], ["Last 7 days", addDays(t, -6), t], ["This month", first, t], ["Last month", lastMonthEnd.slice(0, 8) + "01", lastMonthEnd], ["This year", t.slice(0, 5) + "01-01", t]];
  let from = q.get("from") || first, to = q.get("to") || t; if (from > to) [from, to] = [to, from];
  const head = `<div class="page-head"><div class="grow"><span class="eyebrow">${fmtDate(from + "T12:00")} – ${fmtDate(to + "T12:00")}</span><h1>${T("Stats")}</h1></div>
      <button class="btn outline no-print" data-action="csv" data-from="${from}" data-to="${to}">${T("Download spreadsheet")}</button><button class="btn no-print" data-action="printNow">${T("Print")}</button></div>
    <section class="card stack no-print"><div class="chips">${presets.map(([l, a, b]) => `<a class="chip ${a === from && b === to ? "on" : ""}" href="#/stats?from=${a}&to=${b}">${T(l)}</a>`).join("")}</div>
      <form class="toolbar" data-submit="statsPeriod"><label class="small">${T("From")}</label><input type="date" name="from" value="${from}"><label class="small">${T("To")}</label><input type="date" name="to" value="${to}"><button class="btn small" type="submit">${T("Show")}</button></form></section>`;
  if (!needRange(from, to)) return head + loadingCard();
  const d = statsData(from, to);
  const share = (n) => d.count ? Math.round(n * 100 / d.count) + "%" : "0%";
  const table = (title, cols, rows) => `<section class="card"><h2>${T(title)}</h2>${rows.length ? `<div class="table-wrap"><table class="list"><thead><tr>${cols.map((h, i) => `<th class="${i ? "n" : ""}">${T(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td class="${i ? "n" : ""}">${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : `<div class="empty">—</div>`}</section>`;
  if (!d.inPeriod.length) return head + `<section class="card"><div class="empty"><strong>${T("No exams in this period")}</strong><div>${T("Pick other dates above.")}</div></div></section>`;
  return head + `
    <div class="stats">
      <div class="card stat"><span class="label">${T("Exams")}</span><span class="value">${d.count}</span><span class="sub">${T("With contrast")}: ${d.contrast} · ${T("Cancelled")}: ${d.cancelled}</span></div>
      <div class="card stat ok"><span class="label">${T("Income after discounts")}</span><span class="value num">${iqd(d.net)}</span></div>
      <div class="card stat"><span class="label">${T("Discounts given")}</span><span class="value num">${iqd(d.discounts)}</span></div>
      <div class="card stat"><span class="label">${T("Cash received")}</span><span class="value num">${iqd(d.cash)}</span></div>
    </div>
    <div class="row"><div class="grow stack">
      ${table("By modality", ["Modality", "Exams", "With contrast", "Income", "Share"], d.byModality.map((r) => [T(MODALITIES[r.key] || r.key), r.count, r.contrast, iqd(r.net), share(r.count)]))}
      ${table("By referring doctor", ["Referring doctor", "Exams", "Income", "Share"], d.byDoctor.map((r) => [r.key ? `<bdi>${esc(r.key)}</bdi>` : `<span class="muted">${T("Not given")}</span>`, r.count, iqd(r.net), share(r.count)]))}
      ${table("By exam", ["Exam", "Exams", "Income", "Share"], d.byExam.map((r) => [esc(r.key), r.count, iqd(r.net), share(r.count)]))}
    </div><div class="side stack">
      ${table("By day", ["Date", "Exams", "Income"], d.byDay.map((r) => [`<a href="#/?day=${r.key}">${fmtDate(r.key + "T12:00")}</a>`, r.count, iqd(r.net)]))}
      ${table("By technician", ["Technician", "Exams"], d.byTech.map((r) => [r.key ? `<bdi>${esc(r.key)}</bdi>` : `<span class="muted">${T("Not given")}</span>`, r.count]))}
      ${table("Reports signed", ["Radiologist", "Reports"], d.byRadiologist.map(([n, c]) => [`<bdi>${esc(n)}</bdi>`, c]))}
    </div></div>`;
}
function downloadCsv(from, to) {
  const rows = db.exams.filter((e) => e.day >= from && e.day <= to).sort((a, b) => a.id - b.id);
  const head = ["ID", "Date", "Time", "Patient", "Sex", "Age", "Phone", "Modality", "Exam", "Contrast", "Referring doctor", "Technician", "Price", "Discount", "Reason for discount", "Net", "Paid", "Still owed", "Status", "Signed by", "Registered by"].map((h) => T(h));
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [head.map(q).join(",")];
  for (const e of rows) lines.push([e.id, e.day, fmtTime(e.registeredAt), e.patientName, sexText(e.sex), ageText(e), e.phone, T(MODALITIES[e.modality]), e.examName, e.contrast ? T("Yes") : T("No"), e.referringDoctor, e.technician, e.price, e.discount, e.discountReason, net(e), paidFor(e), due(e), T(STATUS[e.status]), e.report?.signedBy || "", e.registeredBy].map(q).join(","));
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `exams-${from}-to-${to}.csv`; document.body.append(a); a.click(); a.remove();
}

// ---------- settings
function pageSettings(q) {
  const s = db.settings;
  const tabs = [["clinic", "Clinic", canManage], ["people", "People", canManage], ["prices", "Exam types and prices", canManage],
    ["templates", "Templates", canWriteReport], ["snippets", "Quick text", canWriteReport], ["library", "Library", canManage]].filter(([, , ok]) => ok());
  if (!tabs.length) return `<section class="card"><div class="empty">${T("Only an admin or the doctor can change these settings.")}</div></section>`;
  const tab = tabs.some(([k]) => k === q.get("tab")) ? q.get("tab") : tabs[0][0];
  let body = "";
  if (tab === "clinic") body = `<form class="card stack" data-submit="saveClinic">
      <div class="grid2">
        <div class="field"><label>${T("Clinic name (English)")}</label><input name="nameEn" value="${esc(s.nameEn)}"></div>
        <div class="field"><label>${T("Clinic name (Arabic)")}</label><input name="nameAr" dir="rtl" value="${esc(s.nameAr)}"></div>
        <div class="field"><label>${T("Default signature title")}</label><input name="sigTitle" value="${esc(s.sigTitle)}"></div>
        <div class="field"><label>${T("Default signature name")}</label><input name="sigName" value="${esc(s.sigName)}"></div>
        <div class="field"><label>${T("Default signature degrees")}</label><input name="sigDegrees" value="${esc(s.sigDegrees)}"></div>
        <div class="field"><label>${T("Report title colour")}</label><input name="titleColor" type="color" value="${esc(s.titleColor)}" class="color"></div>
        <div class="field"><label>${T("Receipt paper")}</label><select name="receiptPaper"><option value="a5">A5</option><option value="80mm" ${s.receiptPaper === "80mm" ? "selected" : ""}>${T("80 mm receipt printer")}</option></select></div>
      </div>
      <div class="actions"><button class="btn primary" type="submit">${T("Save")}</button></div>
      <h2>${T("Letterhead")}</h2>
      <div class="grid2">
        ${[["header", "Letterhead image", "Printed across the top of every report. Leave empty to use the built-in one."], ["footer", "Footer image", "Printed across the bottom of every report. Leave empty to use the built-in one."]].map(([w, label]) => `
        <div class="stack"><span class="label">${T(label)}</span>${db.letterhead[w] ? `<img src="${db.letterhead[w]}" class="preview" alt="">` : `<div class="empty preview">—</div>`}
          <div class="actions"><button class="btn small" type="button" data-action="pickImage" data-which="${w}">${T("Choose image")}</button>${db.letterhead[w] ? `<button class="btn small" type="button" data-action="resetImage" data-which="${w}">${T("Remove")}</button>` : ""}</div></div>`).join("")}
      </div></form>`;
  if (tab === "people") body = `<section class="card stack"><p class="muted flush">${T("Everyone who uses the site. Each person signs in with their own email, so reports and payments show who did them. Only a Doctor can sign reports.")}</p>
      <div class="table-wrap"><table class="list"><thead><tr><th>${T("Name")}</th><th>${T("Role")}</th><th>${T("Email")}</th><th>${T("Signature on printed reports")}</th><th></th></tr></thead><tbody>
      ${db.people.map((p) => `<tr><td><bdi>${esc(p.name)}</bdi></td><td>${ROLES[p.role] ? T(ROLES[p.role]) : "—"}</td><td class="sub ltr">${esc(p.email || "")}</td><td class="sub">${esc([p.sigTitle, p.sigName, p.sigDegrees].filter(Boolean).join(" · "))}</td><td class="end"><a href="#/settings?tab=people&edit=${esc(p.id)}">${T("Edit")}</a></td></tr>`).join("")}</tbody></table></div>
      ${personForm(byId(db.people, q.get("edit")))}</section>`;
  if (tab === "prices") body = `<form class="card stack" data-submit="savePrices"><p class="muted flush">${T("Prices in IQD. The contrast price is added when the exam is done with contrast.")}</p>
      <div class="table-wrap"><table class="list"><thead><tr><th>${T("Modality")}</th><th>${T("Exam")}</th><th>${T("Price")}</th><th>${T("Contrast price")}</th><th>${T("In use")}</th></tr></thead><tbody>
      ${db.examTypes.map((t) => `<tr><td>${T(MODALITIES[t.modality])}</td><td><input name="name-${t.id}" value="${esc(t.name)}"></td><td><input name="price-${t.id}" type="number" min="0" step="any" value="${t.price}" class="money"></td><td><input name="cprice-${t.id}" type="number" min="0" step="any" value="${t.contrastPrice}" class="money"></td><td><input name="active-${t.id}" type="checkbox" ${t.active ? "checked" : ""}></td></tr>`).join("")}
      </tbody></table></div>
      <div class="toolbar"><select name="newModality">${Object.entries(MODALITIES).map(([k, v]) => `<option value="${k}">${T(v)}</option>`).join("")}</select><input name="newName" placeholder="${T("New exam name")}"><span class="sub">${T("(added when you save)")}</span></div>
      <div class="actions"><button class="btn primary" type="submit">${T("Save")}</button></div></form>`;
  if (tab === "templates") {
    const edit = q.get("edit");
    const t = edit === "new" ? { id: "", modality: "MRI", examTypeId: null, name: "", title: "", body: "", impression: "", direction: "ltr" } : byId(db.templates, edit);
    body = t ? templateForm(t) : `<section class="card stack"><p class="muted flush">${T("Normal findings for each exam, ready to edit in the report.")}</p><div class="actions"><a class="btn primary" href="#/settings?tab=templates&edit=new">${T("New template")}</a></div>
      <div class="table-wrap"><table class="list"><thead><tr><th>${T("Name")}</th><th>${T("Modality")}</th><th>${T("Exam")}</th><th></th></tr></thead><tbody>
      ${db.templates.slice().sort((a, b) => a.modality.localeCompare(b.modality) || a.name.localeCompare(b.name)).map((x) => `<tr><td>${esc(x.name)}</td><td>${T(MODALITIES[x.modality])}</td><td class="sub">${esc(byId(db.examTypes, x.examTypeId)?.name || "—")}</td><td class="end"><a href="#/settings?tab=templates&edit=${esc(x.id)}">${T("Edit")}</a></td></tr>`).join("")}</tbody></table></div></section>`;
  }
  if (tab === "snippets") body = `<form class="card stack" data-submit="saveSnippets"><p class="muted flush">${T("One sentence per line. They show beside the report editor for that modality; the last box is for every modality.")}</p>
      <div class="grid2">${[...Object.keys(MODALITIES), ""].map((m) => `<div class="field"><label>${m ? T(MODALITIES[m]) : T("Every modality")}</label><textarea name="snip-${m}" rows="5" dir="auto">${esc(db.snippets.filter((s2) => s2.modality === m).map((s2) => s2.text).join("\n"))}</textarea></div>`).join("")}</div>
      <div class="actions"><button class="btn primary" type="submit">${T("Save")}</button></div></form>`;
  if (tab === "library") body = `<section class="card stack">
      <p class="muted flush">${libState === "ready" ? T("Library: %(n)s sentences", { n: iqd(lib.phrases.length) }) : libState === "loading" ? T("Loading…") : T("The report library is not uploaded yet, so there are no sentence suggestions.")}</p>
      <p class="sub flush">${T("Choose the six files from the data folder: phrases, next, ngrams, vocab, typos, titles.")}</p>
      <div class="actions"><button class="btn primary" type="button" data-action="pickLibrary">${T("Upload library")}</button></div>
      <div id="library-status" class="sub"></div></section>`;
  return `<div class="page-head"><div class="grow"><h1>${T("Settings")}</h1></div></div>
    <div class="chips">${tabs.map(([k, l]) => `<a class="chip ${tab === k ? "on" : ""}" href="#/settings?tab=${k}">${T(l)}</a>`).join("")}</div>${body}`;
}
function personForm(p) {
  const isNew = !p;
  p = p || { id: "", name: "", role: "reception", sigTitle: "", sigName: "", sigDegrees: "" };
  return `<form class="stack divided" data-submit="savePerson" data-id="${esc(p.id)}"><h2>${isNew ? T("Add a person") : T("Edit person")}</h2>
    <div class="grid2"><div class="field"><label>${T("Name")}</label><input name="name" required dir="auto" value="${esc(p.name)}"></div>
      <div class="field"><label>${T("Role")}</label><select name="role">${Object.entries(ROLES).map(([k, v]) => `<option value="${k}" ${p.role === k ? "selected" : ""}>${T(v)}</option>`).join("")}</select></div>
      ${isNew ? `<div class="field"><label>${T("Email (for sign-in)")}</label><input name="email" type="email" dir="ltr" required autocomplete="off"></div>
      <div class="field"><label>${T("Password (at least 6 characters)")}</label><input name="password" type="text" dir="ltr" minlength="6" required autocomplete="new-password"></div>` : ""}
      <div class="field"><label>${T("Signature title (doctors)")}</label><input name="sigTitle" value="${esc(p.sigTitle)}" placeholder="Specialist Radiologist"></div>
      <div class="field"><label>${T("Signature name (doctors)")}</label><input name="sigName" value="${esc(p.sigName)}"></div>
      <div class="field wide"><label>${T("Signature degrees (doctors)")}</label><input name="sigDegrees" value="${esc(p.sigDegrees)}"></div></div>
    <div id="person-error" class="sub error-text"></div>
    <div class="actions"><button class="btn primary" type="submit">${isNew ? T("Create the account") : T("Save")}</button>${isNew ? "" : `<a class="btn" href="#/settings?tab=people">${T("Cancel")}</a>${p.id !== uid() ? `<button class="btn danger small" type="button" data-action="deletePerson" data-id="${esc(p.id)}">${T("Remove")}</button>` : ""}`}</div></form>`;
}
function templateForm(t) {
  return `<form class="card stack" data-submit="saveTemplate" data-id="${esc(t.id)}"><h2>${t.id ? T("Edit template") : T("New template")}</h2>
    <div class="grid2"><div class="field"><label>${T("Template name")}</label><input name="name" required dir="auto" value="${esc(t.name)}"></div>
      <div class="field"><label>${T("Modality")}</label><select name="modality">${Object.entries(MODALITIES).map(([k, v]) => `<option value="${k}" ${t.modality === k ? "selected" : ""}>${T(v)}</option>`).join("")}</select></div>
      <div class="field"><label>${T("For exam (shown first)")}</label><select name="examTypeId"><option value="">—</option>${db.examTypes.map((e) => `<option value="${e.id}" ${String(t.examTypeId) === String(e.id) ? "selected" : ""}>${T(MODALITIES[e.modality])} · ${esc(e.name)}</option>`).join("")}</select></div>
      <div class="field"><label>${T("Report language")}</label><select name="direction"><option value="ltr">${T("English (left to right)")}</option><option value="rtl" ${t.direction === "rtl" ? "selected" : ""}>${T("Arabic (right to left)")}</option></select></div>
      <div class="field wide"><label>${T("Report title")}</label><input name="title" dir="auto" value="${esc(t.title)}"></div>
      <div class="field wide"><label>${T("Findings")}</label><textarea name="body" rows="10" dir="${t.direction}">${esc(t.body)}</textarea></div>
      <div class="field wide"><label>${T("Impression")}</label><textarea name="impression" dir="auto">${esc(t.impression)}</textarea></div></div>
    <div class="actions"><button class="btn primary" type="submit">${T("Save")}</button><a class="btn" href="#/settings?tab=templates">${T("Cancel")}</a>${t.id ? `<button class="btn danger small" type="button" data-action="deleteTemplate" data-id="${esc(t.id)}">${T("Delete")}</button>` : ""}</div></form>`;
}

function notFound() { return `<section class="card"><div class="empty"><strong>${T("Not found")}</strong><div><a href="#/">${T("Today's worklist")}</a></div></div></section>`; }

// ------------------------------------------------------------ login
function renderLogin(error) {
  document.documentElement.lang = LANG; document.documentElement.dir = LANG === "ar" ? "rtl" : "ltr";
  document.title = T("Radiology reports");
  $("#root").innerHTML = `<div class="login"><form id="login-form" class="card login-card">
      <div class="brand-mark big">${esc((SETTINGS.nameAr || "R").slice(0, 1))}</div>
      <h1>${T("Radiology reports")}</h1>
      <p class="muted">${esc(SETTINGS.nameAr)} · ${esc(SETTINGS.nameEn)}</p>
      <div class="field"><label for="login-email">${T("Email")}</label><input id="login-email" type="email" autocomplete="username" required dir="ltr"></div>
      <div class="field"><label for="login-password">${T("Password")}</label><input id="login-password" type="password" autocomplete="current-password" required dir="ltr"></div>
      <button class="btn primary" type="submit">${T("Sign in")}</button>
      <div id="login-error" class="sub error-text" role="alert">${error ? esc(error) : ""}</div>
      <div class="login-foot"><span class="sub">${T("Staff sign-in only")}</span><button class="btn small" type="button" data-action="lang">${LANG === "ar" ? "English" : "العربية"}</button></div>
    </form></div>`;
}

// ------------------------------------------------------------ router
const PAGE_CSS = {
  report: '@page { size: A4; margin: 0 0 7mm 0; @bottom-left { content: "Page " counter(page) " of " counter(pages); font: 8pt Calibri, Almarai, sans-serif; color: #444; padding-left: 14mm; } }',
  a5: "@page { size: A5; margin: 8mm; }",
  roll: "@page { size: 80mm auto; margin: 0; }",
};
function render(keepScroll) {
  if (!store?.user) return renderLogin();
  document.documentElement.lang = LANG; document.documentElement.dir = LANG === "ar" ? "rtl" : "ltr";
  const [path, query] = (location.hash.slice(1) || "/").split("?");
  const q = new URLSearchParams(query || ""); const parts = path.split("/").filter(Boolean);
  const y = window.scrollY;
  editing = null;
  stale = false;
  let html; let paper = false;
  if (!ROLES[role()]) html = `<section class="card"><div class="empty"><strong>${T("Your account has no role yet. Ask the admin to set it in Settings → People.")}</strong><div class="ltr">${esc(store.user.email || "")}</div></div></section>`;
  else switch (parts[0]) {
    case undefined: html = pageWorklist(q); break;
    case "register": html = pageRegister(q); break;
    case "exam": html = pageExam(parts[1]); break;
    case "report": html = pageEditor(parts[1]); break;
    case "print": html = pagePrint(parts[1]); paper = true; break;
    case "receipt": html = pageReceipt(parts[1]); paper = true; break;
    case "search": html = pageSearch(q); break;
    case "cash": html = pageCash(q); break;
    case "stats": html = pageStats(q); break;
    case "settings": html = pageSettings(q); break;
    default: html = notFound();
  }
  $("#root").innerHTML = paper ? html : shell(html);
  // One @page rule for the paper on screen. Chrome adds an empty page after a sheet that uses a named page, so the rule is swapped instead.
  $("#page-css").textContent = $(".sheet") ? PAGE_CSS.report : $(".receipt.roll") ? PAGE_CSS.roll : $(".receipt") ? PAGE_CSS.a5 : "";
  document.title = `${T("Radiology reports")} · ${db.settings.nameEn}`;
  renderBanner();
  if (parts[0] === "register") regRecalc(true);
  const wk = $(".week"), on = $(".week-day.on");
  if (wk && on) wk.scrollLeft += on.getBoundingClientRect().left - wk.getBoundingClientRect().left - (wk.clientWidth - on.offsetWidth) / 2;
  if (parts[0] === "report") mountEditor();
  if (paper) fitPaper();
  // Print once: the address drops ?print=1 so a live update of the page does not print again
  if (parts[0] === "receipt" && q.get("print") === "1" && $(".receipt")) {
    history.replaceState(null, "", `#/receipt/${parts[1]}`);
    setTimeout(() => window.print(), 300);
  }
  window.scrollTo(0, keepScroll ? y : 0);
}
// On a phone the A4 sheet and the receipt are shrunk to the screen width; print and PDF use the real size
function fitPaper() {
  for (const el of $$(".sheet, .receipt")) {
    el.style.zoom = "";
    const room = document.documentElement.clientWidth - 16;
    el.style.zoom = el.offsetWidth > room ? (room / el.offsetWidth).toFixed(3) : "";
  }
}
window.addEventListener("resize", fitPaper);
function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }

// html2canvas draws every piece of text left to right, which in Arabic glues words together and moves
// full stops and list bullets to the wrong side. In the copy it draws, each run of Arabic letters, each
// piece of punctuation and each list marker gets its own element, so the browser's layout places them.
const ARABIC_RUN = /([\u0620-\u065F\u0670-\u06D3\u06D5\u06FA-\u06FF]+)/;
function prepareArabicForPdf(root) {
  const doc = root.ownerDocument;
  for (const list of root.querySelectorAll('[dir="rtl"] ul, [dir="rtl"] ol')) {
    list.style.listStyle = "none"; list.style.paddingInlineStart = "0";
    [...list.children].forEach((li, i) => { const m = doc.createElement("span"); m.textContent = list.tagName === "OL" ? `${i + 1}.` : "•"; li.prepend(m, " "); });
  }
  const walk = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT); const found = [];
  while (walk.nextNode()) if (ARABIC_RUN.test(walk.currentNode.nodeValue)) found.push(walk.currentNode);
  for (const node of found) {
    const parts = node.nodeValue.split(/(\s+)/).flatMap((w) => (/^\s+$/.test(w) ? [w] : w.split(ARABIC_RUN))).filter(Boolean);
    node.replaceWith(...parts.map((w) => { if (/^\s+$/.test(w)) return w; const el = doc.createElement("span"); el.textContent = w; return el; }));
  }
}

// ------------------------------------------------------------ events
const actions = {
  lang() { LANG = LANG === "ar" ? "en" : "ar"; local.set("lang", LANG); store?.user ? render(true) : renderLogin(); },
  async signOut() { await saveReport(true); unsubs.forEach((u) => u()); unsubs = []; store.signOut(); },
  async resetPassword() {
    try { await store.resetPassword(store.user.email); toast(T("A link to change the password was sent to %(email)s.", { email: store.user.email })); }
    catch (err) { toast(T("Not saved: %(error)s", { error: err.code || err.message })); }
  },
  printNow() { window.print(); },
  printReport(btn) {
    const e = examById(btn.dataset.id);
    updateExam(e.id, { printCount: (e.printCount || 0) + 1, printedAt: nowIso(), status: "printed" }).catch(console.error);
    learnReport(e).catch(console.error);
    window.print();
  },
  async savePdf(btn) {
    const sheet = $(".sheet"); if (!sheet || !window.html2pdf) return;
    const e = examById(btn.dataset.id);
    const name = `${(e.patientName || "report").replace(/[^\p{L}\p{N}]+/gu, "_")}_${e.id}.pdf`;
    btn.disabled = true; toast(T("Making the PDF…"));
    // html2canvas offsets the capture in right-to-left pages, so the page is left-to-right while it draws
    const dir = document.documentElement.dir; const y = window.scrollY;
    document.documentElement.dir = "ltr"; document.documentElement.classList.add("pdf-capture"); window.scrollTo(0, 0);
    try {
      await window.html2pdf().set({
        margin: 0, filename: name, image: { type: "jpeg", quality: 0.95 },
        html2canvas: { scale: 2, useCORS: true, scrollX: 0, scrollY: 0, onclone: (doc) => doc.querySelectorAll(".sheet").forEach(prepareArabicForPdf) },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" }, pagebreak: { mode: ["css", "legacy"] },
      }).from(sheet).save();
    } finally {
      document.documentElement.dir = dir; document.documentElement.classList.remove("pdf-capture"); window.scrollTo(0, y); btn.disabled = false;
    }
  },
  csv(btn) { downloadCsv(btn.dataset.from, btn.dataset.to); },
  async cancelExam(btn) {
    const e = examById(btn.dataset.id); const paid = paidFor(e);
    if (!confirm(paid ? T("Cancel this exam? The %(amount)s IQD paid will be recorded as given back to the patient.", { amount: iqd(paid) }) : T("Cancel this exam? It stays in the search, marked cancelled."))) return;
    if (paid > 0) await addPayment(e, -paid, "refund", T("Exam cancelled"), { status: "cancelled" });
    else await updateExam(e.id, { status: "cancelled" });
    toast(T("The exam was cancelled. It stays in the search, marked cancelled.")); render(true);
  },
  saveDraft() { if (editing) { editing.dirty = true; saveReport(false); } },
  async sign(btn) {
    if (!isDoctor() || !editing) return;
    const e = examById(btn.dataset.id); const c = editorContent();
    if (!c.title && !c.body.trim()) { alert(T("Write the report before signing.")); return; }
    clearTimeout(autosaveTimer);
    const at = nowIso();
    btn.disabled = true;
    try {
      await updateExam(e.id, {
        report: { ...(e.report || {}), ...c, updatedAt: at, updatedBy: meName(), updatedByUid: uid(), signedBy: meName(), signedByUid: uid(), signedAt: at },
        status: "final",
      });
      editing = null; toast(T("Signed. The report is ready to print.")); go(`#/print/${e.id}`);
      learnReport(examById(e.id)).catch(console.error);
    } catch (err) {
      btn.disabled = false; toast(T("Not saved: %(error)s", { error: err.code || err.message }));
    }
  },
  async reopen(btn) {
    if (!confirm(T("Reopen this signed report to change it? It must be signed again."))) return;
    await updateExam(btn.dataset.id, { status: "draft", "report.signedAt": null, "report.signedBy": null, "report.signedByUid": null });
    toast(T("Reopened. Sign it again when you have finished the changes.")); render();
  },
  useTemplate(btn) {
    const t = byId(db.templates, btn.dataset.id); if (!t || !editing?.engine) return;
    if (($("#editor").value.trim() || $("#ed-imp").value.trim()) && !confirm(T("Replace the text you have written with this template?"))) return;
    $("#ed-title").value = t.title; $("#ed-imp").value = t.impression || ""; $("#ed-dir").value = t.direction || "ltr";
    $(".editor-wrap").dir = t.direction === "rtl" ? "rtl" : "ltr";
    editing.engine.setText(t.body || "");
    autosize(); markDirty(); $("#editor").focus();
  },
  snippet(btn) {
    if (!editing?.engine) return;
    const ta = $("#editor"); const before = ta.value.slice(0, ta.selectionStart);
    editing.engine.insert((before && !/\s$/.test(before) ? " " : "") + btn.dataset.text);
  },
  async saveAsTemplate() {
    const name = $("#tpl-name").value.trim(); if (!name) { alert(T("Give the template a name.")); return; }
    const e = examById(editing.id); const c = editorContent();
    const id = `t${Date.now().toString(36)}`;
    await store.setDoc("templates", id, { id, modality: e.modality, examTypeId: e.examTypeId, name, ...c, owner: uid() });
    toast(T("Saved as template “%(name)s”.", { name }));
    $("#tpl-name").value = "";
  },
  pickImage(btn) { const inp = $("#image-file"); inp.dataset.which = btn.dataset.which; inp.click(); },
  async resetImage(btn) { await store.setDoc("settings", "letterhead", { [btn.dataset.which]: null }, true); render(true); },
  pickLibrary() { $("#library-files").click(); },
  async deletePerson(btn) {
    if (btn.dataset.id === uid() || !confirm(T("Remove this person? Reports and payments keep their name."))) return;
    await store.deleteDoc("users", btn.dataset.id); go("#/settings?tab=people");
  },
  async deleteTemplate(btn) {
    if (!confirm(T("Delete this template?"))) return;
    const t = byId(db.templates, btn.dataset.id);
    await store.deleteDoc("templates", btn.dataset.id);
    toast(T("Template “%(name)s” removed.", { name: t?.name || "" })); go("#/settings?tab=templates");
  },
  regListPrice() { regRecalc(true); },
  usePatient(btn) { go(`#/register?patient=${btn.dataset.id}`); },
};
const changes = {
  goDay(el) { const q = new URLSearchParams(location.hash.split("?")[1] || ""); q.set("day", el.value || today()); go("#/?" + q); },
  cashDay(el) { go("#/cash?day=" + (el.value || today())); },
  filterStatus(el) { const q = new URLSearchParams(location.hash.split("?")[1] || ""); el.value ? q.set("status", el.value) : q.delete("status"); go("#/?" + q); },
  filterText(el) { const q = new URLSearchParams(location.hash.split("?")[1] || ""); el.value ? q.set("q", el.value) : q.delete("q"); go("#/?" + q); },
  regModality(el) { $("#r-type").innerHTML = examTypeOptions(el.value); regRecalc(true); },
  regExam() { regRecalc(true); },
  edDir(el) { $(".editor-wrap").dir = el.value === "rtl" ? "rtl" : "ltr"; markDirty(); },
};
let findTimer = null, findToken = 0;
const inputs = {
  regPrice() { regRecalc(); },
  regPaidTouched() { $("#register-form").dataset.paidTouched = "1"; regRecalc(); },
  regPriceTouched() { $("#register-form").dataset.priceTouched = "1"; regRecalc(); },
  dirty() { markDirty(); },
  // Recent exams are searched in memory (any part of the name); the patients collection by the start of the name, the phone or the ID
  findPatient(el) {
    const t = el.value.trim(); const lower = t.toLowerCase(); const box = $("#patient-matches");
    clearTimeout(findTimer);
    if (t.length < 2) { box.innerHTML = ""; return; }
    const token = ++findToken;
    const found = new Map();
    for (const e of db.exams.slice().sort(newestFirst)) {
      if (found.has(String(e.patientId))) continue;
      if ([e.patientName, e.phone, String(e.patientId)].some((v) => (v || "").toLowerCase().includes(lower))) found.set(String(e.patientId), { id: e.patientId, name: e.patientName, phone: e.phone, sex: e.sex });
    }
    const show = () => {
      const list = [...found.values()].slice(0, 8);
      list.forEach((p) => { if (!extra.patients.has(String(p.id))) extra.patients.set(String(p.id), p); });
      box.innerHTML = list.length ? `<div class="picker">${list.map((p) => {
        const last = db.exams.filter((e) => e.patientId === p.id).sort(newestFirst)[0];
        return `<button type="button" data-action="usePatient" data-id="${p.id}"><bdi class="strong">${esc(p.name)}</bdi> <span class="sub ltr">${esc(p.phone)}</span><div class="sub">${last ? esc(last.examName) + " · " + fmtDate(last.registeredAt) : ""}</div></button>`;
      }).join("")}</div>` : `<div class="sub">${T("No match: fill in a new patient below.")}</div>`;
    };
    show();
    findTimer = setTimeout(async () => {
      try {
        const asks = [store.getQuery("patients", { where: [["nameLower", ">=", lower], ["nameLower", "<=", lower + ""]], limit: 8 })];
        if (/^\d+$/.test(t)) asks.push(store.getQuery("patients", { where: [["phone", ">=", t], ["phone", "<=", t + ""]], limit: 8 }), store.getDoc("patients", t).then((p) => (p ? [p] : [])));
        const more = (await Promise.all(asks)).flat();
        if (token !== findToken) return;
        more.forEach((p) => { if (!found.has(String(p.id))) found.set(String(p.id), p); extra.patients.set(String(p.id), p); });
        show();
      } catch (err) { console.error(err); }
    }, 300);
  },
};
const submits = {
  async takePayment(f) {
    const e = examById(f.dataset.id); const a = Number(f.amount.value) || 0;
    if (a < 1 || a > due(e)) { alert(T("The amount paid is more than the %(amount)s IQD due.", { amount: iqd(due(e)) })); return; }
    const id = await addPayment(e, a, "payment"); go(`#/receipt/${id}?print=1`);
  },
  async refund(f) {
    const e = examById(f.dataset.id); const a = Number(f.amount.value) || 0;
    if (a < 1 || a > paidFor(e)) return;
    if (!f.note.value.trim()) { alert(T("Give a reason.")); return; }
    const id = await addPayment(e, -a, "refund", f.note.value.trim()); go(`#/receipt/${id}`);
  },
  async changeDiscount(f) {
    const e = examById(f.dataset.id); const d = Number(f.discount.value) || 0; const reason = f.reason.value.trim();
    const price = Math.max(0, Number(f.price.value) || 0);
    if (d > price) { alert(T("The discount is more than the price.")); return; }
    if (d > 0 && !reason) { alert(T("Give a reason for the discount.")); return; }
    if (price - d < paidFor(e)) { alert(T("More has already been paid than the new total. Record a refund first.")); return; }
    await updateExam(e.id, { price, discount: d, discountReason: d ? reason : "" }); toast(T("Price and discount saved.")); render(true);
  },
  async exam(f) {
    const e = examById(f.dataset.id); const name = f.name.value.trim().replace(/\s+/g, " ");
    if (!name) { alert(T("Enter the patient's name.")); return; }
    const patient = { name, nameLower: name.toLowerCase(), sex: f.sex.value, phone: f.phone.value.trim() };
    await updateExam(e.id, {
      patientName: name, patientNameLower: patient.nameLower, sex: patient.sex, phone: patient.phone,
      ageValue: Number(f.ageValue.value) || null, ageUnit: f.ageUnit.value, referringDoctor: f.referringDoctor.value.trim().replace(/\s+/g, " "),
      technician: f.technician.value.trim(), notes: f.notes.value.trim(),
    });
    await store.setDoc("patients", e.patientId, { ...patient, updatedAt: nowIso() }, true);
    extra.patients.delete(String(e.patientId));
    toast(T("Saved.")); render(true);
  },
  search(f) { const q = new URLSearchParams(); for (const k of ["q", "from", "to", "modality", "status", "doctor"]) if (f[k].value) q.set(k, f[k].value); go("#/search?" + q); },
  statsPeriod(f) { go(`#/stats?from=${f.from.value}&to=${f.to.value}`); },
  async saveClinic(f) {
    await store.setDoc("settings", "clinic", { nameEn: f.nameEn.value.trim() || "Radiology", nameAr: f.nameAr.value.trim(), sigTitle: f.sigTitle.value.trim(), sigName: f.sigName.value.trim(), sigDegrees: f.sigDegrees.value.trim(), titleColor: f.titleColor.value, receiptPaper: f.receiptPaper.value }, true);
    toast(T("Saved.")); render(true);
  },
  async savePerson(f) {
    const data = { name: f.name.value.trim(), role: f.role.value, sigTitle: f.sigTitle.value.trim(), sigName: f.sigName.value.trim(), sigDegrees: f.sigDegrees.value.trim() };
    if (!data.name) return;
    let id = f.dataset.id;
    try {
      if (!id) {
        const email = f.email.value.trim();
        id = await store.createAccount(email, f.password.value);
        data.email = email;
        toast(T("The account was created. Give the person their email and password."));
      } else toast(T("Saved."));
      await store.setDoc("users", id, data, true);
      go("#/settings?tab=people");
    } catch (err) {
      console.error(err);
      $("#person-error").textContent = T("Could not create the account: %(error)s", { error: err.code || err.message });
    }
  },
  async savePrices(f) {
    const items = db.examTypes.map((t) => ({ ...t, name: f[`name-${t.id}`].value.trim() || t.name, price: Math.max(0, Number(f[`price-${t.id}`].value) || 0), contrastPrice: Math.max(0, Number(f[`cprice-${t.id}`].value) || 0), active: f[`active-${t.id}`].checked }));
    const nn = f.newName.value.trim();
    if (nn) items.push({ id: Math.max(0, ...items.map((t) => t.id)) + 1, modality: f.newModality.value, name: nn, price: 0, contrastPrice: 0, active: true });
    await store.setDoc("settings", "examTypes", { items });
    toast(T("Saved.")); render(true);
  },
  async saveTemplate(f) {
    const data = { name: f.name.value.trim(), modality: f.modality.value, examTypeId: Number(f.examTypeId.value) || null, direction: f.direction.value, title: f.title.value.trim(), body: f.body.value.replace(/\s+$/, ""), impression: f.impression.value.trim() };
    if (!data.name) return;
    const id = f.dataset.id || `t${Date.now().toString(36)}`;
    await store.setDoc("templates", id, { ...data, id }, true);
    go("#/settings?tab=templates"); toast(T("Template saved."));
  },
  async saveSnippets(f) {
    const items = [];
    for (const m of [...Object.keys(MODALITIES), ""]) for (const line of f[`snip-${m}`].value.split("\n")) if (line.trim()) items.push({ modality: m, text: line.trim() });
    await store.setDoc("settings", "snippets", { items }); toast(T("Saved.")); render(true);
  },
};

document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-action]");
  if (el && actions[el.dataset.action]) { ev.preventDefault(); actions[el.dataset.action](el, ev); }
});
document.addEventListener("change", (ev) => { const el = ev.target.closest("[data-change]"); if (el && changes[el.dataset.change]) changes[el.dataset.change](el); });
document.addEventListener("input", (ev) => {
  const form = ev.target.closest?.("#root form");
  if (form && !form.dataset.submit?.match(/^(search|statsPeriod)$/)) form.setAttribute("data-dirty", "");
  const el = ev.target.closest?.("[data-input]"); if (el && inputs[el.dataset.input]) inputs[el.dataset.input](el);
});
document.addEventListener("submit", async (ev) => {
  const f = ev.target; ev.preventDefault();
  if (f.id === "login-form") {
    const btn = $("button[type=submit]", f); btn.disabled = true;
    try { await store.signIn($("#login-email").value.trim(), $("#login-password").value); }
    catch (err) { btn.disabled = false; $("#login-error").textContent = T("Could not sign in. Check the email and password."); }
    return;
  }
  if (f.id === "register-form") return submitRegister(f, ev.submitter?.value);
  const handler = f.id === "exam-form" ? submits.exam : submits[f.dataset.submit];
  if (!handler) return;
  try {
    await handler(f);
    f.removeAttribute("data-dirty");
  } catch (err) {
    console.error(err);
    toast(T("Not saved: %(error)s", { error: err.code || err.message }));
  }
});
document.addEventListener("keydown", (ev) => {
  // Ctrl+S saves the report draft instead of saving the web page
  if ((ev.ctrlKey || ev.metaKey) && ev.key === "s" && editing && !editing.ro) { ev.preventDefault(); editing.dirty = true; saveReport(false); }
});

$("#image-file").addEventListener("change", async (ev) => {
  const file = ev.target.files[0]; const which = ev.target.dataset.which; ev.target.value = ""; if (!file) return;
  try {
    const url = await shrinkImage(file, which === "header" ? 1400 : 1600);
    await store.setDoc("settings", "letterhead", { [which]: url }, true);
    toast(T("Saved.")); render(true);
  } catch (err) { console.error(err); toast(T("Not saved: %(error)s", { error: err.code || err.message })); }
});
// Letterhead images are kept in Firestore, so they are scaled down to stay well under the 1 MiB document limit
function shrinkImage(file, maxWidth) {
  return new Promise((ok, fail) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.width);
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      let q = 0.88, url = c.toDataURL("image/jpeg", q);
      while (url.length > 420000 && q > 0.5) { q -= 0.1; url = c.toDataURL("image/jpeg", q); }
      ok(url);
    };
    img.onerror = fail;
    img.src = URL.createObjectURL(file);
  });
}

$("#library-files").addEventListener("change", async (ev) => {
  const files = [...ev.target.files]; ev.target.value = "";
  const status = (t) => { const el = $("#library-status"); if (el) el.textContent = t; };
  const texts = {};
  for (const f of files) { const name = f.name.replace(/\.json$/, ""); if (LIBRARY_FILES.includes(name)) texts[name] = await f.text(); }
  const missing = LIBRARY_FILES.filter((n) => !texts[n]);
  if (missing.length) { status(T("Missing files: %(names)s", { names: missing.join(", ") })); return; }
  status(T("Uploading the library…"));
  try { await store.uploadLibrary(texts); status(T("The library was uploaded. Reload the page.")); }
  catch (err) { console.error(err); status(T("The library could not be uploaded.")); }
});

window.addEventListener("hashchange", () => { if (editing?.dirty) saveReport(true); render(); });
window.addEventListener("beforeunload", (e) => { if (editing?.dirty) { saveReport(true); e.preventDefault(); } });

// ------------------------------------------------------------ start
async function start() {
  store = await createStore();
  store.onAuth((user, err) => {
    unsubs.forEach((u) => u()); unsubs = [];
    if (!user) { editing = null; renderLogin(); return; }
    loadError = err ? (err.code === "permission-denied"
      ? T("The Firestore rules refuse access. Paste firestore.rules in the Firebase console and press Publish.")
      : T("Could not load the data: %(error)s", { error: err.code || err.message })) : "";
    // Without a role the rules refuse every read, so nothing is loaded until the admin sets one
    if (ROLES[user.role]) { startListeners(); loadLibrary(); }
    render();
  });
}
start().catch((err) => {
  console.error(err);
  const box = document.getElementById("fatal");
  if (box) {
    box.style.display = "block";
    box.textContent = "تعذّر تشغيل الموقع — صوّر هذه الشاشة وأرسلها:\n\n" + (err && (err.stack || err.message || err.code) || err);
  }
});
