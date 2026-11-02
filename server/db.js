// Base de datos local de Lechuga & Co. (SQLite integrado en Node 22.5+).
// El archivo vive en C:\LechugaCo\data\lechuga.db y nunca se sube a GitHub.
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
fs.mkdirSync(DATA, { recursive: true });

const db = new DatabaseSync(process.env.LECHUGA_DB || path.join(DATA, "lechuga.db"));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','vendedor')),
  salt TEXT NOT NULL, hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY, sku TEXT, name TEXT NOT NULL, category TEXT, season TEXT, size TEXT, color TEXT,
  price REAL NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, cost0 REAL NOT NULL DEFAULT 0,
  stock0 INTEGER NOT NULL DEFAULT 0, image_url TEXT, description TEXT,
  active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, example INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS photos (product_id TEXT PRIMARY KEY, jpeg BLOB NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL, subtotal REAL NOT NULL, total REAL NOT NULL,
  method TEXT NOT NULL, channel TEXT NOT NULL, customer TEXT, phone TEXT,
  user_id INTEGER, example INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY, sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id TEXT, name TEXT, size TEXT, qty INTEGER NOT NULL, price REAL NOT NULL, cost REAL NOT NULL);
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL, category TEXT NOT NULL, concept TEXT, amount REAL NOT NULL,
  method TEXT, user_id INTEGER, example INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK (type IN ('compra','ajuste')), ts INTEGER NOT NULL,
  product_id TEXT NOT NULL, qty INTEGER NOT NULL, unit_cost REAL NOT NULL, total REAL NOT NULL,
  supplier TEXT, method TEXT, reason TEXT, user_id INTEGER, example INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_items_sale ON sale_items(sale_id);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT UNIQUE NOT NULL, email TEXT,
  source TEXT NOT NULL DEFAULT 'caja', created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_sales_ts ON sales(ts);
`);

// Las fotos guardan su formato original (jpg, png o webp); las bases creadas antes solo tenían jpg.
if (!db.prepare("PRAGMA table_info(photos)").all().some(c => c.name === "mime"))
  db.exec("ALTER TABLE photos ADD COLUMN mime TEXT NOT NULL DEFAULT 'image/jpeg'");
const PHOTO_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
// Qué promoción usó cada venta (vacío = ninguna); la de primera compra se valida contra el teléfono del cliente.
if (!db.prepare("PRAGMA table_info(sales)").all().some(c => c.name === "promo"))
  db.exec("ALTER TABLE sales ADD COLUMN promo TEXT NOT NULL DEFAULT ''");
// Teléfono normalizado a 10 dígitos de México (quita lada 52 o 521 y todo lo que no sea número).
const phoneKey = p => { let d = String(p || "").replace(/\D/g, ""); if (d.length === 13 && d.startsWith("521")) d = d.slice(3); else if (d.length === 12 && d.startsWith("52")) d = d.slice(2); return d; };

const DEFAULT_SETTINGS = {
  name: "Lechuga & Co.", tagline: "American Clothing desde 1990", phone: "", currency: "MXN",
  openingCash: 0, fixedAssets: 0, liabilities: 0, storeUrl: "",
  categories: ["Playeras", "Blusas", "Camisas", "Suéteres", "Pantalones", "Vestidos", "Chamarras", "Calzado", "Accesorios", "Infantil"],
  seasons: ["Otoño-Invierno 2026", "Primavera-Verano 2027", "Todo el año"],
  city: "Chihuahua, Chihuahua",
  promo: { active: true, title: "Compra anticipada", percent: 10, minimum: 1000, end: "2026-11-30" },
  // Descuento para todos los clientes en unas fechas (no se acumula con el de primera compra: se usa el mayor).
  sale: { active: true, title: "Buen Fin", percent: 10, minimum: 0, start: "2026-11-10", end: "2026-11-17" },
};

function getSettings() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'business'").get();
  return { ...DEFAULT_SETTINGS, ...(row ? JSON.parse(row.value) : {}) };
}
function saveSettings(s) {
  db.prepare("INSERT INTO settings(key, value) VALUES ('business', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(s));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 210000, 32, "sha256").toString("hex");
  return { salt, hash };
}
function checkPassword(password, salt, hash) {
  const h = Buffer.from(hashPassword(password, salt).hash, "hex");
  return crypto.timingSafeEqual(h, Buffer.from(hash, "hex"));
}
function createUser({ username, name, role, password }) {
  const { salt, hash } = hashPassword(password);
  db.prepare("INSERT INTO users(username, name, role, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(username.trim().toLowerCase(), name.trim(), role, salt, hash, Date.now());
}

module.exports = { db, ROOT, DATA, getSettings, saveSettings, hashPassword, checkPassword, createUser, DEFAULT_SETTINGS, PHOTO_EXT, phoneKey };
