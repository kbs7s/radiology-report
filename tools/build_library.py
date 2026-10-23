"""Turn the Excel report library into JSON data for the report editor.

Outputs (in OUT dir):
  reports.json   every report: id, month column, modality, region, title, text
  phrases.json   unique sentences with frequency, grouped by modality
  ngrams.json    next-word model: "w1 w2" -> [[next, count], ...]
  vocab.json     word -> frequency (words seen in the library)
  typos.json     suspected misspellings -> suggested correction
"""
import html, json, re, sys
from collections import Counter, defaultdict
import openpyxl
from spellchecker import SpellChecker

SRC, OUT = sys.argv[1], sys.argv[2]

MODALITIES = [
    ("HRCT", r"\bHRCT\b"),
    ("FLUORO", r"HSG|HYSTEROSALPING|FISTULOGRAM|URETHROGRAM|BARIUM"),
    ("CT", r"(?<![A-Z])CT\b|\bCTA\b|COMPUTED TOMOGRAPHY|\bKUB\b(?!.*\bUS\b)"),
    ("MRI", r"(?<![A-Z])MRI\b|EXAMINATIONMRI|\bMR\b|\bMRCP\b|\bMRA\b|\bMRV\b|MAGNETIC"),
    ("US", r"\bUS\b|ULTRASOUND|SONO|DOPPLER|\bU/S\b"),
    ("X-RAY", r"X-?RAY|RADIOGRAPH|\bCXR\b"),
    ("MAMMO", r"MAMMO"),
]
REGIONS = [
    ("Brain", r"BRAIN|HEAD|SKULL|PITUITARY|ORBIT"),
    ("Spine", r"SPINE|LUMB|CERVICAL|DORSAL|THORACIC SPINE|SACR|MYELO|MEYLO"),
    ("Chest", r"CHEST|LUNG|THORAX"),
    ("Abdomen/Pelvis", r"ABDOM|PELVI|KUB|KIDNEY|LIVER|UROGRA|MRCP|UTER|PROSTAT"),
    ("Knee", r"KNEE"),
    ("Shoulder", r"SHOULDER"),
    ("Hip", r"\bHIP"),
    ("Ankle/Foot", r"ANKLE|FOOT"),
    ("Wrist/Hand", r"WRIST|HAND"),
    ("Elbow", r"ELBOW"),
    ("Neck", r"NECK|THYROID|PAROTID"),
    ("Breast", r"BREAST|MAMMO"),
]


def classify(head, table):
    h = head.upper()
    for name, pat in table:
        if re.search(pat, h):
            return name
    return "Other"


def clean(text):
    text = str(text).replace("\r", "\n").replace(" ", " ")
    lines = [re.sub(r"[ \t]+", " ", l).strip() for l in text.split("\n")]
    out, blank = [], False
    for l in lines:
        if not l:
            if out and not blank:
                out.append("")
            blank = True
        else:
            out.append(l)
            blank = False
    return "\n".join(out).strip()


def split_sentences(text):
    for line in text.split("\n"):
        for s in re.split(r"(?<=[.;])\s+(?=[A-Z0-9])", line):
            s = s.strip(" -:")
            if len(s.split()) >= 3:
                yield s


WORD = re.compile(r"[A-Za-z][A-Za-z'\-]*[A-Za-z]|[A-Za-z]")

TEST_TYPES = {"mri": "MRI", "ct": "CT", "xry": "X-RAY", "us": "US"}


def html_to_text(h):
    h = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</li>", "\n", h.replace("\r", " ").replace("\n", " "))
    h = re.sub(r"<[^>]+>", "", h)
    return html.unescape(h)


def load_rows():
    """Yield (month, text, test_type, truncated) from the Excel sheet or the Access export (.jsonl)."""
    if SRC.endswith(".jsonl"):
        for line in open(SRC, encoding="utf-8"):
            r = json.loads(line)
            month = int(r["date"][5:7]) if r.get("date") else None
            yield month, html_to_text(r["text"]), (r.get("testType") or "").strip().lower(), False
        return
    rows = list(openpyxl.load_workbook(SRC, read_only=True).worksheets[0].iter_rows(values_only=True))
    for r in rows[1:]:
        for c, v in enumerate(r):
            if v is not None and str(v).strip():
                yield rows[0][c], str(v), "", len(str(v)) >= 250


reports = []
for month, raw, test_type, truncated in load_rows():
    text = clean(raw)
    if len(text) < 40:
        continue
    if truncated:  # cell was cut off: drop the partial last word
        text = re.sub(r"\s*\S+$", "", text)
    title = text.split("\n", 1)[0]
    head = " ".join(text.split("\n")[:4])
    modality = classify(title if classify(title, MODALITIES) != "Other" else head, MODALITIES)
    if modality == "Other" and test_type in TEST_TYPES:
        modality = TEST_TYPES[test_type]
    reports.append({
        "id": len(reports) + 1,
        "month": month,
        "modality": modality,
        "region": classify(head, REGIONS),
        "truncated": truncated,
        "title": title,
        "text": text,
    })

for rep in reports:
    if rep["modality"] == "Other":
        t = rep["text"].lower()
        mri = len(re.findall(r"signal|t2|t1|flair|stir|dwi|hyperintens|hypointens", t))
        ct = len(re.findall(r"hypodens|hyperdens|attenuation|\bhu\b|density", t))
        if mri or ct:
            rep["modality"] = "MRI" if mri >= ct else "CT"

# Sentences
phrase_counts = defaultdict(Counter)
phrase_regions = defaultdict(Counter)
display = {}
follow = defaultdict(Counter)
for rep in reports:
    prev = None
    sents = list(split_sentences(rep["text"]))
    if rep["truncated"] and sents and not sents[-1].endswith("."):
        sents.pop()  # last sentence was cut off with the cell
    for s in sents:
        s = re.sub(r"\s+([.,;:])", r"\1", re.sub(r"\s+", " ", s))
        key = s.lower().rstrip(".")
        phrase_counts[key][rep["modality"]] += 1
        phrase_regions[key][rep["region"]] += 1
        display.setdefault(key, s if s.endswith(".") else s + ".")
        if prev is not None:
            follow[prev][key] += 1
        prev = key
phrases = sorted(
    ({"text": display[k], "count": sum(c.values()), "modalities": dict(c), "regions": dict(phrase_regions[k])} for k, c in phrase_counts.items()),
    key=lambda p: -p["count"],
)

next_sentences = {k: [[display[n], c] for n, c in cnt.most_common(5)] for k, cnt in follow.items()}

# Vocabulary and n-grams
vocab = Counter()
tri = defaultdict(Counter)
for rep in reports:
    for line in rep["text"].split("\n"):
        line = re.sub(r"\s+([.,;:])", r"\1", line)
        words = [w.lower() for w in WORD.findall(line)]
        vocab.update(words)
        seq = ["<s>", "<s>"] + words
        for i in range(2, len(seq)):
            tri[seq[i - 2] + " " + seq[i - 1]][seq[i]] += 1
ngrams = {k: [[w, n] for w, n in c.most_common(5)] for k, c in tri.items() if sum(c.values()) >= 2}

# Suspected typos: rare words that are not English and are 1-2 edits from a frequent library word
spell = SpellChecker()
frequent = {w for w, n in vocab.items() if n >= 5 and len(w) > 3}
lib_spell = SpellChecker(language=None, distance=2)
lib_spell.word_frequency.load_words([w for w in frequent for _ in range(1)])
lib_spell.word_frequency.load_json({w: vocab[w] for w in frequent})
# Real terms the edit-distance check mistakes for typos, and frequent misspellings in the library itself
NOT_TYPOS = set("""abdominis articularis bibasal bullae centred consolidative covid endplates ercp falx fossae
generalised inferiorly linea longus magna oedema orif perirectal radicular sella septation steatosis
sulcal teres trucut tumour work-up x-ray years-old adenomyotic""".split())
KNOWN_FIXES = {"hydrourter": "hydroureter", "hydrorter": "hydroureter", "hydrourte": "hydroureter",
               "meylogram": "myelogram", "ligment": "ligament", "pylonephritis": "pyelonephritis",
               "osteophy": "osteophytes", "circumferntial": "circumferential"}
typos = {w: {"suggest": c, "seen": vocab[w]} for w, c in KNOWN_FIXES.items() if w in vocab}
for w, n in vocab.items():
    if w in typos or w in NOT_TYPOS or n > 2 or len(w) < 4 or w in frequent or spell.known([w]):
        continue
    cand = lib_spell.correction(w)
    if cand and cand != w and vocab[cand] >= 10 * n:
        typos[w] = {"suggest": cand, "seen": n}

json.dump(next_sentences, open(f"{OUT}/next.json", "w"), ensure_ascii=False, separators=(",", ":"))
json.dump(reports, open(f"{OUT}/reports.json", "w"), ensure_ascii=False, indent=1)
# Exam titles for the template button (the site loads this instead of the full reports)
titles = Counter((re.sub(r"\s+", " ", r["title"]).strip(), r["modality"], r["region"]) for r in reports)
json.dump([[t, m, g, n] for (t, m, g), n in titles.most_common()],
          open(f"{OUT}/titles.json", "w"), ensure_ascii=False, separators=(",", ":"))
json.dump(phrases, open(f"{OUT}/phrases.json", "w"), ensure_ascii=False)
json.dump(ngrams, open(f"{OUT}/ngrams.json", "w"), ensure_ascii=False, separators=(",", ":"))
json.dump(dict(vocab.most_common()), open(f"{OUT}/vocab.json", "w"), ensure_ascii=False, separators=(",", ":"))
json.dump(dict(sorted(typos.items())), open(f"{OUT}/typos.json", "w"), ensure_ascii=False, indent=1)

print("reports", len(reports))
print("by month", Counter(r["month"] for r in reports))
print("modality", Counter(r["modality"] for r in reports))
print("region", Counter(r["region"] for r in reports))
print("phrases", len(phrases), "repeated>=3", sum(p["count"] >= 3 for p in phrases))
print("vocab", len(vocab), "ngram keys", len(ngrams), "typos", len(typos))
