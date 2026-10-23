// Data access: Firebase (Auth + Firestore) when configured, otherwise a browser-only demo store.
import { firebaseConfig } from "../firebase-config.js";

const SDK = "https://www.gstatic.com/firebasejs/10.12.2";
export const LIBRARY_FILES = ["phrases", "next", "ngrams", "vocab", "typos", "titles"];
const CHUNK = 700000; // characters per Firestore document (limit is 1 MiB)

export async function createStore() {
  return firebaseConfig.apiKey.startsWith("PASTE") ? createDemoStore() : createFirebaseStore();
}

async function createFirebaseStore() {
  const [{ initializeApp }, auth, fs] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
  ]);
  const app = initializeApp(firebaseConfig);
  const a = auth.getAuth(app);
  const db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache() });
  const store = { mode: "firebase", user: null };

  store.onAuth = (cb) => auth.onAuthStateChanged(a, async (u) => {
    if (!u) { store.user = null; return cb(null); }
    const profile = await fs.getDoc(fs.doc(db, "users", u.uid));
    const p = profile.exists() ? profile.data() : {};
    store.user = { uid: u.uid, email: u.email, name: p.name || u.email, role: p.role || "staff" };
    cb(store.user);
  });
  store.signIn = (email, password) => auth.signInWithEmailAndPassword(a, email, password);
  store.signOut = () => auth.signOut(a);

  store.loadLibrary = async () => {
    const meta = await fs.getDoc(fs.doc(db, "library", "meta"));
    if (!meta.exists()) return null;
    const lib = {};
    await Promise.all(Object.entries(meta.data().chunks).map(async ([name, n]) => {
      const parts = await Promise.all([...Array(n).keys()].map((i) => fs.getDoc(fs.doc(db, "library", `${name}_${i}`))));
      lib[name] = JSON.parse(parts.map((d) => d.data().data).join(""));
    }));
    return lib;
  };

  store.uploadLibrary = async (texts) => {
    const chunks = {};
    for (const [name, text] of Object.entries(texts)) {
      chunks[name] = Math.ceil(text.length / CHUNK);
      for (let i = 0; i < chunks[name]; i++) {
        await fs.setDoc(fs.doc(db, "library", `${name}_${i}`), { data: text.slice(i * CHUNK, (i + 1) * CHUNK) });
      }
    }
    await fs.setDoc(fs.doc(db, "library", "meta"), { chunks, updatedAt: fs.serverTimestamp(), updatedBy: store.user.name });
  };

  const reportsCol = fs.collection(db, "reports");
  const fromDoc = (d) => {
    const r = d.data({ serverTimestamps: "estimate" });
    for (const k of ["createdAt", "updatedAt", "approvedAt"]) if (r[k]?.toDate) r[k] = r[k].toDate();
    return { id: d.id, ...r };
  };

  store.watchReports = (cb) => fs.onSnapshot(
    fs.query(reportsCol, fs.orderBy("updatedAt", "desc"), fs.limit(200)),
    (snap) => cb(snap.docs.map(fromDoc)),
  );
  store.watchReport = (id, cb) => fs.onSnapshot(fs.doc(db, "reports", id), (d) => d.exists() && cb(fromDoc(d)));

  const stamp = () => ({ updatedAt: fs.serverTimestamp(), updatedBy: store.user.uid, updatedByName: store.user.name });
  store.saveReport = async (id, fields) => {
    if (id) {
      await fs.updateDoc(fs.doc(db, "reports", id), { ...fields, ...stamp() });
      return id;
    }
    const ref = await fs.addDoc(reportsCol, {
      ...fields, ...stamp(), status: "draft",
      createdAt: fs.serverTimestamp(), createdBy: store.user.uid, createdByName: store.user.name,
    });
    return ref.id;
  };
  store.setStatus = (id, status) => fs.updateDoc(fs.doc(db, "reports", id), status === "approved"
    ? { status, approvedBy: store.user.uid, approvedByName: store.user.name, approvedAt: fs.serverTimestamp(), ...stamp() }
    : { status, approvedBy: null, approvedByName: null, approvedAt: null, ...stamp() });

  const dictRef = fs.doc(db, "settings", "dictionary");
  store.loadDictionary = async () => {
    const d = await fs.getDoc(dictRef);
    return d.exists() ? d.data().words || [] : [];
  };
  store.addWord = (w) => fs.setDoc(dictRef, { words: fs.arrayUnion(w) }, { merge: true });

  return store;
}

// Demo mode: one local "radiologist" user, library from ./data, reports kept in localStorage.
function createDemoStore() {
  const KEY = "rr-demo-reports", DICT = "rr-demo-dictionary";
  const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } };
  const listeners = new Set();
  let reports = read(KEY, []).map((r) => ({ ...r, updatedAt: new Date(r.updatedAt), createdAt: new Date(r.createdAt), approvedAt: r.approvedAt && new Date(r.approvedAt) }));
  const emit = () => { write(KEY, reports); listeners.forEach((cb) => cb()); };
  const user = { uid: "demo", email: "demo@local", name: "Demo Radiologist", role: "radiologist" };
  const sorted = () => [...reports].sort((a, b) => b.updatedAt - a.updatedAt);

  return {
    mode: "demo",
    user,
    onAuth: (cb) => cb(user),
    signIn: async () => {},
    signOut: async () => {},
    loadLibrary: async () => {
      const data = await Promise.all(LIBRARY_FILES.map((f) => fetch(`data/${f}.json`).then((r) => (r.ok ? r.json() : null))));
      if (data.some((d) => d === null)) return null;
      return Object.fromEntries(LIBRARY_FILES.map((f, i) => [f, data[i]]));
    },
    uploadLibrary: async () => {},
    watchReports(cb) {
      const fn = () => cb(sorted());
      listeners.add(fn);
      fn();
      return () => listeners.delete(fn);
    },
    watchReport(id, cb) {
      const fn = () => { const r = reports.find((x) => x.id === id); if (r) cb({ ...r }); };
      listeners.add(fn);
      fn();
      return () => listeners.delete(fn);
    },
    async saveReport(id, fields) {
      const now = new Date();
      if (id) {
        reports = reports.map((r) => (r.id === id ? { ...r, ...fields, updatedAt: now, updatedBy: user.uid, updatedByName: user.name } : r));
      } else {
        id = "r" + now.getTime();
        reports.push({ id, ...fields, status: "draft", createdAt: now, updatedAt: now, createdBy: user.uid, createdByName: user.name, updatedBy: user.uid, updatedByName: user.name });
      }
      emit();
      return id;
    },
    async setStatus(id, status) {
      const now = new Date();
      reports = reports.map((r) => (r.id === id ? {
        ...r, status, updatedAt: now,
        approvedBy: status === "approved" ? user.uid : null,
        approvedByName: status === "approved" ? user.name : null,
        approvedAt: status === "approved" ? now : null,
      } : r));
      emit();
    },
    loadDictionary: async () => read(DICT, []),
    addWord: async (w) => write(DICT, [...new Set([...read(DICT, []), w])]),
  };
}
