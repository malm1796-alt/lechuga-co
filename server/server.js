// Servidor de Lechuga & Co.: API de la caja, datos para Power BI y publicación de la tienda en GitHub.
// Uso: node server\server.js   (o doble clic en iniciar.bat)
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { db, ROOT, getSettings, saveSettings, checkPassword, hashPassword, createUser, PHOTO_EXT, phoneKey } = require("./db");

const PORT = Number(process.env.PORT || 8787);
const DOCS = path.join(ROOT, "docs");
const SESSION_DAYS = 30;
const MAX_BODY = 40 * 1024 * 1024; // el editor manda varias fotos juntas
let version = Date.now();
const bump = () => { version = Date.now(); };
// Si otro programa (el importador) cambia la base de datos, la caja también debe enterarse.
let dataVersion = db.prepare("PRAGMA data_version").get().data_version;
function checkExternalChanges() {
  const dv = db.prepare("PRAGMA data_version").get().data_version;
  if (dv !== dataVersion) { dataVersion = dv; bump(); }
}

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
    customer: s.customer, phone: s.phone, promo: s.promo, example: !!s.example, items: items.get(s.id) || [],
  }));
  const customers = db.prepare("SELECT id, name, phone, email, source, created_at createdAt FROM customers ORDER BY created_at DESC").all();
  const expenses = db.prepare("SELECT * FROM expenses").all().map(e => ({ ...e, example: !!e.example }));
  const purchases = db.prepare("SELECT * FROM purchases").all().map(p => ({
    id: p.id, type: p.type, ts: p.ts, pid: p.product_id, qty: p.qty, unitCost: p.unit_cost, total: p.total,
    supplier: p.supplier, method: p.method, reason: p.reason, example: !!p.example,
  }));
  return { version, me: user, settings: getSettings(), products, sales, expenses, purchases, customers };
}

/* ---------- promoción de primera compra para clientes registrados ---------- */
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
function promoCheck(phone, subtotal) {
  const pr = getSettings().promo || {}, key = phoneKey(phone);
  if (!pr.active) return { ok: false, reason: "La promoción no está activa" };
  if (pr.end && today() > pr.end) return { ok: false, reason: "La promoción ya venció" };
  if (key.length !== 10) return { ok: false, reason: "Escribe el WhatsApp del cliente (10 dígitos)" };
  const c = db.prepare("SELECT * FROM customers WHERE phone = ?").get(key);
  if (!c) return { ok: false, reason: "El cliente no está registrado" };
  const used = db.prepare("SELECT phone FROM sales WHERE promo = 'primera'").all().some(s => phoneKey(s.phone) === key);
  if (used) return { ok: false, reason: `${c.name} ya usó su descuento de primera compra` };
  if (subtotal < num(pr.minimum)) return { ok: false, reason: `La compra mínima es de $${num(pr.minimum).toLocaleString("es-MX")}` };
  const pct = Math.max(0, Math.min(80, num(pr.percent)));
  return { ok: true, customer: c.name, percent: pct, discount: Math.round(subtotal * pct) / 100 };
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
  let total = Math.max(0, Math.min(subtotal, num(b.total))), promo = "";
  if (b.promo === "primera") {
    const pc = promoCheck(b.phone, subtotal);
    if (!pc.ok) throw new Error(pc.reason);
    total = Math.min(total, Math.round((subtotal - pc.discount) * 100) / 100);
    promo = "primera";
  }
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO sales(id, ts, subtotal, total, method, channel, customer, phone, user_id, promo) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, num(b.ts) || Date.now(), subtotal, total, str(b.method, 30), str(b.channel, 30) || "Tienda", str(b.customer, 80), str(b.phone, 30), user.id, promo);
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

/* ---------- editor de catálogo: guarda un modelo completo de una vez ---------- */
const movements = id => db.prepare("SELECT (SELECT COUNT(*) FROM sale_items WHERE product_id = ?) + (SELECT COUNT(*) FROM purchases WHERE product_id = ?) n").get(id, id).n;
function stockOf(id) {
  const p = db.prepare("SELECT stock0 FROM products WHERE id = ?").get(id);
  if (!p) return 0;
  const inn = db.prepare("SELECT COALESCE(SUM(qty), 0) q FROM purchases WHERE product_id = ?").get(id).q;
  const out = db.prepare("SELECT COALESCE(SUM(qty), 0) q FROM sale_items WHERE product_id = ?").get(id).q;
  return p.stock0 + inn - out;
}
function saveCatalog(b, user) {
  const admin = user.role === "admin";
  const prods = Array.isArray(b.products) ? b.products.slice(0, 600) : [];
  const photos = Array.isArray(b.photos) ? b.photos.slice(0, 60) : [];
  db.exec("BEGIN");
  try {
    for (const x of prods) {
      const id = str(x.id, 64);
      if (!idOk(id)) throw new Error(`El código «${id}» no es válido: usa letras, números y guiones`);
      const old = db.prepare("SELECT active FROM products WHERE id = ?").get(id);
      if ((x.active === false && (!old || old.active)) || (old && !old.active && x.active !== false))
        if (!admin) throw new Error("Solo el administrador puede archivar o restaurar prendas");
      upsertProduct(id, x);
      if (!old || x.stock === undefined) continue;
      // Existencias: si la prenda nunca se ha movido se corrige la carga inicial; si ya tiene ventas o compras, queda como ajuste.
      const diff = Math.round(num(x.stock)) - stockOf(id);
      if (!diff) continue;
      if (!movements(id)) db.prepare("UPDATE products SET stock0 = stock0 + ? WHERE id = ?").run(diff, id);
      else {
        const cost = num(x.cost);
        db.prepare(`INSERT INTO purchases(id, type, ts, product_id, qty, unit_cost, total, reason, user_id) VALUES (?, 'ajuste', ?, ?, ?, ?, ?, 'Ajuste desde el editor de catálogo', ?)`)
          .run(crypto.randomBytes(8).toString("hex"), Date.now(), id, diff, cost, diff * cost, user.id);
      }
    }
    // Mientras una prenda no tenga movimientos, su costo inicial sigue al costo actual (lo usa el balance).
    for (const x of prods) if (!movements(str(x.id, 64))) db.prepare("UPDATE products SET cost0 = cost WHERE id = ?").run(str(x.id, 64));
    const put = db.prepare(`INSERT INTO photos(product_id, jpeg, mime, updated_at) VALUES (?,?,?,?)
      ON CONFLICT(product_id) DO UPDATE SET jpeg = excluded.jpeg, mime = excluded.mime, updated_at = excluded.updated_at`);
    for (const ph of photos) {
      const ids = (Array.isArray(ph.ids) ? ph.ids : []).map(i => str(i, 64)).filter(idOk);
      if (ph.remove) { for (const id of ids) db.prepare("DELETE FROM photos WHERE product_id = ?").run(id); continue; }
      let blob, mime;
      if (ph.from) { const src = db.prepare("SELECT jpeg, mime FROM photos WHERE product_id = ?").get(str(ph.from, 64)); if (!src) continue; blob = src.jpeg; mime = src.mime; }
      else {
        const mm = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(ph.data || ""));
        if (!mm) throw new Error("La foto debe ser JPG, PNG o WEBP");
        blob = Buffer.from(mm[2], "base64"); mime = mm[1];
      }
      for (const id of ids) put.run(id, blob, mime, Date.now());
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
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
  const products = db.prepare("SELECT * FROM products WHERE active = 1 AND price > 0 ORDER BY name").all(); // sin precio = borrador
  // Cada foto se guarda una sola vez, nombrada por su contenido: todas las tallas de un color comparten archivo.
  const keep = new Set();
  const items = products.map(p => {
    const ph = db.prepare("SELECT jpeg, mime FROM photos WHERE product_id = ?").get(p.id);
    let photo = "";
    if (ph) {
      const name = crypto.createHash("sha1").update(ph.jpeg).digest("hex").slice(0, 16) + "." + (PHOTO_EXT[ph.mime] || "jpg");
      photo = "fotos/" + name;
      if (!keep.has(name)) { keep.add(name); const f = path.join(fotos, name); if (!fs.existsSync(f)) fs.writeFileSync(f, ph.jpeg); }
    }
    // Solo datos públicos: nunca costos, ventas ni existencias exactas.
    return { id: p.id, name: p.name, category: p.category || "", season: p.season || "", size: p.size || "", color: p.color || "",
      price: p.price, desc: p.description || "", photo, stock: Math.max(0, Math.min(3, sm.get(p.id) || 0)) };
  });
  for (const f of fs.readdirSync(fotos)) if (/\.(jpg|png|webp)$/.test(f) && !keep.has(f)) fs.unlinkSync(path.join(fotos, f));
  const pr = st.promo || {};
  const catalog = { publishedAt: Date.now(),
    settings: { name: st.name, tagline: st.tagline, phone: st.phone, currency: st.currency, city: st.city, categories: st.categories, seasons: st.seasons,
      promo: pr.active ? { title: pr.title, percent: pr.percent, minimum: pr.minimum, end: pr.end } : null },
    items };
  fs.writeFileSync(path.join(DOCS, "catalogo.json"), JSON.stringify(catalog, null, 1));
  if (!fs.existsSync(path.join(ROOT, ".git"))) return { ok: true, pushed: false, message: "Catálogo generado. Falta conectar la carpeta con GitHub para subirlo." };
  // Con una base de datos de prueba (LECHUGA_DB) nunca se sube nada a la página real.
  if (process.env.LECHUGA_DB) return { ok: true, pushed: false, message: "Catálogo generado (modo de prueba: no se subió a GitHub)." };
  await git(["add", "-A", "docs/catalogo.json", "docs/fotos"]);
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
    forma_pago: s.method, canal: s.channel, cliente: s.customer || "", vendedor: s.vendedor || "",
    promocion: s.promo === "primera" ? "Primera compra" : "", ejemplo: !!s.example })),
  clientes: () => db.prepare("SELECT * FROM customers ORDER BY created_at").all().map(c => ({
    cliente_id: c.id, nombre: c.name, origen: c.source === "web" ? "Página web" : "Caja", fecha_registro: fecha(c.created_at) })),
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

  const noUsers = () => !db.prepare("SELECT COUNT(*) n FROM users").get().n;
  if (m === "GET" && p === "/api/salud") return send(res, 200, { ok: true, version, primeraVez: noUsers(), local: isLocal(req) });
  // La primera cuenta (administrador) solo se crea desde esta PC y solo si todavía no existe ninguna.
  if (m === "POST" && p === "/api/primera-cuenta") {
    if (!isLocal(req)) return fail(res, 403, "La primera cuenta solo se crea desde la PC de la tienda");
    if (!noUsers()) return fail(res, 409, "Ya existe una cuenta de administrador. Entra con ella.");
    const b = await readBody(req);
    const username = str(b.username, 30).toLowerCase(), name = str(b.name, 60), password = String(b.password || "");
    if (!name) return fail(res, 400, "Escribe tu nombre");
    if (!/^[a-z0-9.&_-]{3,30}$/.test(username)) return fail(res, 400, "El usuario debe tener de 3 a 30 letras, números o los signos . & _ -, sin espacios");
    if (password.length < 8) return fail(res, 400, "La contraseña debe tener al menos 8 caracteres");
    createUser({ username, name, role: "admin", password });
    const u = db.prepare("SELECT id, username, name, role FROM users WHERE username = ?").get(username);
    const token = crypto.randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions(token, user_id, expires) VALUES (?, ?, ?)").run(token, u.id, Date.now() + SESSION_DAYS * 864e5);
    return send(res, 200, { token, me: u });
  }
  const photoGet = /^\/api\/fotos\/([A-Za-z0-9_-]+)$/.exec(p);
  if (m === "GET" && photoGet) {
    const ph = db.prepare("SELECT jpeg, mime FROM photos WHERE product_id = ?").get(photoGet[1]);
    return ph ? send(res, 200, Buffer.from(ph.jpeg), { "Content-Type": ph.mime, "Cache-Control": "public, max-age=31536000" }) : fail(res, 404, "Sin foto");
  }
  // Registro de clientes desde la página web (pública): solo nombre, WhatsApp y, si quiere, correo.
  if (m === "POST" && p === "/api/public/registro") {
    const ip = req.headers["cf-connecting-ip"] || req.socket.remoteAddress;
    if (tooManyAttempts("reg:" + ip)) return fail(res, 429, "Demasiados registros desde esta conexión. Intenta más tarde.");
    attempts.get("reg:" + ip).push(Date.now());
    const b = await readBody(req);
    const name = str(b.name, 80), phone = phoneKey(b.phone), email = str(b.email, 120).toLowerCase();
    if (!b.acepta) return fail(res, 400, "Necesitamos que aceptes el aviso de privacidad");
    if (name.length < 2) return fail(res, 400, "Escribe tu nombre");
    if (phone.length !== 10) return fail(res, 400, "Escribe tu WhatsApp a 10 dígitos");
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(res, 400, "Revisa tu correo");
    const existing = db.prepare("SELECT id FROM customers WHERE phone = ?").get(phone);
    if (!existing) { db.prepare("INSERT INTO customers(name, phone, email, source, created_at) VALUES (?,?,?,'web',?)").run(name, phone, email, Date.now()); bump(); }
    const pr = getSettings().promo || {};
    return send(res, 200, { ok: true, existing: !!existing, promo: pr.active ? { percent: pr.percent, minimum: pr.minimum, end: pr.end } : null });
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

  if (m === "GET" && p === "/api/version") { checkExternalChanges(); return send(res, 200, { version }); }
  if (m === "GET" && p === "/api/estado") { checkExternalChanges(); return send(res, 200, state(user)); }
  if (m === "POST" && p === "/api/logout") { db.prepare("DELETE FROM sessions WHERE token = ?").run(req.headers.authorization.slice(7)); return send(res, 200, { ok: true }); }

  const one = /^\/api\/(products|expenses|purchases|sales|fotos)\/([A-Za-z0-9_-]+)$/.exec(p);
  if (one && idOk(one[2])) {
    const [, col, id] = one;
    if (m === "PUT" && COLS[col]) {
      if (col === "products") {
        const old = db.prepare("SELECT active FROM products WHERE id = ?").get(id);
        const archiving = b.active === false, restoring = old && !old.active && b.active !== false;
        if ((archiving || restoring) && !needAdmin()) return;
      }
      COLS[col](id, b, user); bump(); return send(res, 200, { ok: true });
    }
    if (m === "PUT" && col === "sales") { insertSale(id, b, user); bump(); return send(res, 200, { ok: true }); }
    if (m === "PUT" && col === "purchases") { insertPurchase(id, b, user); bump(); return send(res, 200, { ok: true }); }
    if (m === "PUT" && col === "fotos") {
      const mm = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.data || ""));
      if (!mm) return fail(res, 400, "La foto debe ser JPG, PNG o WEBP");
      db.prepare(`INSERT INTO photos(product_id, jpeg, mime, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(product_id) DO UPDATE SET jpeg = excluded.jpeg, mime = excluded.mime, updated_at = excluded.updated_at`)
        .run(id, Buffer.from(mm[2], "base64"), mm[1], Date.now());
      bump(); return send(res, 200, { ok: true });
    }
    if (m === "DELETE") {
      if (!needAdmin()) return;
      if (col === "products") {
        // Solo se elimina una prenda creada por error: si ya tuvo ventas o compras, se archiva para no romper los reportes.
        const used = db.prepare("SELECT (SELECT COUNT(*) FROM sale_items WHERE product_id = ?) + (SELECT COUNT(*) FROM purchases WHERE product_id = ?) n").get(id, id).n;
        if (used) return fail(res, 409, "Esta prenda ya tiene ventas o compras. Archívala para conservar los reportes.");
        db.prepare("DELETE FROM photos WHERE product_id = ?").run(id);
        db.prepare("DELETE FROM products WHERE id = ?").run(id);
        bump(); return send(res, 200, { ok: true });
      }
      const table = { expenses: "expenses", purchases: "purchases", sales: "sales", fotos: "photos" }[col];
      db.prepare(`DELETE FROM ${table} WHERE ${col === "fotos" ? "product_id" : "id"} = ?`).run(id);
      bump(); return send(res, 200, { ok: true });
    }
  }
  if (m === "PUT" && p === "/api/ajustes") {
    if (!needAdmin()) return;
    const cur = getSettings();
    saveSettings({ ...cur, name: str(b.name, 80) || cur.name, tagline: str(b.tagline, 120), phone: str(b.phone, 30), currency: str(b.currency, 3) || "MXN",
      openingCash: num(b.openingCash), fixedAssets: num(b.fixedAssets), liabilities: num(b.liabilities), storeUrl: str(b.storeUrl, 300),
      city: str(b.city, 80) || cur.city,
      promo: b.promo ? { active: !!b.promo.active, title: str(b.promo.title, 60) || "Compra anticipada", percent: Math.max(0, Math.min(80, num(b.promo.percent))),
        minimum: Math.max(0, num(b.promo.minimum)), end: /^\d{4}-\d{2}-\d{2}$/.test(b.promo.end || "") ? b.promo.end : "" } : cur.promo });
    bump(); return send(res, 200, { ok: true });
  }
  if (m === "GET" && p === "/api/promo") return send(res, 200, promoCheck(url.searchParams.get("tel"), num(url.searchParams.get("subtotal"))));
  if (m === "POST" && p === "/api/catalogo/guardar") { saveCatalog(b, user); bump(); return send(res, 200, { ok: true }); }
  if (p === "/api/clientes" && m === "POST") {
    const name = str(b.name, 80), phone = phoneKey(b.phone), email = str(b.email, 120).toLowerCase();
    if (name.length < 2 || phone.length !== 10) return fail(res, 400, "Escribe nombre y WhatsApp a 10 dígitos");
    if (db.prepare("SELECT 1 FROM customers WHERE phone = ?").get(phone)) return fail(res, 400, "Ese WhatsApp ya está registrado");
    db.prepare("INSERT INTO customers(name, phone, email, source, created_at) VALUES (?,?,?,'caja',?)").run(name, phone, email, Date.now());
    bump(); return send(res, 200, { ok: true });
  }
  const cone = /^\/api\/clientes\/(\d+)$/.exec(p);
  if (cone && m === "DELETE") {
    if (!needAdmin()) return;
    db.prepare("DELETE FROM customers WHERE id = ?").run(Number(cone[1]));
    bump(); return send(res, 200, { ok: true });
  }
  // Listas de categorías y temporadas: agregar, renombrar (cambia también las prendas) y quitar (mueve sus prendas).
  if (m === "POST" && p === "/api/listas") {
    if (!needAdmin()) return;
    const kind = b.kind === "seasons" ? "seasons" : b.kind === "categories" ? "categories" : null;
    if (!kind) return fail(res, 400, "Lista desconocida");
    const col = kind === "seasons" ? "season" : "category";
    const st = getSettings(), list = [...st[kind]];
    const name = str(b.name, 60), to = str(b.to, 60);
    if (b.action === "add") {
      if (!name) return fail(res, 400, "Escribe un nombre");
      if (list.some(x => x.toLowerCase() === name.toLowerCase())) return fail(res, 400, "Ya existe");
      list.push(name);
    } else if (b.action === "rename") {
      if (!name || !to) return fail(res, 400, "Escribe el nombre nuevo");
      if (list.some(x => x.toLowerCase() === to.toLowerCase() && x !== name)) return fail(res, 400, "Ya existe una con ese nombre");
      const i = list.indexOf(name); if (i >= 0) list[i] = to; else list.push(to);
      db.prepare(`UPDATE products SET ${col} = ? WHERE ${col} = ?`).run(to, name);
    } else if (b.action === "remove") {
      db.prepare(`UPDATE products SET ${col} = ? WHERE ${col} = ?`).run(to, name);
      const i = list.indexOf(name); if (i >= 0) list.splice(i, 1);
    } else if (b.action === "move") {
      const i = list.indexOf(name), j = i + (b.dir === "up" ? -1 : 1);
      if (i >= 0 && j >= 0 && j < list.length) [list[i], list[j]] = [list[j], list[i]];
    } else return fail(res, 400, "Acción desconocida");
    saveSettings({ ...st, [kind]: list });
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
      if (!/^[a-z0-9.&_-]{3,30}$/.test(str(b.username).toLowerCase())) return fail(res, 400, "El usuario debe tener de 3 a 30 letras, números o los signos . & _ -, sin espacios");
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
