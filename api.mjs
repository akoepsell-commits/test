// Avery & Kodie's Wedding Plan: backend API
// One Netlify Function handles every /api/* route and stores data in Netlify Blobs.
import { getStore } from "@netlify/blobs";
import { randomUUID, timingSafeEqual, createHash } from "node:crypto";

export const config = { path: "/api/*" };

const data = () => getStore({ name: "wedding", consistency: "strong" });
const photos = () => getStore({ name: "wedding-photos", consistency: "strong" });

const env = k => (globalThis.Netlify && Netlify.env && Netlify.env.get(k)) || process.env[k] || "";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const bad = (msg, status = 400) => json({ error: msg }, status);
const str = (v, max = 500) => String(v == null ? "" : v).slice(0, max);
const AREAS = ["settings", "plan", "mood", "guests", "activity"];
const DEFAULTS = {
  settings: { title: "Avery & Kodie's Wedding", date: "", place: "Glacier Hills County Park · Hubertus, Wisconsin", message: "We can't wait to celebrate with you. Please let us know if you can make it.", rsvpBy: "", rsvpOpen: true, publicPlan: false },
  plan: { plan: null, favs: {}, notes: {}, removed: {} },
  mood: { sections: [] },
  guests: { list: [] },
  activity: { items: [] },
  presence: { who: {} }
};

// ---- auth ----
function sha(s){ return createHash("sha256").update(String(s)).digest(); }
function isEditor(req){
  const pass = env("EDIT_PASSCODE");
  if (!pass) return false;
  const given = req.headers.get("x-pass") || "";
  return timingSafeEqual(sha(given), sha(pass));
}
const who = req => str(req.headers.get("x-name") || "Someone", 40).trim() || "Someone";

// ---- storage helpers ----
async function read(key){
  const r = await data().getWithMetadata(key, { type: "json" });
  return r ? r : { data: structuredClone(DEFAULTS[key]), etag: null };
}
// Read-modify-write with optimistic concurrency, so two people editing at once don't overwrite each other.
async function mutate(key, fn){
  const store = data();
  for (let attempt = 0; attempt < 8; attempt++){
    const cur = await read(key);
    const next = structuredClone(cur.data);
    const result = fn(next);
    if (result === false) return cur.data;
    next.rev = (cur.data.rev || 0) + 1;
    next.updatedAt = Date.now();
    const opts = cur.etag ? { onlyIfMatch: cur.etag } : { onlyIfNew: true };
    const w = await store.setJSON(key, next, opts);
    if (w.modified) return next;
    await new Promise(r => setTimeout(r, 40 + Math.random() * 120));
  }
  throw new Error("Too many people saving at once. Try again.");
}
async function log(req, text){
  try {
    await mutate("activity", a => {
      a.items = [{ who: who(req), text: str(text, 200), at: Date.now() }, ...(a.items || [])].slice(0, 60);
    });
  } catch(e){}
}
const id = () => randomUUID().replace(/-/g, "").slice(0, 16);

// ---- routes ----
export default async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "").split("/");
  const method = req.method;
  try {
    if (route[0] === "photo" && method === "GET") return getPhoto(route[1]);
    if (route[0] === "state" && method === "GET") return getState(req, url);
    if (route[0] === "login" && method === "POST"){
      if (!env("EDIT_PASSCODE")) return bad("The site's passcode hasn't been set up yet. Add EDIT_PASSCODE in Netlify's environment variables.", 500);
      if (!isEditor(req)) return bad("That passcode isn't right.", 401);
      await log(req, "signed in");
      return json({ ok: true });
    }
    if (route[0] === "rsvp" && method === "POST") return postRsvp(req);

    // Everything below needs the passcode.
    if (!isEditor(req)) return bad("Sign in to make changes.", 401);
    const body = route[0] === "photo" ? null : await req.json().catch(() => ({}));
    if (route[0] === "photo" && method === "POST") return postPhoto(req);
    if (route[0] === "plan" && method === "POST") return postPlan(req, body);
    if (route[0] === "mood" && method === "POST") return postMood(req, body);
    if (route[0] === "guests" && method === "POST") return postGuests(req, body);
    if (route[0] === "settings" && method === "POST") return postSettings(req, body);
    return bad("Not found", 404);
  } catch(e){
    return bad(e.message || "Something went wrong.", 500);
  }
};

// GET /api/state?have=plan:3,mood:5 returns only the parts that changed since those revisions.
async function getState(req, url){
  const editor = isEditor(req);
  const have = Object.fromEntries((url.searchParams.get("have") || "").split(",").filter(Boolean).map(p => p.split(":")).map(([k, v]) => [k, Number(v)]));
  const settingsRec = await read("settings");
  const settings = Object.assign({}, DEFAULTS.settings, settingsRec.data);
  const canSeePlan = editor || settings.publicPlan;
  const areas = ["plan", "mood"].filter(() => canSeePlan).concat(editor ? ["guests", "activity"] : []);
  const recs = await Promise.all(areas.map(a => read(a)));
  const out = { editor, configured: !!env("EDIT_PASSCODE"), rev: {}, settings: null };
  out.rev.settings = settings.rev || 0;
  if (have.settings !== out.rev.settings) out.settings = settings;
  areas.forEach((a, i) => {
    const d = recs[i].data; out.rev[a] = d.rev || 0;
    if (have[a] !== out.rev[a]) out[a] = d;
  });
  if (editor){
    const me = who(req);
    let pres = (await read("presence")).data;
    const last = (pres.who || {})[me] || 0;
    if (url.searchParams.get("ping") && Date.now() - last > 15000){
      try { pres = await mutate("presence", p => { p.who = p.who || {}; p.who[me] = Date.now(); for (const k in p.who) if (Date.now() - p.who[k] > 120000) delete p.who[k]; }); } catch(e){}
    }
    out.online = Object.entries(pres.who || {}).filter(([, t]) => Date.now() - t < 60000).map(([n]) => n);
  }
  return json(out);
}

async function postPlan(req, body){
  const next = await mutate("plan", p => {
    if (body.plan && typeof body.plan === "object"){
      p.plan = p.plan || {};
      for (const [k, v] of Object.entries(body.plan)) p.plan[k] = v;
    }
    for (const field of ["favs", "notes", "removed"]){
      if (body[field] && typeof body[field] === "object"){
        p[field] = p[field] || {};
        for (const [k, v] of Object.entries(body[field])){ if (v === null || v === false || v === "") delete p[field][k]; else p[field][k] = field === "notes" ? str(v, 4000) : v; }
      }
    }
  });
  if (body.note) await log(req, body.note);
  return json(next);
}

const DEFAULT_SECTIONS = [
  ["Overall vibe & colors","The feeling you want: colors, textures, season, words that fit."],
  ["Ceremony","Arch or backdrop, aisle, chairs, where you'll stand."],
  ["Reception & decor","Lighting, draping, signs, the hall or tent."],
  ["Tables & centerpieces","Linens, place settings, centerpieces, candles."],
  ["Flowers","Bouquets, boutonnieres, arch flowers. Fall picks: dahlias, mums, eucalyptus."],
  ["Our attire","Dress, suits, shoes, accessories."],
  ["Wedding party","Bridesmaid and groomsmen looks, colors."],
  ["Hair & makeup","Styles you like for the day."],
  ["Cake & desserts","Cake, cupcakes, pie or donut bar, late-night snacks."],
  ["Food & drinks","Menu ideas, food truck style, signature drinks."],
  ["Invitations & signs","Save the dates, invitations, welcome sign, seating chart."],
  ["Music & first dance","Song ideas, first dance, DJ requests."],
  ["Photo ideas","Shots you want, poses, group photos."],
  ["Guest weekend & cabins","Welcome bags, Friday and Sunday plans, lodging."]
];
const newSection = (name, hint = "") => ({ id: id(), name: str(name, 80), hint: str(hint, 200), notes: "", colors: [], links: [], photos: [] });

async function postMood(req, b){
  let note = "", removedPhotos = [];
  const next = await mutate("mood", m => {
    m.sections = m.sections || [];
    const sec = b.id ? m.sections.find(s => s.id === b.id) : null;
    switch (b.op){
      case "init":
        if (m.sections.length) return false;
        m.sections = DEFAULT_SECTIONS.map(([n, h]) => newSection(n, h)); note = "started the mood board"; break;
      case "addSection":
        if (!str(b.name).trim()) return false;
        m.sections.push(newSection(b.name)); note = `added a mood board section "${str(b.name, 80)}"`; break;
      case "update": {
        if (!sec) return false;
        const p = b.patch || {};
        if ("name" in p && str(p.name).trim()) sec.name = str(p.name, 80);
        if ("notes" in p) sec.notes = str(p.notes, 4000);
        if (!note) note = "name" in p ? `renamed a section to "${sec.name}"` : `updated notes in ${sec.name}`;
        break; }
      case "push": {
        if (!sec || !["colors", "links"].includes(b.field)) return false;
        const v = str(b.value, 500);
        if (b.field === "colors" && !/^#[0-9a-f]{6}$/i.test(v)) return false;
        if (b.field === "links" && !/^https?:\/\//i.test(v)) return false;
        if (sec[b.field].includes(v)) return false;
        sec[b.field].push(v); note = `added a ${b.field === "colors" ? "color" : "link"} to ${sec.name}`; break; }
      case "pull": {
        if (!sec || !["colors", "links"].includes(b.field)) return false;
        sec[b.field] = sec[b.field].filter(x => x !== b.value); break; }
      case "addPhotos": {
        if (!sec || !Array.isArray(b.photos)) return false;
        b.photos.slice(0, 50).forEach(p => sec.photos.push({ id: str(p.id, 40), caption: "", by: who(req), at: Date.now() }));
        note = `added ${b.photos.length} photo${b.photos.length === 1 ? "" : "s"} to ${sec.name}`; break; }
      case "caption": {
        const p = sec && sec.photos.find(x => x.id === b.photoId); if (!p) return false;
        p.caption = str(b.caption, 300); break; }
      case "deletePhoto": {
        if (!sec) return false;
        const before = sec.photos.length;
        sec.photos = sec.photos.filter(x => x.id !== b.photoId);
        if (sec.photos.length === before) return false;
        removedPhotos = [b.photoId]; note = `removed a photo from ${sec.name}`; break; }
      case "move": {
        const i = m.sections.findIndex(s => s.id === b.id), j = i + (b.dir === "up" ? -1 : 1);
        if (i < 0 || j < 0 || j >= m.sections.length) return false;
        [m.sections[i], m.sections[j]] = [m.sections[j], m.sections[i]]; break; }
      case "deleteSection": {
        if (!sec) return false;
        removedPhotos = sec.photos.map(p => p.id);
        m.sections = m.sections.filter(s => s.id !== b.id); note = `deleted the "${sec.name}" section`; break; }
      default: return false;
    }
  });
  for (const pid of removedPhotos){ try { await photos().delete(pid); } catch(e){} }
  if (note) await log(req, note);
  return json(next);
}

async function postPhoto(req){
  const type = req.headers.get("content-type") || "";
  if (!/^image\/(jpeg|png|webp|gif|heic|heif|avif)$/.test(type)) return bad("Photos must be JPG, PNG, WEBP, GIF or HEIC.");
  const buf = await req.arrayBuffer();
  if (!buf.byteLength) return bad("That photo was empty.");
  if (buf.byteLength > 5.5 * 1024 * 1024) return bad("That photo is too big. Try one under 5 MB.");
  const pid = id();
  await photos().set(pid, buf, { metadata: { type } });
  return json({ id: pid });
}
async function getPhoto(pid){
  if (!/^[a-f0-9]{16}$/.test(pid || "")) return bad("Not found", 404);
  const r = await photos().getWithMetadata(pid, { type: "arrayBuffer" });
  if (!r || !r.data) return bad("Not found", 404);
  return new Response(r.data, { headers: { "content-type": (r.metadata && r.metadata.type) || "image/jpeg", "cache-control": "public, max-age=31536000, immutable" } });
}

const GUEST_FIELDS = { name: 120, size: 0, side: 10, group: 60, invited: 0, rsvp: 10, coming: 0, lodging: 0, notes: 1000, reply: 1000, song: 200, contact: 200 };
function cleanGuest(g){
  const out = {};
  for (const [k, max] of Object.entries(GUEST_FIELDS)){
    if (!(k in g)) continue;
    if (["invited", "lodging"].includes(k)) out[k] = !!g[k];
    else if (["size", "coming"].includes(k)) out[k] = Math.max(0, Math.min(50, Math.round(Number(g[k]) || 0)));
    else if (k === "rsvp") out[k] = ["pending", "yes", "no"].includes(g[k]) ? g[k] : "pending";
    else if (k === "side") out[k] = ["Avery", "Kodie", "Both"].includes(g[k]) ? g[k] : "Both";
    else out[k] = str(g[k], max);
  }
  return out;
}
async function postGuests(req, b){
  let note = "";
  const next = await mutate("guests", G => {
    G.list = G.list || [];
    if (b.op === "add"){
      const add = (b.guests || []).slice(0, 500).map(g => Object.assign({ id: id(), size: 1, side: "Both", group: "", invited: false, rsvp: "pending", lodging: false, notes: "", created: Date.now() }, cleanGuest(g))).filter(g => g.name && g.name.trim());
      if (!add.length || G.list.length + add.length > 2000) return false;
      add.forEach(g => { if (!g.size) g.size = 1; });
      G.list.push(...add); note = add.length === 1 ? `added ${add[0].name} to the guest list` : `added ${add.length} guests`;
    } else if (b.op === "update"){
      const g = G.list.find(x => x.id === b.id); if (!g) return false;
      const patch = cleanGuest(b.patch || {});
      if ("name" in patch && !patch.name.trim()) delete patch.name;
      if ("size" in patch && !patch.size) patch.size = 1;
      Object.assign(g, patch);
      if ("rsvp" in patch) note = `marked ${g.name} as ${{ yes: "coming", no: "can't come", pending: "waiting" }[patch.rsvp]}`;
    } else if (b.op === "delete"){
      const g = G.list.find(x => x.id === b.id); if (!g) return false;
      G.list = G.list.filter(x => x.id !== b.id); note = `removed ${g.name} from the guest list`;
    } else return false;
  });
  if (note) await log(req, note);
  return json(next);
}

const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
async function postRsvp(req){
  const settings = Object.assign({}, DEFAULTS.settings, (await read("settings")).data);
  if (!settings.rsvpOpen) return bad("RSVPs are closed. Please reach out to Avery or Kodie directly.", 403);
  const b = await req.json().catch(() => ({}));
  if (b.website) return json({ ok: true }); // spam trap
  const name = str(b.name, 120).trim();
  if (name.length < 2) return bad("Please enter your name.");
  const attending = b.attending === "yes" ? "yes" : b.attending === "no" ? "no" : null;
  if (!attending) return bad("Please choose whether you can come.");
  const size = Math.max(1, Math.min(20, Math.round(Number(b.size) || 1)));
  const reply = [b.message, b.dietary ? "Food needs: " + b.dietary : ""].map(x => str(x, 500).trim()).filter(Boolean).join(" · ");
  let matched = false;
  await mutate("guests", G => {
    G.list = G.list || [];
    const g = G.list.find(x => norm(x.name) === norm(name));
    const patch = { rsvp: attending, coming: attending === "yes" ? size : 0, lodging: !!b.lodging, reply, song: str(b.song, 200), respondedAt: Date.now() };
    if (g){ matched = true; Object.assign(g, patch); if (attending === "yes" && size > (g.size || 1)) g.size = size; }
    else {
      if (G.list.length >= 2000) return false;
      G.list.push(Object.assign({ id: id(), name, size, side: "Both", group: "RSVP form", invited: false, notes: "", created: Date.now(), viaForm: true }, patch));
    }
  });
  const fakeReq = { headers: new Map([["x-name", name]]) }; fakeReq.headers.get = k => k === "x-name" ? name : null;
  await log(fakeReq, attending === "yes" ? `RSVP'd yes (${size})` : "RSVP'd no");
  return json({ ok: true, matched });
}

async function postSettings(req, b){
  const next = await mutate("settings", s => {
    Object.assign(s, DEFAULTS.settings, s);
    for (const k of ["title", "date", "place", "message", "rsvpBy"]) if (k in b) s[k] = str(b[k], k === "message" ? 1500 : 150);
    for (const k of ["rsvpOpen", "publicPlan"]) if (k in b) s[k] = !!b[k];
  });
  await log(req, "updated the site settings");
  return json(next);
}
