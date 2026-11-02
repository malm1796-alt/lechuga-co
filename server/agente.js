// Agente de publicidad de Lechuga & Co.
// Investiga tendencias con Claude (búsqueda web), arma el calendario de publicaciones con tus prendas reales
// y publica las piezas en Facebook, Instagram y TikTok a su hora. Las imágenes y videos los diseña la caja.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const Anthropic = require("@anthropic-ai/sdk").default;
const { db, ROOT, DATA, getSettings, saveSettings } = require("./db");

const MODEL = "claude-opus-5-5";
const SECRETS = path.join(DATA, "secretos.json");
const MEDIA = path.join(DATA, "publicidad");
const MUSIC = path.join(DATA, "musica");
fs.mkdirSync(MEDIA, { recursive: true });
fs.mkdirSync(MUSIC, { recursive: true });

db.exec(`
CREATE TABLE IF NOT EXISTS ad_posts (
  id TEXT PRIMARY KEY, campaign TEXT, created_at INTEGER NOT NULL, scheduled_at INTEGER NOT NULL,
  networks TEXT NOT NULL, format TEXT NOT NULL, template TEXT NOT NULL, product_ids TEXT NOT NULL,
  headline TEXT, subline TEXT, hook TEXT, caption TEXT, hashtags TEXT, music_mood TEXT, music_tip TEXT, trend TEXT,
  track TEXT, status TEXT NOT NULL DEFAULT 'diseñar', media_file TEXT, price_snapshot TEXT, results TEXT, error TEXT);
CREATE TABLE IF NOT EXISTS ad_research (id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, report TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ad_log (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, post_id TEXT, network TEXT, ok INTEGER, detail TEXT);
`);

/* ---------- configuración y llaves (las llaves nunca salen de esta PC ni se mandan a la caja) ---------- */
const DEFAULT_CFG = { auto: false, dailyMax: 3, times: ["10:00", "14:00", "19:30"], networks: { facebook: true, instagram: true, tiktok: true }, graphVersion: "v23.0" };
const cfg = () => ({ ...DEFAULT_CFG, ...(getSettings().agente || {}) });
function saveCfg(patch) { const st = getSettings(); saveSettings({ ...st, agente: { ...cfg(), ...patch } }); }
function secrets() { try { return JSON.parse(fs.readFileSync(SECRETS, "utf8")); } catch { return {}; } }
function saveSecrets(patch) {
  const cur = secrets();
  // Un campo vacío deja la llave como estaba; null la borra.
  for (const [k, v] of Object.entries(patch)) { if (v === null) delete cur[k]; else if (typeof v === "string" && v.trim()) cur[k] = v.trim(); }
  fs.writeFileSync(SECRETS, JSON.stringify(cur, null, 1));
}
function status() {
  const s = secrets(), c = cfg();
  return { cfg: c, claude: !!s.anthropicKey, facebook: !!(s.metaPageId && s.metaPageToken), instagram: !!(s.igUserId && s.metaPageToken),
    tiktok: !!(s.tiktokClientKey && s.tiktokClientSecret && s.tiktokRefreshToken), storeUrl: getSettings().storeUrl || "" };
}
const log = (post, network, ok, detail) => db.prepare("INSERT INTO ad_log(ts, post_id, network, ok, detail) VALUES (?,?,?,?,?)").run(Date.now(), post, network, ok ? 1 : 0, String(detail).slice(0, 1000));

/* ---------- Claude ---------- */
function claude() {
  const key = secrets().anthropicKey;
  if (!key) throw new Error("Falta la clave de Claude. Ponla en Publicidad → Conexiones.");
  return new Anthropic({ apiKey: key });
}
// Opus 5.5 con respaldo automático del servidor si un filtro de seguridad rechaza la petición.
async function ask(params) {
  const client = claude();
  let messages = params.messages;
  for (let i = 0; i < 5; i++) {
    let r;
    try {
      r = await client.beta.messages.create({ model: MODEL, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", ...params, messages });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new Error("La clave de Claude no es válida. Revísala en Conexiones.");
      if (e instanceof Anthropic.RateLimitError) throw new Error("Claude está saturado en este momento. Intenta en unos minutos.");
      if (e instanceof Anthropic.APIError) throw new Error(`Claude respondió con error ${e.status}: ${e.message}`);
      throw new Error("No hay conexión con Claude: " + e.message);
    }
    if (r.stop_reason === "pause_turn") { messages = [...messages, { role: "assistant", content: r.content }]; continue; }
    if (r.stop_reason === "refusal") throw new Error("Claude no pudo hacer esta petición" + (r.stop_details?.explanation ? ": " + r.stop_details.explanation : "."));
    if (r.stop_reason === "max_tokens") throw new Error("La respuesta de Claude salió incompleta. Pide menos piezas a la vez.");
    return r.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  }
  throw new Error("La investigación tardó demasiado. Intenta de nuevo.");
}

const BRAND = `Lechuga & Co. es una tienda de ropa para hombre en Chihuahua, México, desde 1990 («American Clothing»). Vende chamarras, sudaderas, camisas de franela, chalecos y chamarras de piel de borrego hechas en León, Guanajuato. Atiende menudeo y también empresas (uniformes, pedidos por caja). Identidad: azul noche y dorado, logo de montañas, lema «Ropa · Chamarras · Sudaderas». Tono: cercano, de tú, seguro, nada exagerado; un emoji como máximo. Los pedidos se hacen por WhatsApp desde la página web.`;

async function research() {
  const report = await ask({
    max_tokens: 16000,
    output_config: { effort: "medium" },
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 8,
      user_location: { type: "approximate", city: "Chihuahua", region: "Chihuahua", country: "MX", timezone: "America/Chihuahua" } }],
    system: `Eres estratega de redes sociales para una tienda de ropa. ${BRAND}`,
    messages: [{ role: "user", content: `Investiga en internet qué formatos de publicidad de ropa de invierno para hombre están funcionando en este momento en México en TikTok, Instagram (Reels e historias) y Facebook. Quiero formatos y estructuras, no contenido de otras marcas para copiar.

Entrega un informe breve en español con:
1. De 5 a 8 formatos en tendencia (por ejemplo: gancho en los primeros 3 segundos, «outfit del día», antes y después, carrusel de colores, precio sorpresa al final, «3 formas de usar»). Para cada uno: cómo se estructura, por qué funciona y en qué red rinde más.
2. Los mejores días y horarios para publicar en México.
3. Hashtags útiles en español para ropa de invierno, Chihuahua y moda masculina.
4. Estilos de música que acompañan bien estos videos (solo el estilo, no canciones con derechos).
Sé concreto y práctico. No incluyas el contenido, los textos ni las imágenes de otras marcas o creadores.` }],
  });
  db.prepare("INSERT INTO ad_research(created_at, report) VALUES (?, ?)").run(Date.now(), report);
  return report;
}

/* ---------- calendario de publicaciones ---------- */
function catalogForAgent() {
  const sm = new Map(db.prepare("SELECT id, stock0 FROM products").all().map(r => [r.id, r.stock0]));
  for (const r of db.prepare("SELECT product_id, SUM(qty) q FROM purchases GROUP BY product_id").all()) sm.set(r.product_id, (sm.get(r.product_id) || 0) + r.q);
  for (const r of db.prepare("SELECT product_id, SUM(qty) q FROM sale_items GROUP BY product_id").all()) if (sm.has(r.product_id)) sm.set(r.product_id, sm.get(r.product_id) - r.q);
  const photos = new Set(db.prepare("SELECT product_id FROM photos").all().map(r => r.product_id));
  // Una opción por modelo y color, con existencias: el agente elige de aquí y nunca inventa prendas.
  const g = new Map();
  for (const p of db.prepare("SELECT * FROM products WHERE active = 1 ORDER BY name").all()) {
    const k = `${p.name}|${p.season}|${p.color}`;
    if (!g.has(k)) g.set(k, { id: p.id, modelo: p.name, color: p.color || "", categoria: p.category || "", temporada: p.season || "", tallas: [], piezas: 0, foto: false, caracteristicas: (p.description || "").split(" · ").filter(s => !/^Talla /.test(s)).slice(0, 4).join("; ") });
    const x = g.get(k), st = Math.max(0, sm.get(p.id) || 0);
    if (st > 0) { x.tallas.push(p.size); x.piezas += st; }
    if (photos.has(p.id)) { x.foto = true; if (!photos.has(x.id)) x.id = p.id; }
  }
  return [...g.values()].filter(x => x.piezas > 0);
}
const PLAN_SCHEMA = {
  type: "object", additionalProperties: false, required: ["posts"],
  properties: { posts: { type: "array", items: { type: "object", additionalProperties: false,
    required: ["day", "time", "networks", "format", "template", "product_ids", "headline", "subline", "hook", "caption", "hashtags", "music_mood", "music_tip", "trend"],
    properties: {
      day: { type: "integer", description: "Día de la campaña, empezando en 0" },
      time: { type: "string", description: "Hora local HH:MM" },
      networks: { type: "array", items: { type: "string", enum: ["facebook", "instagram", "tiktok"] } },
      format: { type: "string", enum: ["post", "historia", "video"] },
      template: { type: "string", enum: ["producto", "promo", "coleccion", "colores"] },
      product_ids: { type: "array", items: { type: "string" }, description: "ids exactos tomados del catálogo" },
      headline: { type: "string", description: "Título en la imagen, máximo 5 palabras" },
      subline: { type: "string", description: "Frase corta en la imagen, máximo 9 palabras" },
      hook: { type: "string", description: "Gancho de los primeros 3 segundos del video" },
      caption: { type: "string", description: "Texto de la publicación, sin precios" },
      hashtags: { type: "array", items: { type: "string" } },
      music_mood: { type: "string", enum: ["energetica", "urbana", "tranquila", "elegante"] },
      music_tip: { type: "string", description: "Qué tipo de sonido buscar en la biblioteca comercial de la red" },
      trend: { type: "string", description: "Formato en tendencia en el que se basa" },
    } } } },
};
async function plan({ days = 7, perWeek = 6, networks = ["facebook", "instagram", "tiktok"], start = Date.now() + 36e5 }) {
  days = Math.max(1, Math.min(30, Math.round(days)));
  const total = Math.max(1, Math.min(40, Math.round(perWeek * days / 7)));
  const st = getSettings(), c = cfg(), cat = catalogForAgent();
  if (!cat.length) throw new Error("No hay prendas con existencias para anunciar. Carga tu catálogo primero.");
  const rep = db.prepare("SELECT report FROM ad_research ORDER BY id DESC LIMIT 1").get();
  const sl = st.sale && st.sale.active && (!st.sale.end || new Date().toISOString().slice(0, 10) <= st.sale.end) ? `Descuento general: ${st.sale.title}, ${st.sale.percent}% en toda la tienda para todos los clientes del ${st.sale.start} al ${st.sale.end}${st.sale.minimum ? ", compra mínima $" + st.sale.minimum : ""}. Anúncialo con fuerza en los días previos y durante esas fechas; no lo anuncies después. No uses logotipos de programas oficiales.` : "";
  const pr = st.promo && st.promo.active ? `Promoción activa: ${st.promo.title}, ${st.promo.percent}% en la primera compra de clientes registrados en la página, compra mínima $${st.promo.minimum}${st.promo.end ? ", válida hasta " + st.promo.end : ""}.` : "Sin promoción activa: no menciones descuentos.";
  const text = await ask({
    max_tokens: 32000,
    output_config: { effort: "medium", format: { type: "json_schema", schema: PLAN_SCHEMA } },
    system: `Eres el community manager de Lechuga & Co. ${BRAND}`,
    messages: [{ role: "user", content: `Arma un calendario de ${total} publicaciones para los próximos ${days} días (día 0 = ${new Date(start).toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" })}).

Redes disponibles: ${networks.join(", ")}. Horarios sugeridos: ${c.times.join(", ")}. Máximo ${c.dailyMax} por día.
${pr}
${sl}
Página web: ${st.storeUrl || "(sin dirección)"} · WhatsApp: ${st.phone || "(sin número)"}

Catálogo disponible (usa SOLO estos ids en product_ids; prefiere los que tienen foto):
${JSON.stringify(cat)}

${rep ? "Tendencias investigadas:\n" + rep.report : "Aún no hay investigación de tendencias: usa formatos probados para ropa en redes."}

Reglas:
- Formatos: «post» (imagen de feed: Facebook e Instagram), «historia» (Instagram), «video» (Reels, Facebook y TikTok; TikTok solo acepta video).
- Plantillas: «producto» (1 prenda), «colores» (1 modelo, sus colores), «coleccion» (2 a 4 prendas), «promo» (la promoción, 1 o 2 prendas).
- Varía prendas, formatos y plantillas; al menos un tercio deben ser video si TikTok está disponible.
- Nunca escribas precios ni cantidades de dinero en ningún texto: el precio real lo pone el sistema.
- No prometas envíos gratis, existencias ni plazos de entrega que no se mencionan aquí.
- Cada pieza se basa en un formato en tendencia, pero todo el texto es original de Lechuga & Co.
- Captions en español de México, de 1 a 4 renglones, cierre invitando a pedir por WhatsApp o ver la página. De 4 a 8 hashtags sin repetir el #.` }],
  });
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("Claude devolvió un calendario que no se pudo leer. Intenta de nuevo."); }
  const valid = new Map(cat.map(x => [x.id, x]));
  const campaign = "c" + Date.now().toString(36), base = new Date(start); base.setHours(0, 0, 0, 0);
  const ins = db.prepare(`INSERT INTO ad_posts(id, campaign, created_at, scheduled_at, networks, format, template, product_ids, headline, subline, hook, caption, hashtags, music_mood, music_tip, trend, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'diseñar')`);
  let n = 0;
  for (const p of data.posts || []) {
    const ids = [...new Set(p.product_ids.filter(id => valid.has(id)))].slice(0, 4);
    if (!ids.length) continue;
    let nets = [...new Set(p.networks.filter(x => networks.includes(x)))];
    if (p.format !== "video") nets = nets.filter(x => x !== "tiktok");
    if (p.format === "historia") nets = nets.filter(x => x === "instagram");
    if (!nets.length) continue;
    const [hh, mm] = /^\d{1,2}:\d{2}$/.test(p.time) ? p.time.split(":").map(Number) : [12, 0];
    const when = new Date(base); when.setDate(when.getDate() + Math.max(0, Math.min(days - 1, p.day))); when.setHours(hh, mm, 0, 0);
    if (+when < start) when.setDate(when.getDate() + 1);
    const clean = s => String(s || "").replace(/\$\s?\d[\d.,]*(\s?(mxn|pesos))?/gi, "").replace(/\s{2,}/g, " ").trim();
    ins.run(crypto.randomBytes(6).toString("hex"), campaign, Date.now(), +when, JSON.stringify(nets), p.format, p.template, JSON.stringify(ids),
      clean(p.headline).slice(0, 60), clean(p.subline).slice(0, 90), clean(p.hook).slice(0, 120), clean(p.caption).slice(0, 2000),
      JSON.stringify(p.hashtags.map(h => "#" + String(h).replace(/^#+/, "").replace(/\s+/g, "")).filter(h => h.length > 1).slice(0, 8)),
      p.music_mood, clean(p.music_tip).slice(0, 200), clean(p.trend).slice(0, 200));
    n++;
  }
  if (!n) throw new Error("Claude no propuso piezas válidas. Intenta de nuevo.");
  return { campaign, count: n };
}

/* ---------- piezas, música y registro ---------- */
const rowToPost = r => ({ ...r, networks: JSON.parse(r.networks), product_ids: JSON.parse(r.product_ids), hashtags: JSON.parse(r.hashtags || "[]"),
  results: r.results ? JSON.parse(r.results) : null, price_snapshot: r.price_snapshot ? JSON.parse(r.price_snapshot) : null });
const posts = () => db.prepare("SELECT * FROM ad_posts ORDER BY scheduled_at").all().map(rowToPost);
function updatePost(id, b) {
  const p = db.prepare("SELECT * FROM ad_posts WHERE id = ?").get(id);
  if (!p) throw new Error("Pieza no encontrada");
  const f = {};
  if (typeof b.caption === "string") f.caption = b.caption.slice(0, 2000);
  if (typeof b.headline === "string") f.headline = b.headline.slice(0, 60);
  if (typeof b.subline === "string") f.subline = b.subline.slice(0, 90);
  if (Number.isFinite(b.scheduled_at)) f.scheduled_at = Math.round(b.scheduled_at);
  if (typeof b.track === "string") f.track = b.track.slice(0, 120);
  if (b.status === "pausado" || (b.status === "listo" && p.media_file)) f.status = b.status;
  const keys = Object.keys(f);
  if (keys.length) db.prepare(`UPDATE ad_posts SET ${keys.map(k => k + " = ?").join(", ")} WHERE id = ?`).run(...keys.map(k => f[k]), id);
}
const MEDIA_TYPES = { "image/png": "png", "image/jpeg": "jpg", "video/mp4": "mp4" };
function saveMedia(id, b) {
  const p = db.prepare("SELECT * FROM ad_posts WHERE id = ?").get(id);
  if (!p) throw new Error("Pieza no encontrada");
  const m = /^data:([a-z]+\/[a-z0-9.+-]+)(?:;codecs=[^;]+)?;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.data || ""));
  if (!m || !MEDIA_TYPES[m[1]]) throw new Error("La pieza debe ser PNG, JPG o video MP4. Este navegador grabó en otro formato: usa Chrome o Edge actualizado.");
  if (p.media_file) fs.rmSync(path.join(MEDIA, p.media_file), { force: true });
  const file = `${id}-${Date.now().toString(36)}.${MEDIA_TYPES[m[1]]}`;
  fs.writeFileSync(path.join(MEDIA, file), Buffer.from(m[2], "base64"));
  db.prepare("UPDATE ad_posts SET media_file = ?, price_snapshot = ?, track = ?, status = 'listo', error = NULL WHERE id = ?")
    .run(file, JSON.stringify(b.prices || {}), String(b.track || "").slice(0, 120), id);
}
function removePost(id) {
  const p = db.prepare("SELECT media_file FROM ad_posts WHERE id = ?").get(id);
  if (p && p.media_file) fs.rmSync(path.join(MEDIA, p.media_file), { force: true });
  db.prepare("DELETE FROM ad_posts WHERE id = ?").run(id);
}
const musicList = () => fs.readdirSync(MUSIC).filter(f => /\.(mp3|m4a|wav|ogg)$/i.test(f)).map(f => ({ file: f, kb: Math.round(fs.statSync(path.join(MUSIC, f)).size / 1024) }));
function saveMusic(b) {
  if (!b.licencia) throw new Error("Confirma que tienes derecho de uso comercial de esta música");
  const m = /^data:audio\/(mpeg|mp3|mp4|x-m4a|wav|x-wav|ogg);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.data || ""));
  if (!m) throw new Error("La música debe ser MP3, M4A, WAV u OGG");
  const ext = { mpeg: "mp3", mp3: "mp3", mp4: "m4a", "x-m4a": "m4a", wav: "wav", "x-wav": "wav", ogg: "ogg" }[m[1]];
  const mood = ["energetica", "urbana", "tranquila", "elegante"].includes(b.mood) ? b.mood : "urbana";
  const name = String(b.name || "pista").toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "pista";
  fs.writeFileSync(path.join(MUSIC, `${mood}--${name}.${ext}`), Buffer.from(m[2], "base64"));
}
const mediaPath = f => { const p = path.join(MEDIA, path.basename(f)); return fs.existsSync(p) ? p : null; };
const musicPath = f => { const p = path.join(MUSIC, path.basename(f)); return fs.existsSync(p) ? p : null; };

/* ---------- publicación ---------- */
const git = args => new Promise(r => execFile("git", ["-C", ROOT, ...args], { windowsHide: true, timeout: 120e3 }, (e, o, er) => r({ ok: !e, out: (o + er).trim() })));
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Meta y TikTok descargan la pieza desde una dirección pública: se sube a la página web (GitHub Pages).
async function publicUrl(post) {
  const st = getSettings();
  if (!st.storeUrl) throw new Error("Falta la dirección de la página web en Ajustes");
  if (process.env.LECHUGA_DB) throw new Error("Modo de prueba: no se publica");
  const dir = path.join(ROOT, "docs", "publicidad"); fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(MEDIA, post.media_file), path.join(dir, post.media_file));
  await git(["add", "docs/publicidad/" + post.media_file]);
  await git(["commit", "-m", "Pieza de publicidad " + post.id]);
  const p = await git(["push"]);
  if (!p.ok) throw new Error("No se pudo subir la pieza a GitHub: " + p.out.slice(0, 200));
  const url = st.storeUrl.replace(/\/?$/, "/") + "publicidad/" + post.media_file;
  for (let i = 0; i < 40; i++) { try { const r = await fetch(url, { method: "HEAD" }); if (r.ok) return url; } catch {} await sleep(15e3); }
  throw new Error("GitHub tardó demasiado en publicar la pieza");
}
async function graph(pathPart, params, method = "POST") {
  const s = secrets(), v = cfg().graphVersion;
  const body = new URLSearchParams({ ...params, access_token: s.metaPageToken });
  const r = await fetch(`https://graph.facebook.com/${v}/${pathPart}${method === "GET" ? "?" + body : ""}`, method === "GET" ? {} : { method, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error ? `${j.error.message} (Meta ${j.error.code})` : `Meta respondió ${r.status}`);
  return j;
}
async function toFacebook(post, url, caption) {
  const s = secrets();
  if (post.format === "video") return (await graph(`${s.metaPageId}/videos`, { file_url: url, description: caption })).id;
  return (await graph(`${s.metaPageId}/photos`, { url, message: caption })).post_id;
}
async function toInstagram(post, url, caption) {
  const s = secrets(), video = /\.mp4$/.test(post.media_file);
  const params = post.format === "historia" ? { media_type: "STORIES", [video ? "video_url" : "image_url"]: url }
    : video ? { media_type: "REELS", video_url: url, caption, share_to_feed: "true" } : { image_url: url, caption };
  const { id } = await graph(`${s.igUserId}/media`, params);
  for (let i = 0; i < 40; i++) {
    const st = await graph(id, { fields: "status_code" }, "GET");
    if (st.status_code === "FINISHED") break;
    if (st.status_code === "ERROR") throw new Error("Instagram no pudo procesar la pieza");
    await sleep(6e3);
  }
  return (await graph(`${s.igUserId}/media_publish`, { creation_id: id })).id;
}
async function tiktokToken() {
  const s = secrets();
  if (s.tiktokAccess && s.tiktokAccessExp > Date.now() + 6e4) return s.tiktokAccess;
  const r = await fetch("https://open.tiktokapis.com/v2/oauth/token/", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_key: s.tiktokClientKey, client_secret: s.tiktokClientSecret, grant_type: "refresh_token", refresh_token: s.tiktokRefreshToken }) });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error("TikTok no renovó el acceso: " + (j.error_description || j.error || r.status));
  saveSecrets({ tiktokAccess: j.access_token, tiktokRefreshToken: j.refresh_token || s.tiktokRefreshToken });
  const cur = secrets(); cur.tiktokAccessExp = Date.now() + (j.expires_in || 3600) * 1000; fs.writeFileSync(SECRETS, JSON.stringify(cur, null, 1));
  return j.access_token;
}
async function tiktok(pathPart, body, token) {
  const r = await fetch("https://open.tiktokapis.com" + pathPart, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json; charset=UTF-8" }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (j.error && j.error.code && j.error.code !== "ok") throw new Error(`TikTok: ${j.error.message || j.error.code}`);
  return j.data || {};
}
async function toTikTok(post, caption) {
  if (!/\.mp4$/.test(post.media_file)) throw new Error("TikTok solo acepta video");
  const token = await tiktokToken();
  const info = await tiktok("/v2/post/publish/creator_info/query/", {}, token);
  const opts = info.privacy_level_options || [];
  // Mientras TikTok no apruebe tu app, solo deja publicar en privado (SELF_ONLY).
  const privacy = opts.includes("PUBLIC_TO_EVERYONE") ? "PUBLIC_TO_EVERYONE" : opts[0] || "SELF_ONLY";
  const bytes = fs.readFileSync(path.join(MEDIA, post.media_file));
  const init = await tiktok("/v2/post/publish/video/init/", {
    post_info: { title: caption.slice(0, 2200), privacy_level: privacy, disable_comment: false, disable_duet: false, disable_stitch: false },
    source_info: { source: "FILE_UPLOAD", video_size: bytes.length, chunk_size: bytes.length, total_chunk_count: 1 },
  }, token);
  const up = await fetch(init.upload_url, { method: "PUT", headers: { "Content-Type": "video/mp4", "Content-Range": `bytes 0-${bytes.length - 1}/${bytes.length}` }, body: bytes });
  if (!up.ok) throw new Error("TikTok no recibió el video (" + up.status + ")");
  return init.publish_id + (privacy === "SELF_ONLY" ? " (privado: tu app de TikTok aún no está aprobada)" : "");
}
// Antes de publicar: la prenda sigue activa, con piezas y al mismo precio que tiene la imagen.
function preCheck(post) {
  for (const id of post.product_ids) {
    const p = db.prepare("SELECT * FROM products WHERE id = ?").get(id);
    if (!p || !p.active) return "Una prenda de la pieza se archivó";
    const snap = post.price_snapshot && post.price_snapshot[id];
    if (snap !== undefined && Number(snap) !== p.price) return `El precio de ${p.name} cambió: vuelve a diseñar la pieza`;
    const like = db.prepare("SELECT id FROM products WHERE active = 1 AND name = ? AND IFNULL(season,'') = IFNULL(?, '') AND IFNULL(color,'') = IFNULL(?, '')").all(p.name, p.season, p.color).map(r => r.id);
    let stock = 0;
    for (const pid of like) {
      const s0 = db.prepare("SELECT stock0 FROM products WHERE id = ?").get(pid).stock0;
      const inn = db.prepare("SELECT COALESCE(SUM(qty),0) q FROM purchases WHERE product_id = ?").get(pid).q;
      const out = db.prepare("SELECT COALESCE(SUM(qty),0) q FROM sale_items WHERE product_id = ?").get(pid).q;
      stock += s0 + inn - out;
    }
    if (stock <= 0) return `${p.name} ${p.color || ""} se agotó`;
  }
  return null;
}
async function publish(id) {
  const post = rowToPost(db.prepare("SELECT * FROM ad_posts WHERE id = ?").get(id) || {});
  if (!post.id || !post.media_file) throw new Error("La pieza aún no está diseñada");
  const problem = preCheck(post);
  if (problem) { db.prepare("UPDATE ad_posts SET status = 'revisar', error = ? WHERE id = ?").run(problem, id); log(id, "-", false, problem); return; }
  db.prepare("UPDATE ad_posts SET status = 'publicando', error = NULL WHERE id = ?").run(id);
  const st = getSettings(), caption = [post.caption, post.hashtags.join(" "), st.storeUrl ? "👉 " + st.storeUrl : ""].filter(Boolean).join("\n\n");
  const results = {}, s = status();
  let url = null;
  for (const net of post.networks) {
    try {
      if (!s[net]) throw new Error("Falta conectar " + net);
      if (net !== "tiktok" && !url) url = await publicUrl(post);
      results[net] = { ok: true, id: net === "facebook" ? await toFacebook(post, url, caption) : net === "instagram" ? await toInstagram(post, url, caption) : await toTikTok(post, caption) };
    } catch (e) { results[net] = { ok: false, error: e.message }; }
    log(id, net, results[net].ok, results[net].ok ? results[net].id : results[net].error);
  }
  const oks = Object.values(results).filter(r => r.ok).length;
  db.prepare("UPDATE ad_posts SET status = ?, results = ?, error = ? WHERE id = ?")
    .run(oks === post.networks.length ? "publicado" : oks ? "parcial" : "error", JSON.stringify(results), oks === post.networks.length ? null : Object.entries(results).filter(([, r]) => !r.ok).map(([n, r]) => `${n}: ${r.error}`).join(" · "), id);
}
// Cada minuto revisa si hay piezas listas cuya hora ya llegó (solo con la publicación automática encendida).
let busy = false;
async function tick(onChange) {
  if (busy || !cfg().auto) return;
  busy = true;
  try {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    const today = db.prepare("SELECT COUNT(*) n FROM ad_posts WHERE status IN ('publicado','parcial') AND scheduled_at >= ?").get(+d).n;
    if (today >= cfg().dailyMax) return;
    const due = db.prepare("SELECT id FROM ad_posts WHERE status = 'listo' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 1").get(Date.now());
    if (due) { await publish(due.id); onChange(); }
  } catch (e) { log(null, "-", false, e.message); }
  finally { busy = false; }
}
async function testConnections() {
  const s = secrets(), out = {};
  try { const t = await ask({ max_tokens: 2000, output_config: { effort: "low" }, messages: [{ role: "user", content: "Responde solo: OK" }] }); out.claude = { ok: /ok/i.test(t), detail: "Claude respondió" }; } catch (e) { out.claude = { ok: false, detail: e.message }; }
  if (s.metaPageId && s.metaPageToken) { try { const j = await graph(s.metaPageId, { fields: "name" }, "GET"); out.facebook = { ok: true, detail: "Página: " + j.name }; } catch (e) { out.facebook = { ok: false, detail: e.message }; } }
  if (s.igUserId && s.metaPageToken) { try { const j = await graph(s.igUserId, { fields: "username" }, "GET"); out.instagram = { ok: true, detail: "Cuenta: @" + j.username }; } catch (e) { out.instagram = { ok: false, detail: e.message }; } }
  if (s.tiktokRefreshToken) { try { const j = await tiktok("/v2/post/publish/creator_info/query/", {}, await tiktokToken()); out.tiktok = { ok: true, detail: "Cuenta: @" + (j.creator_username || "") + (j.privacy_level_options && !j.privacy_level_options.includes("PUBLIC_TO_EVERYONE") ? " · solo publicación privada hasta que TikTok apruebe tu app" : "") }; } catch (e) { out.tiktok = { ok: false, detail: e.message }; } }
  return out;
}
const logRows = () => db.prepare("SELECT * FROM ad_log ORDER BY id DESC LIMIT 60").all();
const latestResearch = () => db.prepare("SELECT created_at, report FROM ad_research ORDER BY id DESC LIMIT 1").get() || null;

module.exports = { status, saveCfg, saveSecrets, research, plan, posts, updatePost, saveMedia, removePost, publish, tick, testConnections,
  musicList, saveMusic, mediaPath, musicPath, logRows, latestResearch, MUSIC };
