// Report editor: grey next-word / next-sentence suggestions from the report library, plus spelling help.

const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").replace(/\s+([.,;:])/g, "$1");
const sentenceKey = (s) => norm(s).trim().replace(/\.$/, "");
export const escapeHtml = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Library sentences are shown with their known misspellings already corrected
export function prepareLibrary(lib) {
  // Also puts back the space lost after a full stop in old reports ("normal.No evidence")
  const fix = (t) => t.replace(/[A-Za-z][A-Za-z'\-]*/g, (w) => {
    const c = lib.typos[w.toLowerCase()];
    return c ? (w === w.toUpperCase() ? c.suggest.toUpperCase() : c.suggest) : w;
  }).replace(/([a-z]{2})\.([A-Z][a-z])/g, "$1. $2");
  lib.phrases.forEach((p) => (p.text = fix(p.text)));
  Object.values(lib.next).forEach((list) => list.forEach((n) => (n[0] = fix(n[0]))));
  lib.titles = lib.titles.map(([t, m, g, n]) => [fix(t), m, g, n]);
  return lib;
}

export function createEditor({ lib, editor, mirror, suggList, spellList, modalitySel, regionSel, ignored, onIgnore, onInput }) {
  let ghost = "";       // grey text shown after the caret
  let listItems = [];   // sentence suggestions currently in the side list

  function weight(p) {
    const m = modalitySel.value, r = regionSel.value;
    let w = p.count;
    if (m) w = (p.modalities[m] || 0) * 4 + p.count * 0.25;
    if (r) w *= (p.regions[r] ? 1 + (4 * p.regions[r]) / p.count : 0.2);
    return w;
  }

  function context() {
    const pos = editor.selectionStart;
    const before = editor.value.slice(0, pos);
    const after = editor.value.slice(pos);
    const lineStart = before.lastIndexOf("\n") + 1;
    const line = before.slice(lineStart);
    // Current sentence = text after the last sentence end on this line
    const m = line.match(/^(.*[.;]\s+)?(.*)$/);
    const current = m[2];
    const prevText = (m[1] || "").trim() || lastSentenceBefore(before.slice(0, lineStart));
    return { pos, before, after, current, prevText };
  }

  function lastSentenceBefore(text) {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return "";
    const parts = lines[lines.length - 1].split(/(?<=[.;])\s+/);
    return parts[parts.length - 1];
  }

  // Sentences that start with what is typed, or (on an empty sentence) usually follow the previous one.
  function sentenceSuggestions(ctx) {
    const typed = norm(ctx.current).trimStart();
    if (typed.length >= 2) {
      return lib.phrases
        .filter((p) => norm(p.text).startsWith(typed) && norm(p.text) !== typed)
        .map((p) => ({ text: p.text, score: weight(p) }))
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .filter((s, i, all) => all.findIndex((o) => o.text === s.text) === i)
        .slice(0, 8);
    }
    if (typed.length === 0) {
      const follow = lib.next[sentenceKey(ctx.prevText)];
      if (follow) return follow.map(([text, n]) => ({ text, score: n }));
    }
    return [];
  }

  // Next-word guess from the two previous words; completes a half-typed word from the vocabulary.
  function wordSuggestion(ctx) {
    const words = (ctx.current.toLowerCase().match(/[a-z][a-z'\-]*/g) || []);
    const midWord = /[a-z'\-]$/i.test(ctx.current);
    if (midWord) {
      const part = words.pop() || "";
      if (part.length < 2) return "";
      const key = (words.length >= 2 ? words.slice(-2) : ["<s>", ...words].slice(-2)).join(" ");
      const nexts = (lib.ngrams[key] || []).map(([w]) => w);
      const fromModel = nexts.find((w) => w.startsWith(part) && w !== part);
      if (fromModel) return fromModel.slice(part.length);
      for (const w in lib.vocab) if (w.length > part.length && w.startsWith(part)) return w.slice(part.length);
      return "";
    }
    if (!/\s$/.test(ctx.current) || !words.length) return "";
    const key = ["<s>", "<s>", ...words].slice(-2).join(" ");
    const best = (lib.ngrams[key] || [])[0];
    return best ? best[0] : "";
  }

  function refresh() {
    const ctx = context();
    const sents = editor.readOnly ? [] : sentenceSuggestions(ctx);
    listItems = sents;
    ghost = "";
    const atLineEnd = ctx.after === "" || ctx.after.startsWith("\n");
    if (!editor.readOnly && atLineEnd && editor.selectionStart === editor.selectionEnd) {
      if (sents.length) {
        const typed = ctx.current.trimStart();
        ghost = sents[0].text.slice(typed.length);
        if (!typed && ctx.before && !/\s$/.test(ctx.before)) ghost = " " + ghost;
      } else {
        ghost = wordSuggestion(ctx);
      }
    }
    renderMirror(ctx);
    renderSuggestions();
    renderSpelling();
  }

  function renderMirror(ctx) {
    mirror.innerHTML = escapeHtml(ctx.before) +
      (ghost ? `<span class="ghost">${escapeHtml(ghost)}</span>` : "") +
      escapeHtml(ctx.after) + "\n";
    mirror.scrollTop = editor.scrollTop;
  }

  function renderSuggestions() {
    if (!listItems.length) {
      suggList.innerHTML = `<li class="empty" dir="auto">${editor.value.trim()
        ? "Type the start of a sentence, or finish one with a full stop."
        : "اختار نوع الفحص واضغط «ابدأ بقالب»."}</li>`;
      return;
    }
    suggList.innerHTML = listItems
      .map((s, i) => `<li data-i="${i}">${escapeHtml(s.text)}<span class="count">${Math.round(s.score)}</span></li>`)
      .join("");
  }

  function renderSpelling() {
    const seen = new Map();
    for (const w of editor.value.match(/[A-Za-z][A-Za-z'\-]*/g) || []) {
      const lw = w.toLowerCase();
      if (seen.has(lw) || ignored.has(lw)) continue;
      if (lib.typos[lw]) seen.set(lw, { word: w, fix: lib.typos[lw].suggest });
      else if (lw.length > 3 && !(lw in lib.vocab)) seen.set(lw, { word: w, fix: closestWord(lw) });
    }
    const rows = [...seen.values()];
    if (!rows.length) {
      spellList.innerHTML = `<li class="empty" dir="auto">No spelling issues found.</li>`;
      return;
    }
    const ignoreBtn = (r) => `<button type="button" class="mini" data-ignore="${escapeHtml(r.word.toLowerCase())}" title="الكلمة صحيحة، لا تنبهني عليها">صحيحة</button>`;
    spellList.innerHTML = rows.map((r) => r.fix
      ? `<li class="typo" data-word="${escapeHtml(r.word)}" data-fix="${escapeHtml(r.fix)}"><span><b>${escapeHtml(r.word)}</b> → ${escapeHtml(r.fix)}</span>${ignoreBtn(r)}</li>`
      : `<li class="empty" dir="auto"><span><b>${escapeHtml(r.word)}</b> — not in the library</span>${ignoreBtn(r)}</li>`).join("");
  }

  // Most frequent library word within two edits of an unknown word
  function closestWord(w) {
    let best = null, bestScore = -1;
    for (const [v, n] of Object.entries(lib.vocab)) {
      if (n < 3 || Math.abs(v.length - w.length) > 2) continue;
      const d = editDistance(w, v, 2);
      if (d <= 2 && n / d > bestScore) { best = v; bestScore = n / d; }
    }
    return best;
  }

  function editDistance(a, b, max) {
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let rowMin = i;
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        rowMin = Math.min(rowMin, cur[j]);
      }
      if (rowMin > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }

  function changed() {
    refresh();
    onInput();
  }

  function insertAtCaret(text) {
    const { selectionStart: s, selectionEnd: e, value } = editor;
    editor.value = value.slice(0, s) + text + value.slice(e);
    editor.selectionStart = editor.selectionEnd = s + text.length;
    editor.focus();
    changed();
  }

  function acceptSentence(text) {
    const ctx = context();
    const typed = ctx.current.trimStart();
    const lead = !typed && ctx.before && !/\s$/.test(ctx.before) ? " " : "";
    const matches = norm(text).startsWith(norm(typed));
    // A sentence that does not continue the typed text replaces it
    if (!matches) editor.selectionStart = ctx.pos - ctx.current.length;
    insertAtCaret(lead + (matches ? text.slice(typed.length) : text) + " ");
  }

  editor.addEventListener("input", changed);
  editor.addEventListener("click", refresh);
  editor.addEventListener("keyup", (e) => { if (e.key.startsWith("Arrow")) refresh(); });
  editor.addEventListener("scroll", () => (mirror.scrollTop = editor.scrollTop));
  editor.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && ghost) {
      e.preventDefault();
      insertAtCaret(ghost + (listItems.length ? " " : ""));
    } else if (e.key === "Escape" && ghost) {
      ghost = "";
      renderMirror(context());
    }
  });

  suggList.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-i]");
    if (li && !editor.readOnly) acceptSentence(listItems[+li.dataset.i].text);
  });

  spellList.addEventListener("click", (e) => {
    const ign = e.target.closest("button[data-ignore]");
    if (ign) {
      onIgnore(ign.dataset.ignore);
      refresh();
      return;
    }
    const li = e.target.closest("li[data-fix]");
    if (!li || editor.readOnly) return;
    const re = new RegExp(`\\b${li.dataset.word.replace(/[-']/g, "\\$&")}\\b`, "gi");
    editor.value = editor.value.replace(re, li.dataset.fix);
    changed();
  });

  modalitySel.addEventListener("change", refresh);
  regionSel.addEventListener("change", refresh);

  // The most common exam title for the chosen type and region, plus the standard sections
  function template() {
    const m = modalitySel.value, r = regionSel.value;
    const t = lib.titles.find(([, tm, tr]) => (!m || tm === m) && (!r || tr === r));
    const head = `${t ? t[0] : "EXAMINATION:"}\n\nCLINICAL INFORMATION:\n\nFINDINGS:\n`;
    editor.value = head + `\n\nIMPRESSION:\n\nRECOMMENDATIONS:\nClinical correlation is advised.\n`;
    editor.selectionStart = editor.selectionEnd = head.length;
    editor.focus();
    changed();
  }

  return {
    refresh,
    template,
    insert: insertAtCaret,
    getText: () => editor.value,
    setText(text) {
      editor.value = text || "";
      refresh();
    },
  };
}
