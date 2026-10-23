// App wiring: login, reports list, autosave, approval and PDF export.
import { createStore, LIBRARY_FILES } from "./store.js";
import { createEditor, prepareLibrary, escapeHtml } from "./editor.js";
import { clinic } from "../firebase-config.js";

const $ = (id) => document.getElementById(id);
// Patient/exam fields filled at reception. The report text itself is written only by the doctor.
const FIELDS = {
  patientName: "f-patient", age: "f-age", sex: "f-sex", phone: "f-phone",
  examDate: "f-date", referringDoctor: "f-doctor", modality: "modality", region: "region",
  contrast: "f-contrast", price: "f-price", notes: "f-notes",
};
const STATUS_LABEL = { registered: "بانتظار التقرير", draft: "مسودة", approved: "معتمد" };
const SAVE_DELAY = 1200;

let store, editor;
let reports = [];
let filter = "all";
let current = blankReport();
let unwatchReport = null, unwatchList = null;
let saveTimer = null, saving = null, pendingRemote = null;
const ignored = new Set();

function blankReport() {
  return { id: null, status: "registered", dirty: false };
}

// Only the doctor (radiologist) writes and approves the report; reception and others fill patient data
const isRadiologist = () => store.user?.role === "radiologist";
const roleLabel = () => ({ radiologist: "طبيب أشعة", reception: "استقبال", admin: "مدير", staff: "موظف" }[store.user?.role] || "موظف");
const fmtDate = (d) => (d instanceof Date && !isNaN(d) ? d.toLocaleDateString("en-GB") : "");
const fmtDateTime = (d) => (d instanceof Date && !isNaN(d) ? d.toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }) : "");
const setStatus = (t) => { $("status").textContent = t; $("status").title = t; };
// First letters of the first two words, skipping titles and brackets: "Dr. Sara Ali" → "SA"
const initials = (name) => (name || "").split(/\s+/).filter((w) => !/^(dr|د)\.?$/i.test(w))
  .map((w) => w.match(/\p{L}/u)?.[0]).filter(Boolean).slice(0, 2).join("");
const SEX_LABEL = { Male: "ذكر", Female: "أنثى" };

document.querySelectorAll(".clinic-name").forEach((e) => (e.textContent = clinic.name));

// Phones show one column at a time: the patient list, or the open patient
const narrow = matchMedia("(max-width: 899px)");
const setView = (v) => { document.body.dataset.view = v; if (narrow.matches) window.scrollTo(0, 0); };
// Sentence suggestions sit beside the editor on wide screens and just above it on phones
function placeSuggestions() {
  const panel = $("sugg-panel");
  if (narrow.matches) $("sugg-slot").append(panel);
  else $("assist").prepend(panel);
}
narrow.addEventListener("change", placeSuggestions);
placeSuggestions();

async function start() {
  store = await createStore();
  store.onAuth(async (user) => {
    try {
      $("login-view").hidden = !!user;
      $("app-view").hidden = !user;
      if (unwatchList) { unwatchList(); unwatchList = null; }
      if (!user) return;
      document.body.dataset.role = user.role;
      $("who-name").textContent = user.name;
      $("who-role").textContent = roleLabel();
      $("who-avatar").textContent = initials(user.name);
      $("upload-library").hidden = !isRadiologist();
      if (store.mode === "demo") setStatus("وضع تجريبي: التقارير محفوظة بهذا المتصفح فقط");
      await setupEditor();
      unwatchList = store.watchReports((list) => { reports = list; renderList(); });
    } catch (err) {
      console.error(err);
      if (err.code === "permission-denied") {
        setStatus("قواعد Firestore ترفض القراءة. افتح Firestore ← Rules، الصق محتوى firestore.rules، واضغط Publish.");
      } else {
        setStatus(`خطأ: ${err.code || err.message}`);
      }
    }
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
    onInput: () => { autosize(); markDirty(); },
  });
  showReport(current);
}

function sumBy(titles, i) {
  const c = {};
  titles.forEach((t) => (c[t[i]] = (c[t[i]] || 0) + t[3]));
  return Object.entries(c).sort((a, b) => b[1] - a[1]);
}

function fillSelect(sel, entries) {
  // Ordered by how often the exam appears in the library
  sel.innerHTML = `<option value="">—</option>` +
    entries.map(([v]) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
}

// ---------- Reports list ----------

function isToday(d) {
  const n = new Date();
  return d instanceof Date && !isNaN(d) &&
    d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

const fmtWhen = (d) => (isToday(d)
  ? d.toLocaleTimeString("en-GB", { timeStyle: "short" })
  : fmtDate(d));

function renderList() {
  const counts = { all: reports.length, today: 0, registered: 0, draft: 0, approved: 0 };
  reports.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; if (isToday(r.createdAt)) counts.today++; });
  document.querySelectorAll(".chip").forEach((c) => (c.querySelector(".n").textContent = counts[c.dataset.filter] || ""));

  const q = $("search").value.trim().toLowerCase();
  const rows = reports.filter((r) =>
    (filter === "all" || (filter === "today" ? isToday(r.createdAt) : r.status === filter)) &&
    (!q || `${r.patientName || ""} ${r.referringDoctor || ""} ${r.text || ""}`.toLowerCase().includes(q)));
  $("reports").innerHTML = rows.length ? rows.map((r) => {
    const study = [r.modality, r.region].filter(Boolean).join(" · ") ||
      (r.text || "").split("\n")[0].trim() || "—";
    return `
    <li data-id="${r.id}" class="${r.id === current.id ? "active" : ""}">
      <div class="r-top"><b class="r-name" dir="auto">${escapeHtml(r.patientName || "(بدون اسم)")}</b>
        <span class="badge ${r.status}">${STATUS_LABEL[r.status] || r.status}</span></div>
      <div class="r-study" dir="ltr">${escapeHtml(study.slice(0, 70))}</div>
      <div class="r-meta">${fmtWhen(r.updatedAt)} · ${escapeHtml(r.updatedByName || "")}</div>
    </li>`;
  }).join("") : `<li class="empty">${reports.length ? "ماكو نتائج بهذا البحث" : "ماكو مرضى بعد. اضغط «مريض جديد» حتى تبدي."}</li>`;
}

$("reports").addEventListener("click", async (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li || li.dataset.id === current.id) return;
  await flushSave();
  const r = reports.find((x) => x.id === li.dataset.id);
  if (r) openReport(r);
  setView("case");
});
$("back").addEventListener("click", () => setView("list"));
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
  setView("case");
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
  editor?.setText(r.text || "");
  autosize();
  $("remote-banner").hidden = true;
  pendingRemote = null;
  // The doctor sees the patient summary in the header; reception works in the full form
  $("patient-card").open = !isRadiologist() || !r.id || !r.patientName;
  renderCaseHead();
  applyStatus(r);
}

// Header line: patient name, age/sex, study and referring doctor
function renderCaseHead() {
  const v = (id) => $(id).value.trim();
  const name = v("f-patient");
  $("case-title").textContent = name || (current.id ? "(بدون اسم)" : "مريض جديد");
  $("case-avatar").textContent = initials(name);
  const age = v("f-age") && `${v("f-age")} سنة`;
  const study = [v("modality"), v("region")].filter(Boolean).join(" ");
  const parts = [age, SEX_LABEL[v("f-sex")]].filter(Boolean).map(escapeHtml);
  if (study) parts.push(`<bdi dir="ltr">${escapeHtml(study)}</bdi>`);
  if (v("f-contrast") === "Contrast") parts.push("مع صبغة");
  if (v("f-doctor")) parts.push(`محوّل من <bdi>${escapeHtml(v("f-doctor"))}</bdi>`);
  $("case-meta").innerHTML = parts.map((x) => `<span class="m">${x}</span>`).join("");
}

// The report box grows with its text so the page scrolls, not the box
function autosize() {
  const e = $("editor"), wrap = e.parentElement;
  wrap.style.minHeight = `${e.offsetHeight}px`; // keep the page height while measuring, so it does not jump
  e.style.height = "auto";
  e.style.height = `${e.scrollHeight}px`;
  wrap.style.minHeight = "";
}
window.addEventListener("resize", autosize);

function applyStatus(r) {
  const approved = r.status === "approved";
  const canEditReport = !approved && isRadiologist();   // only the doctor writes the report
  const canEditFields = !approved;                       // reception and doctor edit patient data
  $("editor").readOnly = !canEditReport;
  $("editor").placeholder = canEditReport
    ? "Start typing the report… (Tab accepts the grey suggestion)"
    : approved ? "" : "بانتظار طبيب الأشعة لكتابة التقرير";
  document.body.dataset.writing = canEditReport ? "1" : "0";
  Object.values(FIELDS).forEach((id) => ($(id).disabled = !canEditFields));
  $("template").disabled = !canEditReport;
  $("report-hint").hidden = approved || isRadiologist(); // shown to reception/others
  $("badge").className = `badge ${r.status}`;
  // <bdi> keeps the English name and date from reordering the Arabic label
  $("badge").innerHTML = approved
    ? `معتمد · <bdi>${escapeHtml(r.approvedByName || "")}</bdi> · <bdi>${fmtDate(r.approvedAt)}</bdi>`
    : escapeHtml(STATUS_LABEL[r.status] || r.status);
  // Doctor can approve a report that has text; can re-open an approved one
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
  return { ...f, text: editor.getText() };
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
  saving = store.saveReport(current.id, fields).then(async (id) => {
    Object.assign(current, fields, { id });
    // Once the doctor has written report text, move it from "awaiting report" to "draft"
    if (current.status === "registered" && isRadiologist() && fields.text.trim()) {
      await store.setStatus(id, "draft");
      current.status = "draft";
      applyStatus(current);
    }
    $("save-state").textContent = `محفوظ ${new Date().toLocaleTimeString("en-GB", { timeStyle: "short" })}`;
    if (wasNew) unwatchReport = store.watchReport(id, onRemoteChange);
    renderList();
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

Object.values(FIELDS).forEach((id) => {
  $(id).addEventListener("input", markDirty);
  $(id).addEventListener("change", markDirty); // selects fire change, not input
  $(id).addEventListener("input", renderCaseHead);
  $(id).addEventListener("change", renderCaseHead);
});
window.addEventListener("beforeunload", (e) => { if (current.dirty) { save(); e.preventDefault(); } });

$("template").addEventListener("click", () => {
  if (editor.getText().trim() && !confirmTwice($("template"))) return;
  editor.template();
});

// Second click within 3 s confirms (no browser dialogs)
function confirmTwice(btn) {
  if (Date.now() - (+btn.dataset.armed || 0) < 3000) return true;
  btn.dataset.armed = Date.now();
  const label = btn.innerHTML; // keeps the button icon
  btn.textContent = "اضغط مرة ثانية للتأكيد";
  setTimeout(() => (btn.innerHTML = label), 3000);
  return false;
}

// ---------- Approval ----------

$("approve").addEventListener("click", async () => {
  if (!editor.getText().trim()) { setStatus("ماكو نص تقرير حتى يتعتمد"); return; }
  if (!confirmTwice($("approve"))) return;
  current.dirty = true;
  await save();
  if (!current.id) return;
  await store.setStatus(current.id, "approved");
  Object.assign(current, { status: "approved", approvedByName: store.user.name, approvedAt: new Date() });
  applyStatus(current);
  renderList();
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
        <tr><th>Age / Sex</th><td>${escapeHtml([f.age, f.sex].filter(Boolean).join(" / "))}</td><th>Phone</th><td>${escapeHtml(f.phone)}</td></tr>
        <tr><th>Referred by</th><td>${escapeHtml(f.referringDoctor)}</td><th>Study</th><td>${escapeHtml([f.modality, f.contrast === "Contrast" ? "with contrast" : f.contrast === "Native" ? "non-contrast" : ""].filter(Boolean).join(", "))}</td></tr>
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

start().catch((err) => {
  console.error(err);
  const box = document.getElementById("fatal");
  if (box) {
    box.style.display = "block";
    box.textContent = "تعذّر تشغيل الموقع — صوّر هذه الشاشة وأرسلها:\n\n" +
      (err && (err.stack || err.message || err.code) || err);
  }
});
