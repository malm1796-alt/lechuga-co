// Abre el túnel de Cloudflare hacia el servidor local y avisa a la caja en GitHub de la nueva dirección.
// La dirección gratuita (trycloudflare.com) cambia en cada arranque: por eso se reescribe docs/config.json y se sube.
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 8787);
const CANDIDATES = ["C:\\Program Files (x86)\\cloudflared\\cloudflared.exe", "C:\\Program Files\\cloudflared\\cloudflared.exe", "cloudflared"];
const exe = CANDIDATES.find(p => p === "cloudflared" || fs.existsSync(p));

const git = args => new Promise(resolve => execFile("git", ["-C", ROOT, ...args], { windowsHide: true, timeout: 120e3 },
  (err, out, errOut) => resolve({ ok: !err, out: (out + errOut).trim() })));

async function announce(url) {
  const file = path.join(ROOT, "docs", "config.json");
  fs.writeFileSync(file, JSON.stringify({ api: url, updatedAt: new Date().toISOString() }, null, 1) + "\n");
  console.log(`\n  Túnel abierto: ${url}`);
  if (!fs.existsSync(path.join(ROOT, ".git"))) { console.log("  (La carpeta aún no está conectada a GitHub.)"); return; }
  if (process.env.LECHUGA_DB) { console.log("  (Modo de prueba: no se sube a GitHub.)"); return; }
  await git(["add", "docs/config.json"]);
  await git(["commit", "-m", "Actualiza la dirección del túnel"]);
  const p = await git(["push"]);
  console.log(p.ok ? "  La caja en GitHub ya conoce la nueva dirección (tarda 1 o 2 minutos en publicarse)."
    : "  No se pudo avisar a GitHub: " + p.out.slice(0, 200));
}

function start() {
  console.log("  Abriendo túnel de internet…");
  const cf = spawn(exe, ["tunnel", "--no-autoupdate", "--url", `http://localhost:${PORT}`], { windowsHide: true });
  let announced = false, fails = 0, watch = null;
  const scan = buf => {
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(buf.toString());
    if (m && !announced) {
      announced = true; announce(m[0]);
      // Vigilante: la dirección gratuita a veces deja de responder aunque cloudflared siga vivo
      // (cortes de internet, la PC se suspende). Si falla 3 veces seguidas, se reinicia y se anuncia una nueva.
      watch = setInterval(async () => {
        try { const r = await fetch(m[0] + "/api/salud", { signal: AbortSignal.timeout(15e3) }); fails = r.ok ? 0 : fails + 1; }
        catch { fails++; }
        if (fails >= 3) { console.log("  El túnel dejó de responder. Abriendo uno nuevo…"); clearInterval(watch); cf.kill(); }
      }, 60e3);
    }
  };
  cf.stdout.on("data", scan);
  cf.stderr.on("data", scan);
  cf.on("exit", code => {
    if (watch) clearInterval(watch);
    console.log(`  El túnel se cerró (código ${code}). Reintentando en 10 segundos…`);
    setTimeout(start, 10e3);
  });
}
start();
