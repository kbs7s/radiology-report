// App wiring: login, reports list, autosave, approval and PDF export.
import { createStore, LIBRARY_FILES } from "./store.js";
import { createEditor, prepareLibrary, escapeHtml } from "./editor.js";
import { clinic } from "../firebase-config.js";

const $ = (id) => document.getElementById(id);
const FIELDS = { patientName: "f-patient", age: "f-age", sex: "f-sex", examDate: "f-date", referringDoctor: "f-doctor" };
const SAVE_DELAY = 1200;

let store, editor;
let reports = [];
let filter = "all";
let current = blankReport();
let unwatchReport = null, unwatchList = null;
let saveTimer = null, saving = null, pendingRemote = null;
const ignored = new Set();

function blankReport() {
  return { id: null, status: "draft", dirty: false };
}

const isRadiologist = () => store.user?.role === "radiologist";
const fmtDate = (d) => (d instanceof Date && !isNaN(d) ? d.toLocaleDateString("en-GB") : "");
const fmtDateTime = (d) => (d instanceof Date && !isNaN(d) ? d.toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }) : "");
const setStatus = (t) => ($("status").textContent = t);

async function start() {
  store = await createStore();
  store.onAuth(async (user) => {
    $("login-view").hidden = !!user;
    $("app-view").hidden = !user;
    if (unwatchList) { unwatchList(); unwatchList = null; }
    if (!user) return;
    $("who").textContent = `${user.name}${user.role === "radiologist" ? " · أخصائي" : ""}`;
    $("upload-library").hidden = !isRadiologist();
    if (store.mode === "demo") setStatus("وضع تجريبي: التقارير محفوظة بهذا المتصفح فقط");
    await setupEditor();
    unwatchList = store.watchReports((list) => { reports = list; renderList(); });
  });
}

async function setupEditor() {
  if (editor) return;
  (await store.loadDictionary()).forEach((w) => ignored.add(w));
  let lib = await store.loadLibrary();
  if (!lib) {
    setStatus(isRadiologist() ? "المكتبة غير مرفوعة بعد: اضغط «رفع المكتبة» واختار ملفات data" : "المكتبة غير مرفوعة بعد");
    lib = { phrases: [], next: {}, ngrams: {}, vocab: {}, typos: {}, titles: [] };
  } else if (store.mode !== "demo") {
    setStatus(`المكتبة: ${lib.phrases.length} جملة`);
  }
  prepareLibrary(lib);
  fillSelect($("modality"), sumBy(lib.titles, 1));
  fillSelect($("region"), sumBy(lib.titles, 2));
  editor = createEditor({
    lib,
    editor: $("editor"), mirror: $("mirror"), suggList: $("suggestions"), spellList: $("spelling"),
    modalitySel: $("modality"), regionSel: $("region"),
    ignored,
    onIgnore: (w) => { ignored.add(w); store.addWord(w); },
    onInput: markDirty,
  });
  showReport(current);
}

function sumBy(titles, i) {
  const c = {};
  titles.forEach((t) => (c[t[i]] = (c[t[i]] || 0) + t[3]));
  return Object.entries(c).sort((a, b) => b[1] - a[1]);
}

function fillSelect(sel, entries) {
  sel.innerHTML = `<option value="">الكل</option>` +
    entries.map(([v, n]) => `<option value="${escapeHtml(v)}">${escapeHtml(v)} (${n})</option>`).join("");
}

// ---------- Reports list ----------

function renderList() {
  const q = $("search").value.trim().toLowerCase();
  const rows = reports.filter((r) => (filter === "all" || r.status === filter) &&
    (!q || `${r.patientName || ""} ${r.text || ""}`.toLowerCase().includes(q)));
  $("reports").innerHTML = rows.length ? rows.map((r) => `
    <li data-id="${r.id}" class="${r.id === current.id ? "active" : ""}">
      <div class="r-top"><b>${escapeHtml(r.patientName || "(بدون اسم)")}</b>
        <span class="badge ${r.status}">${r.status === "approved" ? "معتمد" : "مسودة"}</span></div>
      <div class="r-title" dir="ltr">${escapeHtml((r.text || "").split("\n")[0].slice(0, 70))}</div>
      <div class="r-meta">${fmtDateTime(r.updatedAt)} · ${escapeHtml(r.updatedByName || "")}</div>
    </li>`).join("") : `<li class="empty">ماكو تقارير</li>`;
}

$("reports").addEventListener("click", async (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li || li.dataset.id === current.id) return;
  await flushSave();
  const r = reports.find((x) => x.id === li.dataset.id);
  if (r) openReport(r);
});
$("search").addEventListener("input", renderList);
document.querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".chip").forEach((x) => x.classList.toggle("active", x === b));
  filter = b.dataset.filter;
  renderList();
}));

$("new-report").addEventListener("click", async () => {
  await flushSave();
  if (unwatchReport) { unwatchReport(); unwatchReport = null; }
  current = blankReport();
  showReport(current);
  $("f-date").value = new Date().toISOString().slice(0, 10);
  renderList();
  $("f-patient").focus();
});

// ---------- Open / show a report ----------

function openReport(r) {
  if (unwatchReport) unwatchReport();
  current = { ...r, dirty: false };
  showReport(current);
  renderList();
  unwatchReport = store.watchReport(r.id, onRemoteChange);
}

function showReport(r) {
  for (const [k, id] of Object.entries(FIELDS)) $(id).value = r[k] || "";
  $("modality").value = r.modality || "";
  $("region").value = r.region || "";
  editor?.setText(r.text || "");
  $("remote-banner").hidden = true;
  pendingRemote = null;
  applyStatus(r);
}

function applyStatus(r) {
  const approved = r.status === "approved";
  const locked = approved;
  $("editor").readOnly = locked;
  Object.values(FIELDS).forEach((id) => ($(id).disabled = locked));
  $("template").disabled = locked;
  $("badge").className = `badge ${r.status}`;
  $("badge").textContent = approved ? `معتمد · ${r.approvedByName || ""} · ${fmtDate(r.approvedAt)}` : "مسودة";
  $("approve").hidden = approved || !isRadiologist();
  $("reopen").hidden = !approved || !isRadiologist();
  editor?.refresh();
}

// Another user (or tab) changed the open report
function onRemoteChange(r) {
  const statusChanged = r.status !== current.status;
  if (statusChanged) {
    Object.assign(current, { status: r.status, approvedByName: r.approvedByName, approvedAt: r.approvedAt });
    applyStatus(current);
  }
  if (r.updatedBy === store.user.uid) return;
  const differs = r.text !== current.text || Object.keys(FIELDS).some((k) => (r[k] || "") !== (current[k] || ""));
  if (!differs) return;
  if (!current.dirty) {
    const keepCaret = $("editor").selectionStart;
    current = { ...r, dirty: false };
    showReport(current);
    $("editor").selectionStart = $("editor").selectionEnd = Math.min(keepCaret, current.text?.length || 0);
    $("save-state").textContent = `حدّثه ${r.updatedByName || "مستخدم آخر"}`;
  } else {
    pendingRemote = r;
    $("remote-text").textContent = `${r.updatedByName || "مستخدم آخر"} عدّل هذا التقرير هسه.`;
    $("remote-banner").hidden = false;
  }
}

$("remote-load").addEventListener("click", () => {
  if (!pendingRemote) return;
  clearTimeout(saveTimer);
  current = { ...pendingRemote, dirty: false };
  showReport(current);
});

// ---------- Autosave ----------

function collect() {
  const f = Object.fromEntries(Object.entries(FIELDS).map(([k, id]) => [k, $(id).value.trim()]));
  return { ...f, modality: $("modality").value, region: $("region").value, text: editor.getText() };
}

function markDirty() {
  if (current.status === "approved") return;
  current.dirty = true;
  $("save-state").textContent = "تعديلات غير محفوظة…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_DELAY);
}

async function save() {
  clearTimeout(saveTimer);
  if (!current.dirty) return;
  const fields = collect();
  if (!current.id && !fields.text.trim() && !fields.patientName) return;
  current.dirty = false;
  $("save-state").textContent = "جارٍ الحفظ…";
  const wasNew = !current.id;
  saving = store.saveReport(current.id, fields).then((id) => {
    Object.assign(current, fields, { id });
    $("save-state").textContent = `محفوظ ${new Date().toLocaleTimeString("en-GB", { timeStyle: "short" })}`;
    if (wasNew) {
      unwatchReport = store.watchReport(id, onRemoteChange);
      renderList();
    }
  }).catch((err) => {
    current.dirty = true;
    $("save-state").textContent = "فشل الحفظ، راح أعيد المحاولة";
    console.error(err);
    saveTimer = setTimeout(save, 5000);
  });
  await saving;
}

async function flushSave() {
  if (current.dirty) await save();
  else if (saving) await saving;
}

Object.values(FIELDS).forEach((id) => $(id).addEventListener("input", markDirty));
$("modality").addEventListener("change", markDirty);
$("region").addEventListener("change", markDirty);
window.addEventListener("beforeunload", (e) => { if (current.dirty) { save(); e.preventDefault(); } });

$("template").addEventListener("click", () => {
  if (editor.getText().trim() && !confirmTwice($("template"))) return;
  editor.template();
});

// Second click within 3 s confirms (no browser dialogs)
function confirmTwice(btn) {
  if (Date.now() - (+btn.dataset.armed || 0) < 3000) return true;
  btn.dataset.armed = Date.now();
  const label = btn.textContent;
  btn.textContent = "اضغط مرة ثانية للتأكيد";
  setTimeout(() => (btn.textContent = label), 3000);
  return false;
}

// ---------- Approval ----------

$("approve").addEventListener("click", async () => {
  if (!confirmTwice($("approve"))) return;
  current.dirty = true;
  await save();
  if (!current.id) return;
  await store.setStatus(current.id, "approved");
  Object.assign(current, { status: "approved", approvedByName: store.user.name, approvedAt: new Date() });
  applyStatus(current);
});

$("reopen").addEventListener("click", async () => {
  if (!confirmTwice($("reopen"))) return;
  await store.setStatus(current.id, "draft");
  current.status = "draft";
  applyStatus(current);
});

// ---------- PDF ----------

const HEADING = /^(EXAMINATION|EXAM|CLINICAL INFORMATION|CLINICAL DATA|TECHNIQUE|FINDINGS|IMPRESSION|CONCLUSION|RECOMMENDATIONS?|COMPARISON)\b\s*:?/i;

function reportHtml(text) {
  let titled = false;
  return text.split("\n").map((line) => {
    // The first line is the exam title, unless it is already a labelled heading
    if (!titled && line.trim() && !/^(CLINICAL|FINDINGS|IMPRESSION)/i.test(line)) {
      titled = true;
      return `<p class="title">${escapeHtml(line.replace(/^(EXAMINATION|EXAM)\s*:?\s*/i, ""))}</p>`;
    }
    titled = titled || !!line.trim();
    const m = line.match(HEADING);
    if (!m) return line.trim() ? `<p>${escapeHtml(line)}</p>` : `<div class="gap"></div>`;
    const rest = line.slice(m[0].length).trim();
    return `<p><b class="h">${escapeHtml(m[0].replace(/\s*:?\s*$/, ""))}:</b> ${escapeHtml(rest)}</p>`;
  }).join("");
}

$("pdf").addEventListener("click", async () => {
  await flushSave();
  const f = collect();
  const approved = current.status === "approved";
  const host = $("pdf-host");
  host.innerHTML = `
    <div class="sheet" dir="ltr">
      <header><div class="clinic">${escapeHtml(clinic.name)}</div><div class="sub">${escapeHtml(clinic.subtitle)}</div></header>
      <table class="pt">
        <tr><th>Patient</th><td>${escapeHtml(f.patientName)}</td><th>Date</th><td>${escapeHtml(f.examDate)}</td></tr>
        <tr><th>Age / Sex</th><td>${escapeHtml([f.age, f.sex].filter(Boolean).join(" / "))}</td><th>Referred by</th><td>${escapeHtml(f.referringDoctor)}</td></tr>
      </table>
      <div class="body">${reportHtml(f.text)}</div>
      <footer>${approved
        ? `Reported and approved by <b>${escapeHtml(current.approvedByName || "")}</b> · ${fmtDate(current.approvedAt)}`
        : `<span class="draft">DRAFT — not yet approved by the radiologist</span>`}</footer>
    </div>`;
  const name = `${(f.patientName || "report").replace(/[^\p{L}\p{N}]+/gu, "_")}_${f.examDate || "undated"}.pdf`;
  $("pdf").disabled = true;
  // html2canvas offsets the capture in right-to-left pages, so render the sheet while the page is LTR
  document.documentElement.dir = "ltr";
  const scrollY = window.scrollY;
  window.scrollTo(0, 0); // html2canvas captures relative to the current scroll position
  try {
    await window.html2pdf().set({
      margin: [10, 10, 12, 10],
      filename: name,
      image: { type: "jpeg", quality: 0.96 },
      html2canvas: { scale: 2, useCORS: true, scrollX: 0, scrollY: 0 },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
      pagebreak: { mode: ["css", "legacy"] },
    }).from(host.firstElementChild).save();
  } finally {
    document.documentElement.dir = "rtl";
    window.scrollTo(0, scrollY);
    $("pdf").disabled = false;
    host.innerHTML = "";
  }
});

// ---------- Login / library upload ----------

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("login-error").textContent = "";
  try {
    await store.signIn($("login-email").value.trim(), $("login-password").value);
  } catch (err) {
    $("login-error").textContent = "البريد أو كلمة السر غير صحيحة";
  }
});
$("signout").addEventListener("click", async () => { await flushSave(); store.signOut(); });

$("library-files").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  const texts = {};
  for (const f of files) {
    const name = f.name.replace(/\.json$/, "");
    if (LIBRARY_FILES.includes(name)) texts[name] = await f.text();
  }
  const missing = LIBRARY_FILES.filter((n) => !texts[n]);
  if (missing.length) { setStatus(`ناقص ملفات: ${missing.join(", ")}`); return; }
  setStatus("جارٍ رفع المكتبة…");
  try {
    await store.uploadLibrary(texts);
    setStatus("تم رفع المكتبة، حدّث الصفحة");
  } catch (err) {
    setStatus("فشل رفع المكتبة");
    console.error(err);
  }
});

start().catch((err) => { setStatus("تعذّر تشغيل الموقع"); console.error(err); });
