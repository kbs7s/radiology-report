// Data access: Firebase (Auth + Firestore) when configured, otherwise a browser-only demo store.
// Both offer the same small document API, so the app never talks to Firestore directly:
//   watchDoc / watchQuery (live), getDoc / getQuery (once), setDoc / updateDoc / deleteDoc, tx (transaction).
// A query is { where: [[field, op, value], …], limit } with op one of "==", ">=", "<=".
import { firebaseConfig } from "../firebase-config.js";

const SDK = "https://www.gstatic.com/firebasejs/10.12.2";
export const LIBRARY_FILES = ["phrases", "next", "ngrams", "vocab", "typos", "titles"];
const CHUNK = 700000; // characters per Firestore document (limit is 1 MiB)

export async function createStore() {
  return firebaseConfig.apiKey.startsWith("PASTE") ? createDemoStore() : createFirebaseStore();
}

async function createFirebaseStore() {
  const [appSdk, auth, fs] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
  ]);
  const app = appSdk.initializeApp(firebaseConfig);
  const a = auth.getAuth(app);
  // Plain in-memory Firestore: the offline/IndexedDB cache can hang on mobile Safari
  const db = fs.getFirestore(app);
  const store = { mode: "firebase", user: null };

  store.onAuth = (cb) => auth.onAuthStateChanged(a, async (u) => {
    if (!u) { store.user = null; return cb(null); }
    // A missing or unreadable profile still signs the user in (without a role), never a blank screen
    let p = {}, error = null;
    try {
      const profile = await fs.getDoc(fs.doc(db, "users", u.uid));
      if (profile.exists()) p = profile.data();
    } catch (err) {
      console.error("profile read failed", err);
      error = err;
    }
    store.user = { ...p, uid: u.uid, email: u.email, name: p.name || u.email, role: p.role || "" };
    cb(store.user, error);
  });
  store.signIn = (email, password) => auth.signInWithEmailAndPassword(a, email, password);
  store.signOut = () => auth.signOut(a);
  store.resetPassword = (email) => auth.sendPasswordResetEmail(a, email);
  // A second app instance creates the account, so the admin stays signed in on the main one
  store.createAccount = async (email, password) => {
    const app2 = appSdk.initializeApp(firebaseConfig, `accounts-${Date.now()}`);
    try {
      const cred = await auth.createUserWithEmailAndPassword(auth.getAuth(app2), email, password);
      await auth.signOut(auth.getAuth(app2));
      return cred.user.uid;
    } finally {
      appSdk.deleteApp(app2);
    }
  };

  const ref = (col, id) => fs.doc(db, col, String(id));
  const toQuery = (col, q = {}) => fs.query(fs.collection(db, col),
    ...(q.where || []).map(([f, op, v]) => fs.where(f, op, v)),
    ...(q.limit ? [fs.limit(q.limit)] : []));
  const rows = (snap) => snap.docs.map((d) => ({ ...d.data(), _id: d.id }));

  store.watchDoc = (col, id, cb, onError) => fs.onSnapshot(ref(col, id),
    (d) => cb(d.exists() ? { ...d.data(), _id: d.id } : null), onError || ((e) => console.error(col, id, e)));
  store.watchQuery = (col, q, cb, onError) => fs.onSnapshot(toQuery(col, q),
    (snap) => cb(rows(snap), snap.metadata.hasPendingWrites), onError || ((e) => console.error(col, e)));
  store.getDoc = async (col, id) => { const d = await fs.getDoc(ref(col, id)); return d.exists() ? { ...d.data(), _id: d.id } : null; };
  store.getQuery = async (col, q) => rows(await fs.getDocs(toQuery(col, q)));
  store.setDoc = (col, id, data, merge = false) => fs.setDoc(ref(col, id), data, { merge });
  store.updateDoc = (col, id, patch) => fs.updateDoc(ref(col, id), patch);
  store.deleteDoc = (col, id) => fs.deleteDoc(ref(col, id));
  store.tx = (fn) => fs.runTransaction(db, (t) => fn({
    get: async (col, id) => { const d = await t.get(ref(col, id)); return d.exists() ? d.data() : null; },
    set: (col, id, data) => t.set(ref(col, id), data),
    update: (col, id, patch) => t.update(ref(col, id), patch),
  }));

  store.loadLibrary = async () => {
    const meta = await fs.getDoc(ref("library", "meta"));
    if (!meta.exists()) return null;
    const lib = {};
    await Promise.all(Object.entries(meta.data().chunks).map(async ([name, n]) => {
      const parts = await Promise.all([...Array(n).keys()].map((i) => fs.getDoc(ref("library", `${name}_${i}`))));
      lib[name] = JSON.parse(parts.map((d) => d.data().data).join(""));
    }));
    return lib;
  };
  store.uploadLibrary = async (texts) => {
    const chunks = {};
    for (const [name, text] of Object.entries(texts)) {
      chunks[name] = Math.ceil(text.length / CHUNK);
      for (let i = 0; i < chunks[name]; i++) {
        await fs.setDoc(ref("library", `${name}_${i}`), { data: text.slice(i * CHUNK, (i + 1) * CHUNK) });
      }
    }
    await fs.setDoc(ref("library", "meta"), { chunks, updatedAt: new Date().toISOString(), updatedBy: store.user.name });
  };

  const dictRef = ref("settings", "dictionary");
  store.loadDictionary = async () => { const d = await fs.getDoc(dictRef); return d.exists() ? d.data().words || [] : []; };
  store.addWord = (w) => fs.setDoc(dictRef, { words: fs.arrayUnion(w) }, { merge: true });

  return store;
}

// ---------------------------------------------------------------- demo
// Collections live in localStorage as { col: { id: data } }. Preview any role with ?role=reception|typist|radiologist|admin.
function createDemoStore() {
  const KEY = "rr2-demo";
  let data;
  try { data = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { data = {}; }
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* storage blocked */ } };
  const listeners = new Set();
  // Like Firestore, listeners hear about a local write before the write's promise resolves
  const emit = () => { persist(); listeners.forEach((fn) => fn()); };
  const col = (c) => (data[c] ||= {});
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const ops = { "==": (a, b) => a === b, ">=": (a, b) => a >= b, "<=": (a, b) => a <= b };
  const run = (c, q = {}) => {
    let out = Object.entries(col(c)).map(([id, d]) => ({ ...clone(d), _id: id }))
      .filter((d) => (q.where || []).every(([f, op, v]) => d[f] !== undefined && ops[op](d[f], v)));
    if (q.limit) out = out.slice(0, q.limit);
    return out;
  };
  // "report.body" style keys update nested fields, like Firestore
  const patchInto = (doc, patch) => {
    for (const [k, v] of Object.entries(patch)) {
      const path = k.split(".");
      let o = doc;
      path.slice(0, -1).forEach((p) => (o = o[p] = o[p] && typeof o[p] === "object" ? o[p] : {}));
      o[path[path.length - 1]] = clone(v ?? null);
    }
  };

  const role = new URLSearchParams(location.search).get("role") || "radiologist";
  const user = { uid: `demo-${role}`, email: `${role}@demo.local`, name: `Demo ${role}`, role };
  col("users")[user.uid] = { ...(col("users")[user.uid] || {}), name: user.name, role, email: user.email };
  persist();

  const store = {
    mode: "demo",
    user,
    onAuth: (cb) => cb(user, null),
    signIn: async () => {},
    signOut: async () => {},
    resetPassword: async () => {},
    createAccount: async () => `demo-${Date.now()}`,
    watchDoc(c, id, cb) {
      const fn = () => cb(col(c)[id] ? { ...clone(col(c)[id]), _id: String(id) } : null);
      listeners.add(fn); fn();
      return () => listeners.delete(fn);
    },
    watchQuery(c, q, cb) {
      const fn = () => cb(run(c, q), false);
      listeners.add(fn); fn();
      return () => listeners.delete(fn);
    },
    getDoc: async (c, id) => (col(c)[id] ? { ...clone(col(c)[id]), _id: String(id) } : null),
    getQuery: async (c, q) => run(c, q),
    setDoc: async (c, id, d, merge = false) => { col(c)[id] = merge ? { ...(col(c)[id] || {}), ...clone(d) } : clone(d); emit(); },
    updateDoc: async (c, id, patch) => {
      if (!col(c)[id]) throw new Error(`No document ${c}/${id}`);
      patchInto(col(c)[id], patch); emit();
    },
    deleteDoc: async (c, id) => { delete col(c)[id]; emit(); },
    async tx(fn) {
      const out = await fn({
        get: async (c, id) => (col(c)[id] ? clone(col(c)[id]) : null),
        set: (c, id, d) => { col(c)[id] = clone(d); },
        update: (c, id, patch) => patchInto(col(c)[id], patch),
      });
      emit();
      return out;
    },
    loadLibrary: async () => {
      const files = await Promise.all(LIBRARY_FILES.map((f) => fetch(`data/${f}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null)));
      if (files.some((d) => d === null)) return null;
      return Object.fromEntries(LIBRARY_FILES.map((f, i) => [f, files[i]]));
    },
    uploadLibrary: async () => {},
    loadDictionary: async () => col("settings").dictionary?.words || [],
    addWord: async (w) => { const d = (col("settings").dictionary ||= { words: [] }); if (!d.words.includes(w)) d.words.push(w); emit(); },
  };
  return store;
}
