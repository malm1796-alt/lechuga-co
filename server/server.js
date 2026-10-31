// Servidor de Lechuga & Co.: API de la caja, datos para Power BI y publicación de la tienda en GitHub.
// Uso: node server\server.js   (o doble clic en iniciar.bat)
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { db, ROOT, getSettings, saveSettings, checkPassword, hashPassword, createUser } = require("./db");

const PORT = Number(process.env.PORT || 8787);
const DOCS = path.join(ROOT, "docs");
const SESSION_DAYS = 30;
const MAX_BODY = 8 * 1024 * 1024;
let version = Date.now();
const bump = () => { version = Date.now(); };

/* ---------- helpers ---------- */
function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf || typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": isBuf ? "application/octet-stream" : typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    ...headers,
  });
  res.end(data);
}
const fail = (res, status, message) => send(res, status, { error: message });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > MAX_BODY) { reject(new Error("too_large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(new Error("bad_json")); } });
    req.on("error", reject);
  });
}
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const str = (v, max = 300) => String(v ?? "").trim().slice(0, max);
const idOk = id => /^[A-Za-z0-9_-]{1,64}$/.test(id);

// Peticiones que llegan por el túnel traen cabeceras de Cloudflare; las de esta PC no.
function isLocal(req) {
  const ip = req.socket.remoteAddress || "";
  const loop = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  return loop && !req.headers["cf-connecting-ip"] && !req.headers["x-forwarded-for"];
}

/* ---------- sesiones ---------- */
const attempts = new Map();
function tooManyAttempts(key) {
  const now = Date.now(), list = (attempts.get(key) || []).filter(t => now - t < 15 * 60e3);
  attempts.set(key, list);
  return list.length >= 10;
}
function userFor(req) {
  const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || "");
  if (!m) return null;
  const row = db.prepare(`SELECT u.id, u.username, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires > ? AND u.active = 1`).get(m[1], Date.now());
  return row || null;
}

/* ---------- lectura del estado completo ---------- */
function state(user) {
  const photos = new Map(db.prepare("SELECT product_id, updated_at FROM photos").all().map(r => [r.product_id, r.updated_at]));
  const products = db.prepare("SELECT * FROM products").all().map(p => ({
    id: p.id, sku: p.sku, name: p.name, category: p.category, season: p.season, size: p.size, color: p.color,
    price: p.price, cost: p.cost, cost0: p.cost0, stock0: p.stock0, image: p.image_url, desc: p.description,
    active: !!p.active, createdAt: p.created_at, example: !!p.example, photo: photos.get(p.id) || null,
  }));
  const items = new Map();
  for (const i of db.prepare("SELECT * FROM sale_items").all()) {
    if (!items.has(i.sale_id)) items.set(i.sale_id, []);
    items.get(i.sale_id).push({ pid: i.product_id, name: i.name, size: i.size, qty: i.qty, price: i.price, cost: i.cost });
  }
  const sales = db.prepare("SELECT * FROM sales").all().map(s => ({
    id: s.id, ts: s.ts, subtotal: s.subtotal, total: s.total, method: s.method, channel: s.channel,
    customer: s.customer, phone: s.phone, example: !!s.example, items: items.get(s.id) || [],
  }));
  const expenses = db.prepare("SELECT * FROM expenses").all().map(e => ({ ...e, example: !!e.example }));
  const purchases = db.prepare("SELECT * FROM purchases").all().map(p => ({
    id: p.id, type: p.type, ts: p.ts, pid: p.product_id, qty: p.qty, unitCost: p.unit_cost, total: p.total,
    supplier: p.supplier, method: p.method, reason: p.reason, example: !!p.example,
  }));
  return { version, me: user, settings: getSettings(), products, sales, expenses, purchases };
}

/* ---------- escrituras ---------- */
function upsertProduct(id, b) {
  const old = db.prepare("SELECT * FROM products WHERE id = ?").get(id);
  const name = str(b.name, 150);
  if (!name) throw new Error("El producto necesita nombre");
  if (old) {
    db.prepare(`UPDATE products SET sku=?, name=?, category=?, season=?, size=?, color=?, price=?, cost=?, image_url=?, description=?, active=? WHERE id=?`)
      .run(str(b.sku, 60), name, str(b.category, 60), str(b.season, 60), str(b.size, 30), str(b.color, 40),
        num(b.price), num(b.cost), str(b.image, 500), str(b.desc, 1000), b.active === false ? 0 : 1, id);
  } else {
    db.prepare(`INSERT INTO products(id, sku, name, category, season, size, color, price, cost, cost0, stock0, image_url, description, active, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`)
      .run(id, str(b.sku, 60), name, str(b.category, 60), str(b.season, 60), str(b.size, 30), str(b.color, 40),
        num(b.price), num(b.cost), num(b.cost), Math.round(num(b.stock0)), str(b.image, 500), str(b.desc, 1000), Date.now());
  }
}
function insertSale(id, b, user) {
  if (db.prepare("SELECT 1 FROM sales WHERE id = ?").get(id)) return; // reintento de la misma venta
  const items = Array.isArray(b.items) ? b.items.filter(i => num(i.qty) > 0) : [];
  if (!items.length) throw new Error("La venta no tiene productos");
  const subtotal = items.reduce((a, i) => a + num(i.qty) * num(i.price), 0);
  const total = Math.max(0, Math.min(subtotal, num(b.total)));
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO sales(id, ts, subtotal, total, method, channel, customer, phone, user_id) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, num(b.ts) || Date.now(), subtotal, total, str(b.method, 30), str(b.channel, 30) || "Tienda", str(b.customer, 80), str(b.phone, 30), user.id);
    const ins = db.prepare("INSERT INTO sale_items(sale_id, product_id, name, size, qty, price, cost) VALUES (?,?,?,?,?,?,?)");
    for (const i of items) ins.run(id, str(i.pid, 64), str(i.name, 150), str(i.size, 30), Math.round(num(i.qty)), num(i.price), num(i.cost));
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
function upsertExpense(id, b, user) {
  const amount = num(b.amount);
  if (amount <= 0) throw new Error("El monto debe ser mayor a cero");
  db.prepare(`INSERT INTO expenses(id, ts, category, concept, amount, method, user_id) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET ts=excluded.ts, category=excluded.category, concept=excluded.concept, amount=excluded.amount, method=excluded.method`)
    .run(id, num(b.ts) || Date.now(), str(b.category, 60), str(b.concept, 200), amount, str(b.method, 30), user.id);
}
function insertPurchase(id, b, user) {
  const type = b.type === "ajuste" ? "ajuste" : "compra";
  const qty = Math.round(num(b.qty));
  if (!qty || (type === "compra" && qty < 0)) throw new Error("Revisa las piezas");
  if (!db.prepare("SELECT 1 FROM products WHERE id = ?").get(str(b.pid, 64))) throw new Error("Producto no encontrado");
  const unit = num(b.unitCost);
  db.prepare(`INSERT INTO purchases(id, type, ts, product_id, qty, unit_cost, total, supplier, method, reason, user_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, type, num(b.ts) || Date.now(), str(b.pid, 64), qty, unit, qty * unit, str(b.supplier, 120), str(b.method, 30), str(b.reason, 200), user.id);
  if (type === "compra" && unit > 0) db.prepare("UPDATE products SET cost = ? WHERE id = ?").run(unit, str(b.pid, 64));
}

/* ---------- publicar la tienda en GitHub ---------- */
function git(args) {
  return new Promise(resolve => execFile("git", ["-C", ROOT, ...args], { windowsHide: true, timeout: 120e3 },
    (err, stdout, stderr) => resolve({ ok: !err, out: (stdout + stderr).trim() })));
}
function stockMap() {
  const m = new Map(db.prepare("SELECT id, stock0 FROM products").all().map(r => [r.id, r.stock0]));
  for (const r of db.prepare("SELECT product_id, SUM(qty) q FROM purchases GROUP BY product_id").all()) m.set(r.product_id, (m.get(r.product_id) || 0) + r.q);
  for (const r of db.prepare("SELECT product_id, SUM(qty) q FROM sale_items GROUP BY product_id").all()) if (m.has(r.product_id)) m.set(r.product_id, m.get(r.product_id) - r.q);
  return m;
}
async function publishStore() {
  const st = getSettings(), sm = stockMap(), fotos = path.join(DOCS, "fotos");
  fs.mkdirSync(fotos, { recursive: true });
  const products = db.prepare("SELECT * FROM products WHERE active = 1 ORDER BY name").all();
  const keep = new Set();
  const items = products.map(p => {
    const ph = db.prepare("SELECT jpeg, updated_at FROM photos WHERE product_id = ?").get(p.id);
    let photo = "";
    if (ph) { photo = `fotos/${p.id}.jpg?v=${ph.updated_at}`; keep.add(`${p.id}.jpg`); fs.writeFileSync(path.join(fotos, `${p.id}.jpg`), ph.jpeg); }
    // Solo datos públicos: nunca costos, ventas ni existencias exactas.
    return { id: p.id, name: p.name, category: p.category || "", season: p.season || "", size: p.size || "", color: p.color || "",
      price: p.price, desc: p.description || "", photo, stock: Math.max(0, Math.min(3, sm.get(p.id) || 0)) };
  });
  for (const f of fs.readdirSync(fotos)) if (f.endsWith(".jpg") && !keep.has(f)) fs.unlinkSync(path.join(fotos, f));
  const catalog = { publishedAt: Date.now(), settings: { name: st.name, tagline: st.tagline, phone: st.phone, currency: st.currency }, items };
  fs.writeFileSync(path.join(DOCS, "catalogo.json"), JSON.stringify(catalog, null, 1));
  if (!fs.existsSync(path.join(ROOT, ".git"))) return { ok: true, pushed: false, message: "Catálogo generado. Falta conectar la carpeta con GitHub para subirlo." };
  await git(["add", "docs/catalogo.json", "docs/fotos"]);
  const c = await git(["commit", "-m", "Actualiza catálogo de la tienda"]);
  if (!c.ok && !/nothing to commit|nada para hacer commit/i.test(c.out)) return { ok: false, pushed: false, message: "No se pudo guardar el cambio en git: " + c.out.slice(0, 300) };
  const p = await git(["push"]);
  return p.ok ? { ok: true, pushed: true, message: "Tienda publicada. GitHub tarda 1 o 2 minutos en mostrar los cambios." }
    : { ok: false, pushed: false, message: "Se generó el catálogo pero no se pudo subir a GitHub: " + p.out.slice(0, 300) };
}

/* ---------- datos para Power BI (solo desde esta PC) ---------- */
const d2 = n => String(n).padStart(2, "0");
const fecha = ts => { const d = new Date(ts); return `${d.getFullYear()}-${d2(d.getMonth() + 1)}-${d2(d.getDate())}`; };
const hora = ts => { const d = new Date(ts); return `${d2(d.getHours())}:${d2(d.getMinutes())}`; };
const BI = {
  ventas: () => db.prepare("SELECT s.*, u.name vendedor FROM sales s LEFT JOIN users u ON u.id = s.user_id ORDER BY ts").all().map(s => ({
    venta_id: s.id, fecha: fecha(s.ts), hora: hora(s.ts), subtotal: s.subtotal, descuento: s.subtotal - s.total, total: s.total,
    forma_pago: s.method, canal: s.channel, cliente: s.customer || "", vendedor: s.vendedor || "", ejemplo: !!s.example })),
  partidas: () => db.prepare(`SELECT i.*, s.ts, s.subtotal, s.total, p.category, p.season, p.color FROM sale_items i
      JOIN sales s ON s.id = i.sale_id LEFT JOIN products p ON p.id = i.product_id ORDER BY s.ts`).all().map(i => {
    const f = i.subtotal ? i.total / i.subtotal : 1, importe = i.qty * i.price * f;
    return { venta_id: i.sale_id, fecha: fecha(i.ts), producto_id: i.product_id, producto: i.name, categoria: i.category || "",
      temporada: i.season || "", talla: i.size || "", color: i.color || "", piezas: i.qty, precio: i.price, importe,
      costo: i.qty * i.cost, utilidad_bruta: importe - i.qty * i.cost };
  }),
  gastos: () => db.prepare("SELECT * FROM expenses ORDER BY ts").all().map(e => ({
    gasto_id: e.id, fecha: fecha(e.ts), categoria: e.category, concepto: e.concept || "", monto: e.amount, forma_pago: e.method || "",
    es_retiro_dueno: e.category === "Retiro del dueño" })),
  compras: () => db.prepare("SELECT c.*, p.name producto FROM purchases c LEFT JOIN products p ON p.id = c.product_id ORDER BY ts").all().map(c => ({
    movimiento_id: c.id, tipo: c.type, fecha: fecha(c.ts), producto_id: c.product_id, producto: c.producto || "", piezas: c.qty,
    costo_unitario: c.unit_cost, total: c.total, proveedor: c.supplier || "", motivo: c.reason || "" })),
  productos: () => { const sm = stockMap(); return db.prepare("SELECT * FROM products ORDER BY name").all().map(p => ({
    producto_id: p.id, sku: p.sku || "", producto: p.name, categoria: p.category || "", temporada: p.season || "", talla: p.size || "",
    color: p.color || "", precio: p.price, costo: p.cost, existencias: sm.get(p.id) || 0, valor_inventario: Math.max(0, sm.get(p.id) || 0) * p.cost,
    activo: !!p.active })); },
};

/* ---------- archivos estáticos (docs/) ---------- */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.normalize(path.join(DOCS, rel));
  if (!file.startsWith(DOCS)) return fail(res, 403, "Ruta no permitida");
  fs.readFile(file, (err, data) => {
    if (err) return fail(res, 404, "No encontrado");
    send(res, 200, data, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
  });
}

/* ---------- rutas ---------- */
const COLS = { products: upsertProduct, expenses: upsertExpense };
async function route(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname, m = req.method;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (m === "OPTIONS") return send(res, 204, "");

  if (p.startsWith("/bi/")) {
    if (!isLocal(req)) return fail(res, 403, "Los datos de Power BI solo se leen desde esta PC");
    const fn = BI[p.slice(4)];
    return fn ? send(res, 200, fn()) : fail(res, 404, "Tabla no encontrada. Usa: " + Object.keys(BI).join(", "));
  }
  if (!p.startsWith("/api/")) return serveStatic(req, res, p === "/" ? "/index.html" : p);

  if (m === "GET" && p === "/api/salud") return send(res, 200, { ok: true, version });
  const photoGet = /^\/api\/fotos\/([A-Za-z0-9_-]+)$/.exec(p);
  if (m === "GET" && photoGet) {
    const ph = db.prepare("SELECT jpeg FROM photos WHERE product_id = ?").get(photoGet[1]);
    return ph ? send(res, 200, Buffer.from(ph.jpeg), { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000" }) : fail(res, 404, "Sin foto");
  }
  if (m === "POST" && p === "/api/login") {
    const ip = req.headers["cf-connecting-ip"] || req.socket.remoteAddress;
    if (tooManyAttempts(ip)) return fail(res, 429, "Demasiados intentos. Espera 15 minutos.");
    const b = await readBody(req);
    const u = db.prepare("SELECT * FROM users WHERE username = ? AND active = 1").get(str(b.username, 60).toLowerCase());
    if (!u || !checkPassword(String(b.password || ""), u.salt, u.hash)) { attempts.get(ip).push(Date.now()); return fail(res, 401, "Usuario o contraseña incorrectos"); }
    const token = crypto.randomBytes(32).toString("hex");
    db.prepare("DELETE FROM sessions WHERE expires < ?").run(Date.now());
    db.prepare("INSERT INTO sessions(token, user_id, expires) VALUES (?, ?, ?)").run(token, u.id, Date.now() + SESSION_DAYS * 864e5);
    return send(res, 200, { token, me: { id: u.id, username: u.username, name: u.name, role: u.role } });
  }

  const user = userFor(req);
  if (!user) return fail(res, 401, "Inicia sesión");
  const admin = user.role === "admin";
  const needAdmin = () => { if (!admin) { fail(res, 403, "Solo el administrador puede hacer esto"); return false; } return true; };
  const b = m === "GET" || m === "DELETE" ? {} : await readBody(req);

  if (m === "GET" && p === "/api/version") return send(res, 200, { version });
  if (m === "GET" && p === "/api/estado") return send(res, 200, state(user));
  if (m === "POST" && p === "/api/logout") { db.prepare("DELETE FROM sessions WHERE token = ?").run(req.headers.authorization.slice(7)); return send(res, 200, { ok: true }); }

  const one = /^\/api\/(products|expenses|purchases|sales|fotos)\/([A-Za-z0-9_-]+)$/.exec(p);
  if (one && idOk(one[2])) {
    const [, col, id] = one;
    if (m === "PUT" && COLS[col]) { if (col === "products" && b.active === false && !needAdmin()) return; COLS[col](id, b, user); bump(); return send(res, 200, { ok: true }); }
    if (m === "PUT" && col === "sales") { insertSale(id, b, user); bump(); return send(res, 200, { ok: true }); }
    if (m === "PUT" && col === "purchases") { insertPurchase(id, b, user); bump(); return send(res, 200, { ok: true }); }
    if (m === "PUT" && col === "fotos") {
      const mm = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.data || ""));
      if (!mm) return fail(res, 400, "La foto debe ser JPEG");
      db.prepare("INSERT INTO photos(product_id, jpeg, updated_at) VALUES (?, ?, ?) ON CONFLICT(product_id) DO UPDATE SET jpeg = excluded.jpeg, updated_at = excluded.updated_at")
        .run(id, Buffer.from(mm[1], "base64"), Date.now());
      bump(); return send(res, 200, { ok: true });
    }
    if (m === "DELETE") {
      if (!needAdmin()) return;
      if (col === "products") return fail(res, 400, "Los productos se archivan, no se borran");
      const table = { expenses: "expenses", purchases: "purchases", sales: "sales", fotos: "photos" }[col];
      db.prepare(`DELETE FROM ${table} WHERE ${col === "fotos" ? "product_id" : "id"} = ?`).run(id);
      bump(); return send(res, 200, { ok: true });
    }
  }
  if (m === "PUT" && p === "/api/ajustes") {
    if (!needAdmin()) return;
    const cur = getSettings();
    saveSettings({ ...cur, name: str(b.name, 80) || cur.name, tagline: str(b.tagline, 120), phone: str(b.phone, 30), currency: str(b.currency, 3) || "MXN",
      openingCash: num(b.openingCash), fixedAssets: num(b.fixedAssets), liabilities: num(b.liabilities), storeUrl: str(b.storeUrl, 300) });
    bump(); return send(res, 200, { ok: true });
  }
  if (m === "POST" && p === "/api/publicar") { if (!needAdmin()) return; return send(res, 200, await publishStore()); }
  if (m === "DELETE" && p === "/api/ejemplos") {
    if (!needAdmin()) return;
    db.exec(`BEGIN; DELETE FROM sales WHERE example = 1; DELETE FROM expenses WHERE example = 1; DELETE FROM purchases WHERE example = 1;
      DELETE FROM photos WHERE product_id IN (SELECT id FROM products WHERE example = 1); DELETE FROM products WHERE example = 1; COMMIT;`);
    bump(); return send(res, 200, { ok: true });
  }
  if (p === "/api/usuarios") {
    if (!needAdmin()) return;
    if (m === "GET") return send(res, 200, db.prepare("SELECT id, username, name, role, active FROM users ORDER BY id").all());
    if (m === "POST") {
      if (!/^[a-z0-9._-]{3,30}$/.test(str(b.username).toLowerCase())) return fail(res, 400, "El usuario debe tener de 3 a 30 letras o números, sin espacios");
      if (String(b.password || "").length < 8) return fail(res, 400, "La contraseña debe tener al menos 8 caracteres");
      try { createUser({ username: str(b.username), name: str(b.name, 60) || str(b.username), role: b.role === "admin" ? "admin" : "vendedor", password: String(b.password) }); }
      catch { return fail(res, 400, "Ese usuario ya existe"); }
      return send(res, 200, { ok: true });
    }
  }
  const uone = /^\/api\/usuarios\/(\d+)$/.exec(p);
  if (uone && m === "PUT") {
    if (!needAdmin()) return;
    const target = db.prepare("SELECT * FROM users WHERE id = ?").get(Number(uone[1]));
    if (!target) return fail(res, 404, "Usuario no encontrado");
    if (b.password) {
      if (String(b.password).length < 8) return fail(res, 400, "La contraseña debe tener al menos 8 caracteres");
      const { salt, hash } = hashPassword(String(b.password));
      db.prepare("UPDATE users SET salt = ?, hash = ? WHERE id = ?").run(salt, hash, target.id);
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(target.id);
    }
    if (typeof b.active === "boolean") {
      if (target.id === user.id) return fail(res, 400, "No puedes desactivar tu propia cuenta");
      db.prepare("UPDATE users SET active = ? WHERE id = ?").run(b.active ? 1 : 0, target.id);
      if (!b.active) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(target.id);
    }
    return send(res, 200, { ok: true });
  }
  if (m === "GET" && p === "/api/respaldo") { if (!needAdmin()) return; return send(res, 200, state(user)); }
  return fail(res, 404, "Ruta no encontrada");
}

http.createServer((req, res) => {
  route(req, res).catch(e => {
    if (res.headersSent) return res.end();
    const msg = e.message === "too_large" ? "El archivo es demasiado grande" : e.message === "bad_json" ? "Datos inválidos" : e.message;
    fail(res, 400, msg || "Error");
  });
}).listen(PORT, () => {
  const users = db.prepare("SELECT COUNT(*) n FROM users").get().n;
  console.log(`\n  Lechuga & Co. — servidor encendido`);
  console.log(`  Caja:            http://localhost:${PORT}/caja/`);
  console.log(`  Tienda:          http://localhost:${PORT}/`);
  console.log(`  Power BI (Web):  http://localhost:${PORT}/bi/partidas  (ventas, partidas, gastos, compras, productos)`);
  if (!users) console.log(`\n  Aún no hay usuarios. Cierra esta ventana y ejecuta:  node server\\setup.js\n`);
  console.log(`\n  No cierres esta ventana mientras la tienda esté abierta.\n`);
});
