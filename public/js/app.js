/* =============================================================
   জমির ফাইল — main app (plain JavaScript module, no build step)
   Backend: Firebase Spark (free, no card)
     • Authentication (email + password)
     • Cloud Firestore — records, notes, AND the photos themselves
       (photos are split into ~900 KB pieces, because Firebase Storage
        needs the paid Blaze plan)

   Firestore layout
     records/{recordId}                         → one dolil
     records/{recordId}/notes/{noteId}          → notes
     records/{recordId}/files/{fileId}          → photo/PDF info + small thumbnail
     records/{recordId}/files/{fileId}/chunks/{n} → the file bytes, in pieces
     meta/usage                                 → total bytes used (for the space meter)

   Pages (hash routes):  #/  ·  #/new  ·  #/r/<id>  ·  #/edit/<id>
   ============================================================= */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut, sendPasswordResetEmail,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, query, orderBy, writeBatch, Bytes, increment,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = document.getElementById("app");
const topbar = document.getElementById("topbar");

if (!firebaseConfig.apiKey || firebaseConfig.apiKey.includes("PASTE")) {
  app.innerHTML = `<div class="card card-pad empty" style="margin-top:40px">
    <div class="big">⚙️</div><h3>সেটআপ এখনও বাকি</h3>
    <p class="muted">public/js/firebase-config.js ফাইলে Firebase এর config বসান। (README.md দেখুন)</p></div>`;
  throw new Error("Firebase config missing");
}

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
// Local cache: pages open faster and work better on weak mobile internet
const db = initializeFirestore(fbApp, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

// ---------- Settings ----------
const CHUNK = 900 * 1024;                 // Firestore document limit is 1 MiB → store files in 900 KB pieces
const MAX_FILE = 10 * 1024 * 1024;        // after compression
const QUOTA = 1024 * 1024 * 1024;         // Spark plan: 1 GiB Firestore storage

const DEED_TYPES = ["সাফ কবলা", "হেবা", "দানপত্র", "বণ্টননামা", "বায়নানামা", "আমমোক্তারনামা", "এওয়াজ বদল", "না-দাবি", "অন্যান্য"];
const GROUPS = { main: "দলিলের মূল তথ্য", land: "জমির বিবরণ", reg: "রেজিস্ট্রি তথ্য" };
const FIELDS = [
  { k: "deed_no", l: "দলিল নম্বর", req: true, g: "main", ph: "যেমন: ১২৩৪/২০২৪" },
  { k: "owner_name", l: "মালিক / গ্রহীতার নাম", req: true, g: "main", ph: "জমির মালিকের নাম" },
  { k: "seller_name", l: "দাতার নাম", g: "main", ph: "যিনি জমি দিয়েছেন / বিক্রি করেছেন" },
  { k: "deed_type", l: "দলিলের ধরন", g: "main", list: DEED_TYPES, ph: "যেমন: সাফ কবলা" },
  { k: "district", l: "জেলা", g: "land" },
  { k: "upazila", l: "উপজেলা / থানা", g: "land" },
  { k: "mouza", l: "মৌজা", g: "land" },
  { k: "jl_no", l: "জেএল নম্বর", g: "land" },
  { k: "khatian_no", l: "খতিয়ান নম্বর", g: "land", ph: "যেমন: আরএস ৫৬৭" },
  { k: "dag_no", l: "দাগ নম্বর", g: "land" },
  { k: "land_amount", l: "জমির পরিমাণ", g: "land", ph: "যেমন: ৫ শতাংশ" },
  { k: "price", l: "মূল্য (টাকা)", g: "land" },
  { k: "sub_registry_office", l: "সাব-রেজিস্ট্রি অফিস", g: "reg" },
  { k: "registry_date", l: "রেজিস্ট্রির তারিখ", g: "reg", type: "date" },
];
const SEARCH_FILTERS = [
  { k: "all", l: "সবকিছু" },
  { k: "deed_no", l: "দলিল নম্বর" },
  { k: "owner_name", l: "মালিকের নাম" },
  { k: "seller_name", l: "দাতার নাম" },
  { k: "mouza", l: "মৌজা" },
  { k: "dag_no", l: "দাগ" },
  { k: "khatian_no", l: "খতিয়ান" },
];

let user = null;
let records = null;
const homeState = { q: "", filter: "all", sort: "new", limit: 100 };
const fullCache = new Map(); // file id → object URL

// ---------- Small helpers ----------
const BN = "০১২৩৪৫৬৭৮৯";
const toBn = (s) => String(s ?? "").replace(/[0-9]/g, (d) => BN[d]);
const toEn = (s) => String(s ?? "").replace(/[০-৯]/g, (d) => BN.indexOf(d));
const norm = (s) => toEn(s).toLowerCase().replace(/\s+/g, " ").trim();
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = (sel, root = document) => root.querySelector(sel);
const nowIso = () => new Date().toISOString();

function fmtDate(iso, withTime = false) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return esc(iso);
  const opt = { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Dhaka" };
  if (withTime) Object.assign(opt, { hour: "numeric", minute: "2-digit" });
  return d.toLocaleString("bn-BD", opt).replace("AM", "পূর্বাহ্ণ").replace("PM", "অপরাহ্ণ");
}
function fmtMB(bytes) {
  const mb = bytes / 1048576;
  return toBn(mb >= 100 ? Math.round(mb) : mb.toFixed(1)) + " MB";
}
function bnError(err) {
  const c = (err && err.code) || "";
  const m = (err && err.message) || String(err || "");
  if (/invalid-credential|wrong-password|user-not-found|invalid-email/.test(c)) return "ইমেইল বা পাসওয়ার্ড ভুল হয়েছে।";
  if (/too-many-requests/.test(c)) return "অনেকবার চেষ্টা করা হয়েছে। কিছুক্ষণ পরে আবার চেষ্টা করুন।";
  if (/network-request-failed|unavailable/.test(c)) return "ইন্টারনেট সংযোগ নেই বা দুর্বল। আবার চেষ্টা করুন।";
  if (/permission-denied/.test(c)) return "এই অ্যাকাউন্টের অনুমতি নেই। (Firestore rules-এ ইমেইলটি যোগ করা আছে কি?)";
  if (/resource-exhausted/.test(c)) return "আজকের ফ্রি সীমা শেষ হয়ে গেছে। আগামীকাল আবার চেষ্টা করুন।";
  if (/not-found/.test(c)) return "তথ্যটি পাওয়া যায়নি।";
  return "সমস্যা হয়েছে: " + m;
}

function toast(msg, type = "") {
  const el = document.createElement("div");
  el.className = "toast " + type;
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), type === "err" ? 5000 : 2800);
}

// Generic dialog. Returns read(body) on OK, or null on cancel.
function modal({ title, html = "", okText = "ঠিক আছে", okClass = "btn-primary", read }) {
  const m = $("#modal"), ok = $("#modalOk"), cancel = $("#modalCancel"), body = $("#modalBody");
  $("#modalTitle").textContent = title;
  body.innerHTML = html;
  ok.textContent = okText;
  ok.className = "btn " + okClass;
  m.hidden = false;
  setTimeout(() => (body.querySelector("input,textarea") || ok).focus(), 30);
  return new Promise((resolve) => {
    const done = (val) => {
      m.hidden = true;
      ok.onclick = cancel.onclick = m.onclick = document.onkeydown = null;
      resolve(val);
    };
    ok.onclick = () => done(read ? read(body) : true);
    cancel.onclick = () => done(null);
    m.onclick = (e) => { if (e.target === m) done(null); };
    document.onkeydown = (e) => { if (e.key === "Escape") done(null); };
  });
}
const confirmBox = (title, text, okText = "মুছে ফেলুন") =>
  modal({ title, html: `<p>${text}</p>`, okText, okClass: "btn-danger" });

const loadingHTML = (t = "লোড হচ্ছে…") => `<div class="loading"><div class="spinner"></div>${t}</div>`;

// Show the thin bar at the top while waiting for Firebase
let busy = 0;
async function work(promise) {
  busy++;
  $("#busyBar").hidden = false;
  try { return await promise; } finally { if (--busy === 0) $("#busyBar").hidden = true; }
}

// =============================================================
//  DATA LAYER (all Firestore code is here)
// =============================================================
const recordsCol = () => collection(db, "records");
const recordRef = (id) => doc(db, "records", id);
const filesCol = (rid) => collection(db, "records", rid, "files");
const notesCol = (rid) => collection(db, "records", rid, "notes");
const usageRef = () => doc(db, "meta", "usage");
const withId = (snap) => ({ id: snap.id, ...snap.data() });

async function loadRecords() {
  const snap = await work(getDocs(query(recordsCol(), orderBy("created_at", "desc"))));
  records = snap.docs.map(withId);
  return records;
}
async function loadRecord(id) {
  const snap = await work(getDoc(recordRef(id)));
  return snap.exists() ? withId(snap) : null;
}
async function saveRecordData(id, data) {
  const t = nowIso();
  if (id) {
    await work(updateDoc(recordRef(id), { ...data, updated_at: t }));
    return { id, ...(records || []).find((r) => r.id === id), ...data, updated_at: t };
  }
  const ref = doc(recordsCol()); // new random id
  const rec = { ...data, created_at: t, updated_at: t };
  await work(setDoc(ref, rec));
  return { id: ref.id, ...rec };
}
async function loadFiles(rid) {
  const snap = await work(getDocs(query(filesCol(rid), orderBy("created_at"))));
  return snap.docs.map(withId);
}
async function loadNotes(rid) {
  const snap = await work(getDocs(query(notesCol(rid), orderBy("created_at", "desc"))));
  return snap.docs.map(withId);
}

// Save one file: pieces first, then the info document (so half-uploaded files never appear)
async function storeFile(rid, { name, mime, bytes, thumb }) {
  const fileRef = doc(filesCol(rid));
  const pieces = Math.max(1, Math.ceil(bytes.length / CHUNK));
  try {
    for (let i = 0; i < pieces; i++) {
      const part = bytes.subarray(i * CHUNK, (i + 1) * CHUNK);
      await setDoc(doc(fileRef, "chunks", String(i)), { i, data: Bytes.fromUint8Array(part) });
    }
    const info = { file_name: name, mime_type: mime, size: bytes.length, chunks: pieces, caption: "", thumb: thumb || "", created_at: nowIso() };
    await setDoc(fileRef, info);
    await setDoc(usageRef(), { bytes: increment(bytes.length + (thumb ? thumb.length : 0)) }, { merge: true });
    return { id: fileRef.id, ...info };
  } catch (e) {
    await deleteChunks(fileRef).catch(() => {});
    throw e;
  }
}
async function readFileBytes(rid, f) {
  const snap = await getDocs(collection(doc(filesCol(rid), f.id), "chunks"));
  const parts = snap.docs.map((d) => d.data()).sort((a, b) => a.i - b.i).map((p) => p.data.toUint8Array());
  return new Blob(parts, { type: f.mime_type || "application/octet-stream" });
}
async function deleteChunks(fileRef) {
  const snap = await getDocs(collection(fileRef, "chunks"));
  if (!snap.size) return;
  const batch = writeBatch(db);
  snap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}
async function removeFile(rid, f) {
  const fileRef = doc(filesCol(rid), f.id);
  await deleteChunks(fileRef);
  await deleteDoc(fileRef);
  await setDoc(usageRef(), { bytes: increment(-((f.size || 0) + (f.thumb ? f.thumb.length : 0))) }, { merge: true });
}
async function removeRecord(rid) {
  const files = await loadFiles(rid);
  for (const f of files) await removeFile(rid, f);
  const notes = await getDocs(notesCol(rid));
  if (notes.size) {
    const batch = writeBatch(db);
    notes.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  await deleteDoc(recordRef(rid));
}
async function getUsage() {
  const snap = await getDoc(usageRef());
  return Math.max(0, (snap.exists() && snap.data().bytes) || 0);
}

// =============================================================
//  ROUTER
// =============================================================
async function route() {
  window.scrollTo(0, 0);
  if (!user) { topbar.hidden = true; return renderLogin(); }
  topbar.hidden = false;
  const parts = (location.hash.replace(/^#\/?/, "") || "").split("/");
  try {
    if (parts[0] === "new") return await renderForm(null);
    if (parts[0] === "edit" && parts[1]) return await renderForm(parts[1]);
    if (parts[0] === "r" && parts[1]) return await renderDetail(parts[1]);
    return await renderHome();
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="card card-pad empty"><div class="big">⚠️</div><h3>সমস্যা হয়েছে</h3><p class="muted">${esc(bnError(e))}</p>
      <button class="btn btn-primary" onclick="location.reload()">আবার চেষ্টা করুন</button></div>`;
  }
}
window.addEventListener("hashchange", route);

// ---------- Login ----------
function renderLogin() {
  app.innerHTML = `
    <div class="login-wrap">
      <div class="card login-card">
        <div class="brand-mark" style="color:var(--gold)"><svg viewBox="0 0 64 64"><path d="M10 46 L32 14 L54 46 Z" fill="currentColor"/><rect x="10" y="46" width="44" height="6" rx="2" fill="currentColor" opacity=".55"/></svg></div>
        <h1>জমির ফাইল</h1>
        <p class="muted">দলিল ও জমির রেকর্ড দেখতে লগইন করুন</p>
        <form id="loginForm">
          <div class="field"><label for="em">ইমেইল</label><input class="input" id="em" type="email" autocomplete="username" required /></div>
          <div class="field"><label for="pw">পাসওয়ার্ড</label><input class="input" id="pw" type="password" autocomplete="current-password" required /></div>
          <button class="btn btn-primary" type="submit" style="width:100%;padding:13px">প্রবেশ করুন</button>
          <button class="link-btn" type="button" id="forgot">পাসওয়ার্ড ভুলে গেছেন?</button>
        </form>
      </div>
    </div>`;
  $("#loginForm").onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true; btn.textContent = "অপেক্ষা করুন…";
    try {
      await work(signInWithEmailAndPassword(auth, $("#em").value.trim(), $("#pw").value));
    } catch (err) {
      toast(bnError(err), "err");
      btn.disabled = false; btn.textContent = "প্রবেশ করুন";
    }
  };
  $("#forgot").onclick = async () => {
    const email = $("#em").value.trim();
    if (!email) return toast("আগে উপরে ইমেইল লিখুন", "err");
    try {
      await work(sendPasswordResetEmail(auth, email));
      toast("পাসওয়ার্ড বদলানোর লিংক ইমেইলে পাঠানো হয়েছে (Spam ফোল্ডারও দেখুন)");
    } catch (err) { toast(bnError(err), "err"); }
  };
}

// ---------- Home: list + search ----------
async function renderHome() {
  app.innerHTML = `
    <section class="card hero">
      <h2>দলিল খুঁজুন</h2>
      <p>দলিল নম্বর, মালিকের নাম, মৌজা, দাগ বা খতিয়ান নম্বর লিখুন — বাংলা বা ইংরেজি সংখ্যা দুটোই চলবে।</p>
      <div class="search-box">
        <span class="s-ic">🔍</span>
        <input id="q" type="search" placeholder="এখানে লিখে খুঁজুন…" value="${esc(homeState.q)}" autocomplete="off" />
        <button class="s-clear" id="qClear" ${homeState.q ? "" : "hidden"}>মুছুন</button>
      </div>
      <div class="filters" id="filters">
        ${SEARCH_FILTERS.map((f) => `<button class="chip ${homeState.filter === f.k ? "active" : ""}" data-f="${f.k}">${f.l}</button>`).join("")}
      </div>
    </section>
    <div class="list-head">
      <span class="count" id="count"></span>
      <select class="input" id="sort">
        <option value="new">নতুন রেকর্ড আগে</option>
        <option value="old">পুরাতন রেকর্ড আগে</option>
        <option value="deed">দলিল নম্বর অনুযায়ী</option>
        <option value="owner">মালিকের নাম অনুযায়ী</option>
      </select>
    </div>
    <div id="list">${loadingHTML("তালিকা আনা হচ্ছে…")}</div>`;

  $("#sort").value = homeState.sort;
  const q = $("#q");
  q.oninput = () => { homeState.q = q.value; homeState.limit = 100; $("#qClear").hidden = !q.value; drawList(); };
  $("#qClear").onclick = () => { q.value = ""; q.oninput(); q.focus(); };
  $("#sort").onchange = (e) => { homeState.sort = e.target.value; drawList(); };
  $("#filters").onclick = (e) => {
    const b = e.target.closest("[data-f]");
    if (!b) return;
    homeState.filter = b.dataset.f;
    document.querySelectorAll("#filters .chip").forEach((c) => c.classList.toggle("active", c === b));
    drawList();
  };

  if (records) drawList();
  await loadRecords();
  if ($("#list")) drawList();
}

function matchRecords() {
  const tokens = norm(homeState.q).split(" ").filter(Boolean);
  let list = records.slice();
  if (tokens.length) {
    const keys = homeState.filter === "all" ? FIELDS.map((f) => f.k) : [homeState.filter];
    list = list.filter((r) => {
      const hay = norm(keys.map((k) => r[k] || "").join(" | ") + (homeState.filter === "all" ? " " + fmtDate(r.registry_date) : ""));
      return tokens.every((t) => hay.includes(t));
    });
  }
  const cmpText = (a, b) => norm(a).localeCompare(norm(b), "bn", { numeric: true });
  const byCreated = (a, b) => String(a.created_at).localeCompare(String(b.created_at));
  if (homeState.sort === "old") list.sort(byCreated);
  else if (homeState.sort === "deed") list.sort((a, b) => cmpText(a.deed_no, b.deed_no));
  else if (homeState.sort === "owner") list.sort((a, b) => cmpText(a.owner_name, b.owner_name));
  else list.sort((a, b) => byCreated(b, a));
  return list;
}

// Wrap matching parts of text in <mark> (works for Bangla & English digits)
function hl(text) {
  const raw = String(text ?? "");
  const tokens = homeState.q.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || !raw) return esc(raw);
  const variants = new Set();
  tokens.forEach((t) => { variants.add(t); variants.add(toBn(t)); variants.add(toEn(t)); });
  const re = new RegExp("(" + [...variants].map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "gi");
  return raw.split(re).map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join("");
}

function drawList() {
  const list = matchRecords();
  const total = records.length;
  $("#count").textContent = homeState.q.trim()
    ? `মোট ${toBn(total)}টির মধ্যে ${toBn(list.length)}টি পাওয়া গেছে`
    : `মোট ${toBn(total)}টি দলিল`;

  if (!total) {
    $("#list").innerHTML = `<div class="card empty"><div class="big">📂</div><h3>এখনও কোনো দলিল যোগ করা হয়নি</h3>
      <p class="muted">প্রথম দলিলটি যোগ করে শুরু করুন।</p><a class="btn btn-primary" href="#/new">＋ নতুন দলিল যোগ করুন</a></div>`;
    return;
  }
  if (!list.length) {
    $("#list").innerHTML = `<div class="card empty"><div class="big">🔎</div><h3>কিছু পাওয়া যায়নি</h3>
      <p class="muted">অন্য শব্দ বা নম্বর দিয়ে আবার খুঁজে দেখুন।</p></div>`;
    return;
  }
  const shown = list.slice(0, homeState.limit);
  $("#list").innerHTML =
    `<div class="rec-list">` +
    shown.map((r) => {
      const meta = [
        r.mouza && `মৌজা: ${hl(r.mouza)}`,
        r.dag_no && `দাগ: ${hl(r.dag_no)}`,
        r.khatian_no && `খতিয়ান: ${hl(r.khatian_no)}`,
        r.land_amount && esc(r.land_amount),
      ].filter(Boolean);
      return `<a class="card rec" href="#/r/${esc(r.id)}">
        <div class="rec-no"><small>দলিল নং</small><b>${hl(r.deed_no)}</b></div>
        <div class="rec-main">
          <div class="rec-owner">${hl(r.owner_name)}</div>
          <div class="rec-meta">${meta.map((m) => `<span>${m}</span>`).join("") || `<span>${r.seller_name ? "দাতা: " + hl(r.seller_name) : ""}</span>`}</div>
        </div>
        <div class="rec-date"><b>তৈরি</b>${fmtDate(r.created_at)}</div>
      </a>`;
    }).join("") +
    `</div>` +
    (list.length > shown.length
      ? `<div style="text-align:center;margin-top:14px"><button class="btn btn-light" id="more">আরও দেখুন (${toBn(list.length - shown.length)}টি বাকি)</button></div>`
      : "");
  const more = $("#more");
  if (more) more.onclick = () => { homeState.limit += 100; drawList(); };
}

// ---------- Add / Edit form ----------
async function renderForm(id) {
  let rec = {};
  if (id) {
    app.innerHTML = loadingHTML();
    rec = await loadRecord(id);
    if (!rec) { location.hash = "#/"; return; }
  }
  const fieldHTML = (f) => {
    const v = esc(rec[f.k] ?? "");
    const listAttr = f.list ? `list="dl-${f.k}"` : "";
    return `<div class="field">
      <label for="f-${f.k}">${f.l} ${f.req ? '<span class="req">*</span>' : ""}</label>
      <input class="input" id="f-${f.k}" name="${f.k}" type="${f.type || "text"}" value="${v}" placeholder="${esc(f.ph || "")}" ${f.req ? "required" : ""} ${listAttr} />
      ${f.list ? `<datalist id="dl-${f.k}">${f.list.map((o) => `<option value="${o}">`).join("")}</datalist>` : ""}
    </div>`;
  };
  const back = id ? "#/r/" + esc(id) : "#/";
  app.innerHTML = `
    <a class="back" href="${back}">← ফিরে যান</a>
    <form class="card card-pad" id="recForm">
      <h2 class="section-title">${id ? "দলিলের তথ্য সম্পাদনা" : "নতুন দলিল যোগ করুন"}</h2>
      ${Object.entries(GROUPS).map(([g, title]) => `
        <div class="form-group"><h4>${title}</h4>
          <div class="form-grid">${FIELDS.filter((f) => f.g === g).map(fieldHTML).join("")}</div>
        </div>`).join("")}
      <p class="muted" style="font-size:14px;margin:0 0 10px">* চিহ্নিত ঘর পূরণ করা বাধ্যতামূলক। দলিলের ছবি ও নোট সংরক্ষণের পরের পাতায় যোগ করা যাবে।</p>
      <div class="form-actions">
        <a class="btn btn-light" href="${back}">বাতিল</a>
        <button class="btn btn-primary" type="submit">✓ সংরক্ষণ করুন</button>
      </div>
    </form>`;
  if (!id) $("#f-deed_no").focus();

  $("#recForm").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = {};
    FIELDS.forEach((f) => { data[f.k] = String(fd.get(f.k) || "").trim().slice(0, 1000); });
    if (!data.deed_no || !data.owner_name) return toast("দলিল নম্বর ও মালিকের নাম দিন", "err");

    const dup = (records || []).find((r) => r.id !== id && norm(r.deed_no) === norm(data.deed_no));
    if (dup) {
      const go = await modal({
        title: "একই নম্বরের দলিল আছে",
        html: `<p>দলিল নং <b>${esc(dup.deed_no)}</b> আগেই আছে (মালিক: ${esc(dup.owner_name)})। তবুও সংরক্ষণ করবেন?</p>`,
        okText: "হ্যাঁ, সংরক্ষণ করুন",
      });
      if (!go) return;
    }

    const btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true; btn.textContent = "সংরক্ষণ হচ্ছে…";
    try {
      const saved = await saveRecordData(id, data);
      if (records) {
        const i = records.findIndex((r) => r.id === saved.id);
        if (i >= 0) records[i] = saved; else records.unshift(saved);
      }
      toast(id ? "পরিবর্তন সংরক্ষণ হয়েছে" : "নতুন দলিল যোগ হয়েছে");
      location.hash = "#/r/" + saved.id;
    } catch (err) {
      btn.disabled = false; btn.textContent = "✓ সংরক্ষণ করুন";
      toast(bnError(err), "err");
    }
  };
}

// ---------- Detail page ----------
let cur = null; // { record, files, notes }
let viewerList = [];

async function renderDetail(id) {
  app.innerHTML = loadingHTML();
  const [rec, files, notes] = await Promise.all([loadRecord(id), loadFiles(id), loadNotes(id)]);
  if (!rec) {
    app.innerHTML = `<div class="card empty"><div class="big">📄</div><h3>দলিলটি পাওয়া যায়নি</h3><a class="btn btn-primary" href="#/">তালিকায় ফিরুন</a></div>`;
    return;
  }
  cur = { record: rec, files, notes };
  const info = FIELDS.filter((f) => !["deed_no", "owner_name"].includes(f.k))
    .map((f) => {
      const v = f.k === "registry_date" ? fmtDate(rec[f.k]) : esc(rec[f.k] ?? "");
      return `<div class="info-item"><div class="k">${f.l}</div><div class="v ${v ? "" : "empty-v"}">${v || "—"}</div></div>`;
    }).join("");

  app.innerHTML = `
    <a class="back" href="#/">← সব দলিল</a>
    <section class="card detail-head">
      <div>
        <div class="label">দলিল নম্বর</div>
        <div class="deed">${esc(rec.deed_no)}</div>
        <div class="owner">${esc(rec.owner_name)}</div>
        <div class="sub">তৈরি: ${fmtDate(rec.created_at, true)}${rec.updated_at && rec.updated_at !== rec.created_at ? " · সর্বশেষ পরিবর্তন: " + fmtDate(rec.updated_at, true) : ""}</div>
      </div>
      <div class="actions">
        <a class="btn btn-light" href="#/edit/${esc(rec.id)}">✎ সম্পাদনা</a>
        <button class="btn btn-danger" id="delRec">🗑 মুছুন</button>
      </div>
    </section>
    <section class="card"><div class="info-grid">${info}</div></section>

    <div class="two-col">
      <section class="card card-pad">
        <h3 class="section-title">দলিলের ছবি ও ফাইল <span class="muted" style="font-size:15px" id="fileCount"></span></h3>
        <div class="upload-zone" id="drop">
          <div>📎 দলিলের ছবি বা PDF এখানে টেনে আনুন</div>
          <div class="btns">
            <label class="btn btn-primary btn-sm">🖼 ফাইল বাছাই করুন<input type="file" id="pick" accept="image/*,application/pdf" multiple hidden /></label>
            <label class="btn btn-light btn-sm">📷 ছবি তুলুন<input type="file" id="cam" accept="image/*" capture="environment" hidden /></label>
          </div>
          <div class="progress" id="progress" hidden></div>
        </div>
        <div class="files" id="files"></div>
      </section>

      <section class="card card-pad">
        <h3 class="section-title">নোট</h3>
        <div class="note-form">
          <textarea class="input" id="noteText" placeholder="এই দলিল সম্পর্কে কিছু লিখে রাখুন… (যেমন: খাজনা পরিশোধ, নামজারি, কার কাছে মূল দলিল আছে)"></textarea>
          <button class="btn btn-primary" id="addNote">＋ নোট সংরক্ষণ করুন</button>
        </div>
        <div class="notes" id="notes"></div>
      </section>
    </div>`;

  $("#delRec").onclick = async () => {
    const ok = await confirmBox("দলিল মুছে ফেলবেন?",
      `দলিল নং <b>${esc(rec.deed_no)}</b> এবং এর সব ছবি ও নোট স্থায়ীভাবে মুছে যাবে। এটি আর ফেরত আনা যাবে না।`);
    if (!ok) return;
    try {
      await work(removeRecord(rec.id));
      if (records) records = records.filter((r) => r.id !== rec.id);
      toast("দলিল মুছে ফেলা হয়েছে");
      location.hash = "#/";
    } catch (err) { toast(bnError(err), "err"); }
  };

  const handle = (list) => list && list.length && uploadFiles([...list]);
  $("#pick").onchange = (e) => { handle(e.target.files); e.target.value = ""; };
  $("#cam").onchange = (e) => { handle(e.target.files); e.target.value = ""; };
  const drop = $("#drop");
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("drag"); }));
  drop.addEventListener("drop", (e) => handle(e.dataTransfer.files));

  $("#addNote").onclick = async () => {
    const t = $("#noteText").value.trim();
    if (!t) return toast("আগে নোট লিখুন", "err");
    const btn = $("#addNote");
    btn.disabled = true; btn.textContent = "সংরক্ষণ হচ্ছে…";
    try {
      const ref = doc(notesCol(rec.id));
      const note = { content: t.slice(0, 20000), created_at: nowIso(), updated_at: nowIso() };
      await work(setDoc(ref, note));
      cur.notes.unshift({ id: ref.id, ...note });
      $("#noteText").value = "";
      toast("নোট সংরক্ষণ হয়েছে");
      drawNotes();
    } catch (err) { toast(bnError(err), "err"); }
    btn.disabled = false; btn.textContent = "＋ নোট সংরক্ষণ করুন";
  };

  drawFiles();
  drawNotes();
}

// ----- Files -----
const isPdf = (f) => String(f.mime_type || "").includes("pdf");

function drawFiles() {
  const box = $("#files");
  if (!box) return;
  const files = cur.files;
  $("#fileCount").textContent = files.length ? `(${toBn(files.length)}টি)` : "";
  viewerList = files.filter((f) => !isPdf(f));
  if (!files.length) { box.innerHTML = `<p class="muted" style="grid-column:1/-1;margin:4px 0 0">এখনও কোনো ছবি যোগ করা হয়নি।</p>`; return; }

  box.innerHTML = files.map((f) => `
    <div class="file" data-id="${esc(f.id)}">
      <div class="thumb ${isPdf(f) ? "pdf" : ""}" ${f.thumb ? `style="background-image:url(&quot;${esc(f.thumb)}&quot;)"` : ""} title="${isPdf(f) ? "ডাউনলোড করুন" : "বড় করে দেখুন"}">${!f.thumb ? (isPdf(f) ? "PDF" : "📄") : ""}</div>
      <div class="cap ${f.caption ? "" : "none"}">${f.caption ? esc(f.caption) : esc(f.file_name || "বিবরণ নেই")}</div>
      <div class="tools">
        <button class="icon-btn" data-act="zoom" title="বড় করে দেখুন">🔍</button>
        <button class="icon-btn" data-act="dl" title="ডাউনলোড">⬇</button>
        <button class="icon-btn" data-act="edit" title="বিবরণ লিখুন">✎</button>
        <button class="icon-btn danger" data-act="del" title="মুছুন">🗑</button>
      </div>
    </div>`).join("");

  box.onclick = async (e) => {
    const card = e.target.closest(".file");
    if (!card) return;
    const f = cur.files.find((x) => x.id === card.dataset.id);
    const act = e.target.closest("[data-act]")?.dataset.act || (e.target.closest(".thumb") ? "zoom" : null);
    const rid = cur.record.id;
    if (act === "zoom") {
      if (isPdf(f)) downloadFile(f);
      else openViewer(viewerList.indexOf(f));
    } else if (act === "dl") downloadFile(f);
    else if (act === "edit") {
      const cap = await modal({
        title: "ছবির বিবরণ",
        html: `<input class="input" id="capIn" value="${esc(f.caption || "")}" placeholder="যেমন: দলিলের ১ম পাতা" />`,
        okText: "সংরক্ষণ",
        read: (b) => b.querySelector("#capIn").value.trim().slice(0, 300),
      });
      if (cap === null) return;
      try {
        await work(updateDoc(doc(filesCol(rid), f.id), { caption: cap }));
        f.caption = cap;
        toast("বিবরণ সংরক্ষণ হয়েছে");
        drawFiles();
      } catch (err) { toast(bnError(err), "err"); }
    } else if (act === "del") {
      const ok = await confirmBox("ছবি মুছে ফেলবেন?", "এই ফাইলটি স্থায়ীভাবে মুছে যাবে।");
      if (!ok) return;
      try {
        await work(removeFile(rid, f));
        cur.files = cur.files.filter((x) => x.id !== f.id);
        toast("ফাইল মুছে ফেলা হয়েছে");
        drawFiles();
      } catch (err) { toast(bnError(err), "err"); }
    }
  };
}

async function getFull(f) {
  if (fullCache.has(f.id)) return fullCache.get(f.id);
  const blob = await work(readFileBytes(cur.record.id, f));
  const url = URL.createObjectURL(blob);
  fullCache.set(f.id, url);
  return url;
}

async function downloadFile(f) {
  toast("ডাউনলোড হচ্ছে…");
  try {
    const url = await getFull(f);
    const a = document.createElement("a");
    a.href = url;
    a.download = f.file_name || "dolil";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (err) { toast(bnError(err), "err"); }
}

// Draw an image file onto a canvas at a maximum size → JPEG blob
function loadImage(file) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}
function drawJpeg(img, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return new Promise((resolve) => c.toBlob(resolve, "image/jpeg", quality));
}

// Make photos small (space is limited to 1 GB) but still clear enough to read a deed
async function prepareFile(file) {
  const isImage = file.type.startsWith("image/") && !/gif|svg/.test(file.type);
  if (!isImage) return { blob: file, name: file.name, mime: file.type || "application/pdf", thumb: "" };
  const img = await loadImage(file);
  if (!img) return { blob: file, name: file.name, mime: file.type, thumb: "" }; // e.g. HEIC that the browser can't open
  let blob = await drawJpeg(img, 2000, 0.8);
  if (blob.size > 1.2 * 1024 * 1024) blob = await drawJpeg(img, 1600, 0.7);
  const thumbBlob = await drawJpeg(img, 360, 0.7);
  const thumb = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(thumbBlob); });
  return { blob, name: file.name.replace(/\.[^.]+$/, "") + ".jpg", mime: "image/jpeg", thumb };
}

async function uploadFiles(list) {
  const rid = cur.record.id;
  const prog = $("#progress");
  prog.hidden = false;
  let okCount = 0;
  for (let i = 0; i < list.length; i++) {
    const file = list[i];
    if (!/^image\/|pdf$/.test(file.type) && !/\.(pdf|jpe?g|png|webp|heic|heif)$/i.test(file.name)) {
      toast(`"${file.name}" — শুধু ছবি বা PDF আপলোড করা যাবে`, "err");
      continue;
    }
    prog.textContent = `আপলোড হচ্ছে… (${toBn(i + 1)}/${toBn(list.length)}) — অনুগ্রহ করে অপেক্ষা করুন`;
    try {
      const p = await prepareFile(file);
      if (p.blob.size > MAX_FILE) { toast(`"${file.name}" অনেক বড় (সর্বোচ্চ ১০ MB)`, "err"); continue; }
      const bytes = new Uint8Array(await p.blob.arrayBuffer());
      const saved = await work(storeFile(rid, { name: p.name, mime: p.mime, bytes, thumb: p.thumb }));
      fullCache.set(saved.id, URL.createObjectURL(p.blob));
      if (cur && cur.record.id === rid) cur.files.push(saved);
      okCount++;
    } catch (err) { toast(bnError(err), "err"); }
  }
  if (!$("#progress")) return; // user left the page
  prog.hidden = true;
  if (okCount) toast(`${toBn(okCount)}টি ফাইল আপলোড হয়েছে`);
  drawFiles();
}

// ----- Notes -----
function drawNotes() {
  const box = $("#notes");
  if (!box) return;
  const notes = cur.notes;
  if (!notes.length) { box.innerHTML = `<p class="muted" style="margin:0">এখনও কোনো নোট নেই।</p>`; return; }
  box.innerHTML = notes.map((n) => `
    <div class="note" data-id="${esc(n.id)}">
      <div class="note-text">${esc(n.content)}</div>
      <div class="note-foot">
        <span>${fmtDate(n.created_at, true)}${n.updated_at !== n.created_at ? " (সম্পাদিত)" : ""}</span>
        <span class="tools">
          <button class="icon-btn" data-act="edit" title="সম্পাদনা">✎</button>
          <button class="icon-btn danger" data-act="del" title="মুছুন">🗑</button>
        </span>
      </div>
    </div>`).join("");

  box.onclick = async (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const n = cur.notes.find((x) => x.id === b.closest(".note").dataset.id);
    const ref = doc(notesCol(cur.record.id), n.id);
    try {
      if (b.dataset.act === "edit") {
        const t = await modal({
          title: "নোট সম্পাদনা",
          html: `<textarea class="input" id="noteEdit" style="min-height:160px">${esc(n.content)}</textarea>`,
          okText: "সংরক্ষণ",
          read: (body) => body.querySelector("#noteEdit").value.trim(),
        });
        if (t === null) return;
        if (!t) return toast("নোট খালি রাখা যাবে না", "err");
        const upd = { content: t.slice(0, 20000), updated_at: nowIso() };
        await work(updateDoc(ref, upd));
        Object.assign(n, upd);
        toast("নোট আপডেট হয়েছে");
      } else {
        const ok = await confirmBox("নোট মুছে ফেলবেন?", "এই নোটটি স্থায়ীভাবে মুছে যাবে।");
        if (!ok) return;
        await work(deleteDoc(ref));
        cur.notes = cur.notes.filter((x) => x.id !== n.id);
        toast("নোট মুছে ফেলা হয়েছে");
      }
      drawNotes();
    } catch (err) { toast(bnError(err), "err"); }
  };
}

// ---------- Image viewer (zoom / pan / rotate) ----------
const V = { i: 0, s: 1, r: 0, x: 0, y: 0 };
const vEl = $("#viewer"), vImg = $("#viewerImg"), vStage = $("#viewerStage");

function applyView() {
  vImg.style.transform = `translate(-50%, -50%) translate(${V.x}px, ${V.y}px) rotate(${V.r}deg) scale(${V.s})`;
  $("#viewerZoom").textContent = toBn(Math.round(V.s * 100)) + "%";
}
function resetView() { Object.assign(V, { s: 1, r: 0, x: 0, y: 0 }); applyView(); }
function zoomBy(f) { V.s = Math.min(8, Math.max(0.5, V.s * f)); applyView(); }
async function showImage(i) {
  if (!viewerList.length) return;
  V.i = (i + viewerList.length) % viewerList.length;
  const idx = V.i;
  const f = viewerList[idx];
  $("#viewerTitle").textContent = (f.caption || f.file_name || "ছবি") + `  (${toBn(idx + 1)}/${toBn(viewerList.length)})`;
  vEl.querySelectorAll(".viewer-nav").forEach((b) => (b.hidden = viewerList.length < 2));
  resetView();
  // Small picture first, then the full-size one
  const quick = fullCache.get(f.id) || f.thumb;
  if (quick) vImg.src = quick; else vImg.removeAttribute("src");
  if (!fullCache.has(f.id)) {
    $("#viewerLoading").hidden = false;
    try {
      const url = await getFull(f);
      if (V.i === idx && !vEl.hidden) vImg.src = url;
    } catch (err) { toast(bnError(err), "err"); }
    if (V.i === idx) $("#viewerLoading").hidden = true;
  } else {
    $("#viewerLoading").hidden = true;
  }
}

// The phone's Back button closes the viewer instead of leaving the page
function openViewer(i) {
  vEl.hidden = false;
  document.body.style.overflow = "hidden";
  history.pushState({ viewer: true }, "");
  showImage(i);
}
function hideViewer() { vEl.hidden = true; document.body.style.overflow = ""; vImg.removeAttribute("src"); }
function closeViewer() { if (!vEl.hidden) history.back(); }
window.addEventListener("popstate", () => { if (!vEl.hidden) hideViewer(); });

vEl.addEventListener("click", (e) => {
  const b = e.target.closest("[data-v]");
  if (!b) return;
  const a = b.dataset.v;
  if (a === "close") closeViewer();
  else if (a === "zoomin") zoomBy(1.3);
  else if (a === "zoomout") zoomBy(1 / 1.3);
  else if (a === "rotate") { V.r = (V.r + 90) % 360; applyView(); }
  else if (a === "reset") resetView();
  else if (a === "download") downloadFile(viewerList[V.i]);
  else if (a === "prev") showImage(V.i - 1);
  else if (a === "next") showImage(V.i + 1);
});
vStage.addEventListener("wheel", (e) => { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12); }, { passive: false });
vStage.addEventListener("dblclick", () => { V.s > 1 ? resetView() : (V.s = 2.5, applyView()); });

// Drag with one finger/mouse, pinch with two fingers
const ptrs = new Map();
let pinch = null;
vStage.addEventListener("pointerdown", (e) => {
  vStage.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  vStage.classList.add("dragging");
  if (ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: V.s };
  }
});
vStage.addEventListener("pointermove", (e) => {
  const prev = ptrs.get(e.pointerId);
  if (!prev) return;
  const now = { x: e.clientX, y: e.clientY };
  ptrs.set(e.pointerId, now);
  if (ptrs.size === 2 && pinch) {
    const [a, b] = [...ptrs.values()];
    V.s = Math.min(8, Math.max(0.5, pinch.s * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d)));
  } else if (ptrs.size === 1) {
    V.x += now.x - prev.x;
    V.y += now.y - prev.y;
  }
  applyView();
});
const endPtr = (e) => {
  ptrs.delete(e.pointerId);
  if (ptrs.size < 2) pinch = null;
  if (!ptrs.size) vStage.classList.remove("dragging");
};
vStage.addEventListener("pointerup", endPtr);
vStage.addEventListener("pointercancel", endPtr);
document.addEventListener("keydown", (e) => {
  if (vEl.hidden) return;
  if (e.key === "Escape") closeViewer();
  else if (e.key === "ArrowRight") showImage(V.i + 1);
  else if (e.key === "ArrowLeft") showImage(V.i - 1);
  else if (e.key === "+" || e.key === "=") zoomBy(1.3);
  else if (e.key === "-") zoomBy(1 / 1.3);
});

// ---------- Top menu: space meter, refresh, backup, logout ----------
const menu = $("#menu");
$("#menuBtn").onclick = async (e) => {
  e.stopPropagation();
  menu.hidden = !menu.hidden;
  if (!menu.hidden) {
    try {
      const used = await getUsage();
      const pct = Math.min(100, (used / QUOTA) * 100);
      const box = $("#usage");
      box.classList.toggle("warn", pct > 85);
      box.innerHTML = `জায়গা ব্যবহৃত: ${fmtMB(used)} / ১ GB (প্রায় ${toBn(Math.round(pct))}%)
        <div class="bar"><i style="width:${pct}%"></i></div>`;
    } catch { $("#usage").textContent = "জায়গার হিসাব পাওয়া যায়নি"; }
  }
};
menu.addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", () => (menu.hidden = true));
menu.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", async () => {
  menu.hidden = true;
  const act = b.dataset.act;
  if (act === "logout") {
    await signOut(auth);
    records = null;
    location.hash = "#/";
  } else if (act === "refresh") {
    if (location.hash && location.hash !== "#/") location.hash = "#/";
    else route();
  } else if (act === "export") exportCSV();
}));

// Backup: every record + notes as a CSV file (opens in Excel with Bangla)
async function exportCSV() {
  toast("ফাইল তৈরি হচ্ছে…");
  try {
    const recs = await loadRecords();
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const head = [...FIELDS.map((f) => f.l), "নোট", "তৈরির তারিখ"];
    const rows = [];
    for (const r of recs) {
      const notes = await loadNotes(r.id);
      rows.push([
        ...FIELDS.map((f) => r[f.k]),
        notes.map((n) => `[${fmtDate(n.created_at)}] ${n.content}`).join("\n"),
        fmtDate(r.created_at),
      ]);
    }
    const csv = "﻿" + [head, ...rows].map((row) => row.map(cell).join(",")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `jomir-file-backup-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } catch (err) { toast(bnError(err), "err"); }
}

// ---------- Start ----------
app.innerHTML = loadingHTML();
onAuthStateChanged(auth, (u) => {
  user = u;
  if (!u) records = null;
  route();
});
