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
CREATE INDEX IF NOT EXISTS idx_sales_ts ON sales(ts);
`);

const DEFAULT_SETTINGS = {
  name: "Lechuga & Co.", tagline: "Ropa fresca de temporada", phone: "", currency: "MXN",
  openingCash: 0, fixedAssets: 0, liabilities: 0, storeUrl: "",
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

module.exports = { db, ROOT, DATA, getSettings, saveSettings, hashPassword, checkPassword, createUser, DEFAULT_SETTINGS };
