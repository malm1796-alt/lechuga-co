// Configuración inicial: crea la cuenta del administrador.
// Uso:  node server\setup.js              (crear administrador)
//       node server\setup.js --ejemplos   (además, cargar datos de ejemplo para practicar)
const readline = require("node:readline");
const { db, createUser } = require("./db");

function ask(q, hidden = false) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = s => { if (s.includes(q)) process.stdout.write(s); else process.stdout.write("*"); };
    rl.question(q, a => { rl.close(); if (hidden) process.stdout.write("\n"); resolve(a.trim()); });
  });
}

function loadExamples() {
  if (db.prepare("SELECT COUNT(*) n FROM products").get().n) { console.log("  Ya hay productos; no cargo ejemplos."); return; }
  const day = d => { const t = new Date(); t.setHours(12, 0, 0, 0); t.setDate(t.getDate() - d); return +t; };
  const P = [
    ["ex-p1", "Suéter tejido cuello V", "Suéteres", "Otoño-Invierno 2026", "M", "Verde olivo", 349, 160, 12],
    ["ex-p2", "Chamarra acolchada", "Chamarras", "Otoño-Invierno 2026", "G", "Negro", 699, 330, 6],
    ["ex-p3", "Bufanda de punto", "Accesorios", "Otoño-Invierno 2026", "Única", "Mostaza", 149, 55, 15],
    ["ex-p4", "Jeans corte recto", "Pantalones", "Todo el año", "30", "Azul medio", 499, 230, 10],
    ["ex-p5", "Playera básica algodón", "Playeras", "Todo el año", "M", "Blanco", 179, 70, 20],
    ["ex-p6", "Vestido de lino", "Vestidos", "Primavera-Verano 2026", "CH", "Arena", 459, 190, 4],
  ];
  const ip = db.prepare(`INSERT INTO products(id, sku, name, category, season, size, color, price, cost, cost0, stock0, created_at, example) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`);
  const prod = {};
  for (const [id, name, cat, season, size, color, price, cost, stock] of P) { ip.run(id, id.toUpperCase(), name, cat, season, size, color, price, cost, cost, stock, day(30)); prod[id] = { name, size, price, cost }; }
  const S = [[11, [["ex-p1", 1], ["ex-p3", 1]], "Efectivo"], [10, [["ex-p5", 2]], "Tarjeta"], [9, [["ex-p2", 1]], "Transferencia", "WhatsApp"],
    [7, [["ex-p4", 1], ["ex-p5", 1]], "Efectivo"], [6, [["ex-p1", 2]], "Tarjeta"], [5, [["ex-p6", 1]], "Efectivo"], [4, [["ex-p3", 2]], "Efectivo"],
    [3, [["ex-p1", 1], ["ex-p2", 1]], "Tarjeta", "WhatsApp"], [2, [["ex-p4", 2]], "Transferencia"], [1, [["ex-p5", 3]], "Efectivo"], [0, [["ex-p2", 1], ["ex-p3", 1]], "Tarjeta"]];
  const is = db.prepare("INSERT INTO sales(id, ts, subtotal, total, method, channel, example) VALUES (?,?,?,?,?,?,1)");
  const ii = db.prepare("INSERT INTO sale_items(sale_id, product_id, name, size, qty, price, cost) VALUES (?,?,?,?,?,?,?)");
  S.forEach(([d, items, method, channel], n) => {
    const sub = items.reduce((a, [pid, q]) => a + q * prod[pid].price, 0), id = "ex-s" + n;
    is.run(id, day(d) - n * 60e3, sub, sub, method, channel || "Tienda");
    for (const [pid, q] of items) ii.run(id, pid, prod[pid].name, prod[pid].size, q, prod[pid].price, prod[pid].cost);
  });
  const ie = db.prepare("INSERT INTO expenses(id, ts, category, concept, amount, method, example) VALUES (?,?,?,?,?,?,1)");
  [["ex-e1", 25, "Renta", "Renta del mes", 6500, "Transferencia"], ["ex-e2", 15, "Nómina", "Quincena vendedora", 3200, "Efectivo"],
   ["ex-e3", 12, "Luz y agua", "CFE bimestre", 780, "Transferencia"], ["ex-e4", 8, "Publicidad", "Anuncio en Facebook", 400, "Tarjeta"],
   ["ex-e5", 2, "Retiro del dueño", "Retiro semanal", 1500, "Efectivo"]].forEach(([id, d, c, k, a, m]) => ie.run(id, day(d), c, k, a, m));
  db.prepare("INSERT INTO purchases(id, type, ts, product_id, qty, unit_cost, total, supplier, method, example) VALUES ('ex-b1','compra',?,'ex-p1',6,160,960,'Textiles del Bajío','Transferencia',1)").run(day(14));
  console.log("  Datos de ejemplo cargados. Bórralos en Ajustes antes de vender en serio.");
}

(async () => {
  const admins = db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin'").get().n;
  if (admins && process.argv.includes("--si-falta")) return; // iniciar.bat: ya hay administrador
  console.log("\n  Lechuga & Co. — configuración inicial\n");
  if (admins) console.log("  Ya existe un administrador. Puedes crear otro o cerrar con Ctrl+C.\n");
  const name = await ask("  Tu nombre: ");
  let username;
  for (;;) { username = (await ask("  Usuario para entrar (sin espacios): ")).toLowerCase(); if (/^[a-z0-9._-]{3,30}$/.test(username)) break; console.log("  Usa de 3 a 30 letras o números, sin espacios."); }
  let password;
  for (;;) {
    password = await ask("  Contraseña (mínimo 8 caracteres): ", true);
    if (password.length < 8) { console.log("  Muy corta."); continue; }
    if ((await ask("  Repite la contraseña: ", true)) === password) break;
    console.log("  No coinciden, intenta de nuevo.");
  }
  try { createUser({ username, name: name || username, role: "admin", password }); }
  catch { console.log("\n  Ese usuario ya existe."); process.exit(1); }
  console.log(`\n  Listo: administrador «${username}» creado.`);
  if (process.argv.includes("--ejemplos")) loadExamples();
  console.log("  Ahora enciende el servidor con iniciar.bat y entra a http://localhost:8787/caja/\n");
})();
