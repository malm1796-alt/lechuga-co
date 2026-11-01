// Carga la lista de productos de entrada\productos.csv (y sus fotos de entrada\fotos) a la base de datos.
// Uso: node server\importar.js            muestra qué se va a cargar, sin cambiar nada
//      node server\importar.js --aplicar  lo carga
// Una prenda que ya existe (mismo código) actualiza nombre, precio, costo, foto, etc., pero NO sus existencias:
// esas cambian con compras o ajustes, para que los reportes cuadren.
const fs = require("node:fs");
const path = require("node:path");
const { db, ROOT, getSettings, saveSettings } = require("./db");

const DIR = path.join(ROOT, "entrada");
const FILE = process.argv.find(a => a.endsWith(".csv")) || path.join(DIR, "productos.csv");
const APPLY = process.argv.includes("--aplicar");
const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const MAX_PHOTO = 6 * 1024 * 1024;

// Excel en español puede guardar el CSV en UTF-8 o en ANSI, separado por comas o por punto y coma.
function readText(file) {
  const buf = fs.readFileSync(file);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { text = new TextDecoder("windows-1252").decode(buf); }
  return text.replace(/^﻿/, "");
}
function parseCSV(text) {
  const first = text.split(/\r?\n/, 1)[0];
  const sep = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ";" : ",";
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}
const key = s => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
// "$1,299.00", "1299,50" y "1 299" se leen como número.
function money(v) {
  let s = String(v || "").replace(/[$\s]/g, "");
  if (!s) return null;
  if (s.includes(",") && s.includes(".")) s = s.replace(/,/g, "");
  else if (/,\d{1,2}$/.test(s)) s = s.replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}
const slug = s => key(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

if (!fs.existsSync(FILE)) { console.log(`\n  No encuentro ${FILE}\n`); process.exit(1); }
const rows = parseCSV(readText(FILE));
const head = rows.shift().map(key);
const col = name => head.indexOf(name);
const need = ["nombre", "talla", "precio"];
const missing = need.filter(n => col(n) < 0);
if (missing.length) { console.log(`\n  Al archivo le faltan las columnas: ${missing.join(", ")}\n`); process.exit(1); }
const get = (r, n) => (col(n) >= 0 ? String(r[col(n)] ?? "").trim() : "");

const ok = [], skipped = [], warnings = [], ids = new Set();
rows.forEach((r, i) => {
  const line = i + 2, name = get(r, "nombre");
  if (!name) { skipped.push(`Renglón ${line}: sin nombre`); return; }
  const label = `${name} ${get(r, "color")} ${get(r, "talla")}`.replace(/\s+/g, " ").trim();
  const price = money(get(r, "precio")), cost = money(get(r, "costo")), pcs = money(get(r, "piezas"));
  if (price === null) { skipped.push(`Renglón ${line}: ${label} — sin precio`); return; }
  if (Number.isNaN(price) || price <= 0) { skipped.push(`Renglón ${line}: ${label} — el precio «${get(r, "precio")}» no es un número`); return; }
  if (Number.isNaN(cost) || Number.isNaN(pcs)) { skipped.push(`Renglón ${line}: ${label} — revisa costo o piezas`); return; }
  let id = (get(r, "codigo") || slug(`${name}-${get(r, "color")}-${get(r, "talla")}`)).replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 64);
  if (ids.has(id)) { skipped.push(`Renglón ${line}: ${label} — el código ${id} está repetido`); return; }
  ids.add(id);
  if (!cost) warnings.push(`${label}: sin costo (la utilidad saldrá inflada)`);
  if (cost && cost >= price) warnings.push(`${label}: el costo (${cost}) es mayor o igual al precio (${price})`);
  let photo = null;
  const foto = get(r, "foto");
  if (foto) {
    const f = path.join(DIR, "fotos", path.basename(foto)), mime = MIME[path.extname(f).toLowerCase()];
    if (!fs.existsSync(f)) warnings.push(`${label}: no encuentro la foto ${foto}`);
    else if (!mime) warnings.push(`${label}: la foto ${foto} debe ser JPG, PNG o WEBP`);
    else if (fs.statSync(f).size > MAX_PHOTO) warnings.push(`${label}: la foto ${foto} pesa más de 6 MB`);
    else photo = { file: f, mime };
  }
  ok.push({ id, name, sku: get(r, "codigo"), category: get(r, "categoria"), season: get(r, "temporada"), color: get(r, "color"),
    size: get(r, "talla"), price, cost: cost || 0, pcs: Math.max(0, Math.round(pcs || 0)), desc: get(r, "descripcion"), photo });
});

const exists = new Set(db.prepare("SELECT id FROM products").all().map(p => p.id));
const nuevos = ok.filter(p => !exists.has(p.id)), cambios = ok.filter(p => exists.has(p.id));
const st = getSettings();
const newCats = [...new Set(ok.map(p => p.category).filter(c => c && !st.categories.includes(c)))];
const newSeasons = [...new Set(ok.map(p => p.season).filter(c => c && !st.seasons.includes(c)))];
const models = new Set(ok.map(p => p.name)), photos = new Set(ok.filter(p => p.photo).map(p => p.photo.file));
const money2 = n => "$" + n.toLocaleString("es-MX", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

console.log(`\n  Lechuga & Co. — importar productos  (${path.basename(FILE)})\n`);
console.log(`  Listos para cargar:  ${ok.length} renglones · ${models.size} modelos · ${photos.size} fotos`);
console.log(`    Nuevos:            ${nuevos.length} (piezas iniciales: ${nuevos.reduce((a, p) => a + p.pcs, 0)}, valor a costo ${money2(nuevos.reduce((a, p) => a + p.pcs * p.cost, 0))})`);
if (cambios.length) console.log(`    Ya existían:       ${cambios.length} (se actualizan datos; sus existencias no cambian)`);
if (newCats.length) console.log(`    Categorías nuevas: ${newCats.join(", ")}`);
if (newSeasons.length) console.log(`    Temporadas nuevas: ${newSeasons.join(", ")}`);
if (skipped.length) { console.log(`\n  Se omiten ${skipped.length}:`); skipped.slice(0, 25).forEach(s => console.log("    · " + s)); if (skipped.length > 25) console.log(`    · …y ${skipped.length - 25} más`); }
if (warnings.length) { console.log(`\n  Avisos (${warnings.length}):`); warnings.slice(0, 25).forEach(s => console.log("    · " + s)); if (warnings.length > 25) console.log(`    · …y ${warnings.length - 25} más`); }

if (!APPLY) { console.log(`\n  No se cambió nada. Para cargar: node server\\importar.js --aplicar\n`); process.exit(0); }
if (!ok.length) { console.log("\n  No hay nada que cargar.\n"); process.exit(0); }

const now = Date.now(), cache = new Map();
const ins = db.prepare(`INSERT INTO products(id, sku, name, category, season, size, color, price, cost, cost0, stock0, description, active, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)`);
const upd = db.prepare("UPDATE products SET sku=?, name=?, category=?, season=?, size=?, color=?, price=?, cost=?, description=?, active=1 WHERE id=?");
const pho = db.prepare(`INSERT INTO photos(product_id, jpeg, mime, updated_at) VALUES (?,?,?,?)
  ON CONFLICT(product_id) DO UPDATE SET jpeg = excluded.jpeg, mime = excluded.mime, updated_at = excluded.updated_at`);
db.exec("BEGIN");
try {
  for (const p of ok) {
    if (exists.has(p.id)) upd.run(p.sku, p.name, p.category, p.season, p.size, p.color, p.price, p.cost, p.desc, p.id);
    else ins.run(p.id, p.sku, p.name, p.category, p.season, p.size, p.color, p.price, p.cost, p.cost, p.pcs, p.desc, now);
    if (p.photo) {
      if (!cache.has(p.photo.file)) cache.set(p.photo.file, fs.readFileSync(p.photo.file));
      pho.run(p.id, cache.get(p.photo.file), p.photo.mime, now);
    }
  }
  saveSettings({ ...st, categories: [...st.categories, ...newCats], seasons: [...st.seasons, ...newSeasons] });
  db.exec("COMMIT");
} catch (e) { db.exec("ROLLBACK"); console.log("\n  No se cargó nada: " + e.message + "\n"); process.exit(1); }
console.log(`\n  Listo: ${nuevos.length} nuevos y ${cambios.length} actualizados. La caja los muestra en unos segundos.`);
console.log(`  Para que salgan en la página web: Conexiones → Publicar página web.\n`);
