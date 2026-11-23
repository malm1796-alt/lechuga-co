// Pasa el catálogo de la caja (modelos con precio, colores y tallas) al bot de WhatsApp y lo vuelve a subir.
// Lo llama el servidor después de publicar la página. También se puede correr a mano: node server\bot-sync.js
const fs = require("node:fs");
const path = require("node:path");
const { exec } = require("node:child_process");
const { db, ROOT } = require("./db");

const BOT = path.join(ROOT, "bot-whatsapp", "starter");
const CONFIG = path.join(BOT, "member", "config.local.ts");
const WRANGLER = path.join(BOT, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");

function catalogForBot() {
  const rows = db.prepare("SELECT name, category, color, size, price, description FROM products WHERE active = 1 AND price > 0 ORDER BY name, color, size").all();
  const m = new Map();
  for (const r of rows) {
    const g = m.get(r.name) || { name: r.name, price: r.price, cat: r.category || "", colors: new Set(), sizes: new Set(), desc: r.description || "" };
    if (r.color) g.colors.add(r.color);
    if (r.size) g.sizes.add(r.size);
    g.price = Math.min(g.price, r.price);
    m.set(r.name, g);
  }
  return [...m.values()].map(g => ({ name: g.name, price: g.price,
    description: `${g.cat} · colores: ${[...g.colors].join(", ")} · tallas ${[...g.sizes].join(", ")} · ${g.desc}`.slice(0, 900) }));
}

// Devuelve true si el catálogo del bot cambió (y hay que subirlo).
function writeCatalog() {
  if (!fs.existsSync(CONFIG)) return false;
  const src = fs.readFileSync(CONFIG, "utf8");
  const re = /export const catalog:([^=]*)= \[[\s\S]*?\];\s*$/;
  if (!re.test(src)) return false;
  const next = src.replace(re, `export const catalog:$1= ${JSON.stringify(catalogForBot(), null, 2)};\n`);
  if (next === src) return false;
  fs.writeFileSync(CONFIG, next);
  return true;
}

let running = null;
function syncBot() {
  if (process.env.LECHUGA_DB) return Promise.resolve({ ok: true, skipped: "modo de prueba" });
  if (!fs.existsSync(WRANGLER)) return Promise.resolve({ ok: false, skipped: "no está instalado el bot" });
  if (running) return running;
  running = new Promise(resolve => {
    if (!writeCatalog()) return resolve({ ok: true, skipped: "sin cambios" });
    exec(`"${WRANGLER}" deploy`, { cwd: BOT, windowsHide: true, timeout: 5 * 60e3 },
      (err, stdout, stderr) => resolve(err ? { ok: false, error: (stderr || err.message).slice(-400) } : { ok: true, deployed: true }));
  }).finally(() => { running = null; });
  return running;
}

module.exports = { syncBot, catalogForBot };

if (require.main === module) syncBot().then(r => { console.log(r); process.exit(r.ok ? 0 : 1); });
