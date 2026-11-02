// Avery & Kodie's Wedding Plan: backend API (public: anyone with the link can view and edit)
// One Netlify Function handles every /api/* route and stores data in Netlify Blobs.
import { getStore } from "@netlify/blobs";
import { randomUUID } from "node:crypto";

export const config = { path: "/api/*" };

const data = () => getStore({ name: "wedding", consistency: "strong" });
const photos = () => getStore({ name: "wedding-photos", consistency: "strong" });

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const bad = (msg, status = 400) => json({ error: msg }, status);
const str = (v, max = 500) => String(v == null ? "" : v).slice(0, max);
const DEFAULTS = {
  plan: { plan: null, favs: {}, notes: {}, removed: {} },
  mood: { sections: [] },
  guests: { list: [] },
  vendors: { list: [] },
  activity: { items: [] },
  presence: { who: {} }
};
const AREAS = ["plan", "mood", "guests", "vendors", "activity"];

// ---- storage helpers ----
async function read(key){
  const r = await data().getWithMetadata(key, { type: "json" });
  return r ? r : { data: structuredClone(DEFAULTS[key]), etag: null };
}
// Read-modify-write with optimistic concurrency, so two people saving at once never overwrite each other.
async function mutate(key, fn){
  const store = data();
  for (let attempt = 0; attempt < 10; attempt++){
    const cur = await read(key);
    const next = structuredClone(cur.data);
    if (fn(next) === false) return cur.data;
    next.rev = (cur.data.rev || 0) + 1;
    next.updatedAt = Date.now();
    const w = await store.setJSON(key, next, cur.etag ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (w.modified) return next;
    await new Promise(r => setTimeout(r, 30 + Math.random() * 150));
  }
  throw new Error("Lots of saving at once. Try that again.");
}
async function log(text){
  if (!text) return;
  try { await mutate("activity", a => { a.items = [{ text: str(text, 200), at: Date.now() }, ...(a.items || [])].slice(0, 80); }); } catch(e){}
}
const id = () => randomUUID().replace(/-/g, "").slice(0, 16);

// ---- routes ----
export default async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "").split("/");
  try {
    if (req.method === "GET" && route[0] === "photo") return getPhoto(route[1]);
    if (req.method === "GET" && route[0] === "state") return getState(req, url);
    if (req.method === "POST" && route[0] === "photo") return postPhoto(req);
    if (req.method !== "POST") return bad("Not found", 404);
    const body = await req.json().catch(() => ({}));
    if (route[0] === "plan") return postPlan(body);
    if (route[0] === "mood") return postMood(body);
    if (route[0] === "guests") return postGuests(body);
    if (route[0] === "vendors") return postVendors(body);
    return bad("Not found", 404);
  } catch(e){
    return bad(e.message || "Something went wrong.", 500);
  }
};

// GET /api/state?have=plan:3,mood:5&c=<browser id> returns only what changed since those revisions.
async function getState(req, url){
  const have = Object.fromEntries((url.searchParams.get("have") || "").split(",").filter(Boolean).map(p => p.split(":")).map(([k, v]) => [k, Number(v)]));
  const recs = await Promise.all(AREAS.map(a => read(a)));
  const out = { ok: true, rev: {} };
  AREAS.forEach((a, i) => { const d = recs[i].data; out.rev[a] = d.rev || 0; if (have[a] !== out.rev[a]) out[a] = d; });
  // Presence: how many browsers have the site open right now.
  const client = str(url.searchParams.get("c"), 40).replace(/[^a-z0-9]/gi, "");
  let pres = (await read("presence")).data;
  if (client && url.searchParams.get("ping")){
    try { pres = await mutate("presence", p => { p.who = p.who || {}; p.who[client] = Date.now(); for (const k in p.who) if (Date.now() - p.who[k] > 90000) delete p.who[k]; }); } catch(e){}
  }
  out.online = Object.values(pres.who || {}).filter(t => Date.now() - t < 45000).length;
  return json(out);
}

async function postPlan(body){
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
  await log(body.note);
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

async function postMood(b){
  let note = "", removedPhotos = [];
  const next = await mutate("mood", m => {
    m.sections = m.sections || [];
    const sec = b.id ? m.sections.find(s => s.id === b.id) : null;
    switch (b.op){
      case "init":
        if (m.sections.length) return false;
        m.sections = DEFAULT_SECTIONS.map(([n, h]) => newSection(n, h)); note = "Started the mood board"; break;
      case "addSection":
        if (!str(b.name).trim()) return false;
        m.sections.push(newSection(b.name)); note = `Added a mood board section "${str(b.name, 80)}"`; break;
      case "update": {
        if (!sec) return false;
        const p = b.patch || {};
        if ("name" in p && str(p.name).trim()) sec.name = str(p.name, 80);
        if ("notes" in p) sec.notes = str(p.notes, 4000);
        note = "name" in p ? `Renamed a section to "${sec.name}"` : `Updated notes in ${sec.name}`; break; }
      case "push": {
        if (!sec || !["colors", "links"].includes(b.field)) return false;
        const v = str(b.value, 500);
        if (b.field === "colors" && !/^#[0-9a-f]{6}$/i.test(v)) return false;
        if (b.field === "links" && !/^https?:\/\//i.test(v)) return false;
        if (sec[b.field].includes(v)) return false;
        sec[b.field].push(v); note = `Added a ${b.field === "colors" ? "color" : "link"} to ${sec.name}`; break; }
      case "pull":
        if (!sec || !["colors", "links"].includes(b.field)) return false;
        sec[b.field] = sec[b.field].filter(x => x !== b.value); break;
      case "addPhotos":
        if (!sec || !Array.isArray(b.photos)) return false;
        b.photos.slice(0, 50).forEach(p => sec.photos.push({ id: str(p.id, 40), caption: "", at: Date.now() }));
        note = `Added ${b.photos.length} photo${b.photos.length === 1 ? "" : "s"} to ${sec.name}`; break;
      case "caption": {
        const p = sec && sec.photos.find(x => x.id === b.photoId); if (!p) return false;
        p.caption = str(b.caption, 300); break; }
      case "deletePhoto": {
        if (!sec) return false;
        const before = sec.photos.length;
        sec.photos = sec.photos.filter(x => x.id !== b.photoId);
        if (sec.photos.length === before) return false;
        removedPhotos = [b.photoId]; note = `Removed a photo from ${sec.name}`; break; }
      case "move": {
        const i = m.sections.findIndex(s => s.id === b.id), j = i + (b.dir === "up" ? -1 : 1);
        if (i < 0 || j < 0 || j >= m.sections.length) return false;
        [m.sections[i], m.sections[j]] = [m.sections[j], m.sections[i]]; break; }
      case "deleteSection":
        if (!sec) return false;
        removedPhotos = sec.photos.map(p => p.id);
        m.sections = m.sections.filter(s => s.id !== b.id); note = `Deleted the "${sec.name}" section`; break;
      default: return false;
    }
  });
  for (const pid of removedPhotos){ try { await photos().delete(pid); } catch(e){} }
  await log(note);
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

const GUEST_FIELDS = { name: 120, size: 0, side: 10, group: 60, invited: 0, rsvp: 10, lodging: 0, notes: 1000 };
function cleanGuest(g){
  const out = {};
  for (const [k, max] of Object.entries(GUEST_FIELDS)){
    if (!(k in g)) continue;
    if (["invited", "lodging"].includes(k)) out[k] = !!g[k];
    else if (k === "size") out[k] = Math.max(1, Math.min(50, Math.round(Number(g[k]) || 1)));
    else if (k === "rsvp") out[k] = ["pending", "yes", "no"].includes(g[k]) ? g[k] : "pending";
    else if (k === "side") out[k] = ["Avery", "Kodie", "Both"].includes(g[k]) ? g[k] : "Both";
    else out[k] = str(g[k], max);
  }
  return out;
}
async function postGuests(b){
  let note = "";
  const next = await mutate("guests", G => {
    G.list = G.list || [];
    if (b.op === "add"){
      const add = (b.guests || []).slice(0, 500).map(g => Object.assign({ id: id(), size: 1, side: "Both", group: "", invited: false, rsvp: "pending", lodging: false, notes: "", created: Date.now() }, cleanGuest(g))).filter(g => g.name && g.name.trim());
      if (!add.length || G.list.length + add.length > 2000) return false;
      G.list.push(...add); note = add.length === 1 ? `Added ${add[0].name} to the guest list` : `Added ${add.length} guests`;
    } else if (b.op === "update"){
      const g = G.list.find(x => x.id === b.id); if (!g) return false;
      const patch = cleanGuest(b.patch || {});
      if ("name" in patch && !patch.name.trim()) delete patch.name;
      Object.assign(g, patch);
      if ("rsvp" in patch) note = `Marked ${g.name} as ${{ yes: "coming", no: "can't come", pending: "waiting" }[patch.rsvp]}`;
    } else if (b.op === "delete"){
      const g = G.list.find(x => x.id === b.id); if (!g) return false;
      G.list = G.list.filter(x => x.id !== b.id); note = `Removed ${g.name} from the guest list`;
    } else return false;
  });
  await log(note);
  return json(next);
}

// ---- your own vendors ----
const VENDOR_CATS = ["Venue", "Food", "Bar", "Music", "Photographer", "Videographer", "Florist", "Cake & desserts", "Attire", "Hair & makeup", "Officiant", "Rentals & decor", "Lodging", "Transportation", "Invitations", "Other"];
const VENDOR_STATUS = ["Researching", "Contacted", "Quote received", "Booked", "Not a fit"];
const VENDOR_FIELDS = { name: 120, category: 30, status: 30, contact: 120, phone: 40, email: 120, url: 500, where: 120, price: 120, cost: 0, inBudget: 0, notes: 3000 };
function cleanVendor(v){
  const out = {};
  for (const [k, max] of Object.entries(VENDOR_FIELDS)){
    if (!(k in v)) continue;
    if (k === "inBudget") out.inBudget = !!v.inBudget;
    else if (k === "cost") out.cost = Math.max(0, Math.min(1000000, Math.round(Number(v.cost) || 0)));
    else if (k === "category") out.category = VENDOR_CATS.includes(v.category) ? v.category : "Other";
    else if (k === "status") out.status = VENDOR_STATUS.includes(v.status) ? v.status : "Researching";
    else if (k === "url"){ const u = str(v.url, max).trim(); out.url = !u ? "" : /^https?:\/\//i.test(u) ? u : "https://" + u; }
    else out[k] = str(v[k], max);
  }
  return out;
}
async function postVendors(b){
  let note = "";
  const next = await mutate("vendors", V => {
    V.list = V.list || [];
    if (b.op === "add"){
      const v = Object.assign({ id: id(), category: "Other", status: "Researching", created: Date.now() }, cleanVendor(b.vendor || {}));
      if (!v.name || !v.name.trim() || V.list.length >= 1000) return false;
      V.list.push(v); note = `Added ${v.name} to the vendors (${v.category})`;
    } else if (b.op === "update"){
      const v = V.list.find(x => x.id === b.id); if (!v) return false;
      const patch = cleanVendor(b.patch || {});
      if ("name" in patch && !patch.name.trim()) delete patch.name;
      const was = v.status;
      Object.assign(v, patch);
      note = patch.status && patch.status !== was ? `Marked ${v.name} as ${v.status}` : "inBudget" in patch && Object.keys(patch).length === 1 ? (patch.inBudget ? `Added ${v.name} to the budget` : `Took ${v.name} out of the budget`) : `Updated ${v.name}`;
    } else if (b.op === "delete"){
      const v = V.list.find(x => x.id === b.id); if (!v) return false;
      V.list = V.list.filter(x => x.id !== b.id); note = `Removed ${v.name} from the vendors`;
    } else return false;
  });
  await log(note);
  return json(next);
}
