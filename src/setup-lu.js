/**
 * Crée les rôles et salons des line-ups (Manœuvres), puis remplit LU_ROLE_IDS et
 * LU_SUB_ROLE_ID dans wrangler.toml.
 *
 * Usage :
 *   GUILD_ID=... DISCORD_TOKEN=... node src/setup-lu.js ICENIGHT BOA ...
 *   (ou node --env-file=.dev.vars src/setup-lu.js ...)
 * Un argument qui finit par ":" ouvre une section du panneau :
 *   node src/setup-lu.js "Montée de palier:" ICENIGHT BOA "Full reset:" KENTIN
 * Options (variables d'environnement) :
 *   OFFICER_ROLE_IDS="id1,id2"  rôles qui voient toutes les LU (+ déplacer/rendre muet)
 *   PTT=1                       impose le push-to-talk dans les vocaux des LU
 *
 * Crée (ou réutilise s'ils existent déjà, par nom) :
 *   - la catégorie "Manœuvres" avec le salon "choix-lu" (lecture seule) pour le panneau ;
 *   - le rôle "Remplaçant" et un rôle "LU <NOM>" par LU (sans aucune permission serveur) ;
 *   - une catégorie privée "Remplaçant" (salon texte + vocal) visible par Remplaçant,
 *     toutes les LU et les officiers ;
 *   - une catégorie privée "LU <NOM>" par LU (salon texte + vocal) visible par le rôle
 *     de la LU et les officiers.
 * Ce qui existe déjà est laissé tel quel (sauf l'accès des nouvelles LU aux salons
 * Remplaçant) : relancer avec la liste complète pour ajouter une LU. Les boutons du
 * panneau suivent l'ordre des noms donnés.
 *
 * Le bot doit pouvoir accorder toutes ces permissions : le plus simple est de donner
 * Administrateur à son rôle le temps du script, puis de ne garder que Gérer les rôles.
 */
import { readFileSync, writeFileSync } from "node:fs";

const GUILD = process.env.GUILD_ID;
const TOKEN = process.env.DISCORD_TOKEN;
const OFFICERS = (process.env.OFFICER_ROLE_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
const PTT = process.env.PTT === "1";
const GROUPS = [];
for (const arg of process.argv.slice(2).map((a) => a.trim()).filter(Boolean)) {
  if (arg.endsWith(":")) GROUPS.push({ title: arg.slice(0, -1).trim(), names: [] });
  else {
    if (!GROUPS.length) GROUPS.push({ title: "", names: [] });
    GROUPS.at(-1).names.push(arg);
  }
}
const groups = GROUPS.filter((g) => g.names.length);

if (!GUILD || !TOKEN || !groups.length) {
  console.error("Usage : GUILD_ID=... DISCORD_TOKEN=... node src/setup-lu.js ICENIGHT BOA ...");
  process.exit(1);
}
// Panneau : 4 lignes de 5 boutons pour les LU, chaque section commence une ligne.
if (groups.reduce((n, g) => n + Math.ceil(g.names.length / 5), 0) > 4) {
  console.error("Trop de LU pour le panneau : 4 lignes de 5 boutons max, une section par ligne.");
  process.exit(1);
}

// Permissions Discord (bits)
const P = {
  VIEW: 1n << 10n, SEND: 1n << 11n, REACT: 1n << 6n, EMBED: 1n << 14n, ATTACH: 1n << 15n,
  HISTORY: 1n << 16n, STREAM: 1n << 9n, CONNECT: 1n << 20n, SPEAK: 1n << 21n,
  MUTE: 1n << 22n, MOVE: 1n << 24n, VAD: 1n << 25n, MANAGE_MESSAGES: 1n << 13n,
  MANAGE_CHANNELS: 1n << 4n, PUBLIC_THREADS: 1n << 35n, PRIVATE_THREADS: 1n << 36n,
  THREAD_SEND: 1n << 38n,
};
const bits = (...ps) => ps.reduce((a, b) => a | b, 0n).toString();

const API = "https://discord.com/api/v10";

async function api(method, path, body) {
  for (;;) {
    const r = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${TOKEN}`,
        "content-type": "application/json",
        "X-Audit-Log-Reason": encodeURIComponent("Mise en place des LU"),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429) {  // limite de débit : on attend ce que Discord demande
      const { retry_after = 1 } = await r.json();
      await new Promise((ok) => setTimeout(ok, retry_after * 1000 + 100));
      continue;
    }
    if (!r.ok) {
      const text = await r.text();
      const hint = r.status === 403
        ? "\n-> Le bot manque de permissions : donne Administrateur à son rôle le temps du script."
        : "";
      throw new Error(`${method} ${path} : ${r.status} ${text.slice(0, 300)}${hint}`);
    }
    return r.status === 204 ? null : r.json();
  }
}

const COLORS = [0xe74c3c, 0x3498db, 0x2ecc71, 0xf1c40f, 0x9b59b6, 0x1abc9c, 0xe67e22, 0xe91e63];
const SUB_NAME = "Remplaçant";
const PANEL_CATEGORY = "Manœuvres";
const PANEL_CHANNEL = "choix-lu";

const me = await api("GET", "/users/@me");
const roles = await api("GET", `/guilds/${GUILD}/roles`);
const channels = await api("GET", `/guilds/${GUILD}/channels`);
const report = [];

async function ensureRole(name, color) {
  let role = roles.find((r) => r.name === name);
  if (role) {
    report.push(`= rôle ${name} (${role.id}) déjà là`);
  } else {
    role = await api("POST", `/guilds/${GUILD}/roles`,
      { name, color, permissions: "0", hoist: false, mentionable: true });
    roles.push(role);
    report.push(`+ rôle ${name} (${role.id})`);
  }
  return role;
}

async function ensureChannel(name, type, parentId, overwrites) {
  // Dans une catégorie, on cherche par type (le nom d'un salon texte est normalisé).
  let ch = channels.find((c) => c.type === type &&
    (parentId ? c.parent_id === parentId : c.name === name && !c.parent_id));
  const label = `${type === 4 ? "catégorie" : type === 2 ? "vocal" : "salon"} ${name}`;
  if (ch) {
    report.push(`= ${label} déjà là`);
  } else {
    ch = await api("POST", `/guilds/${GUILD}/channels`,
      { name, type, parent_id: parentId, permission_overwrites: overwrites });
    channels.push(ch);
    report.push(`+ ${label}`);
  }
  return ch;
}

// Salon du panneau en premier (au-dessus des LU) : tout le monde le voit, personne
// n'y écrit (sauf le bot)
const panelCat = await ensureChannel(PANEL_CATEGORY, 4, undefined, []);
const panel = await ensureChannel(PANEL_CHANNEL, 0, panelCat.id, [
  { id: GUILD, type: 0, allow: bits(P.VIEW, P.HISTORY),
    deny: bits(P.SEND, P.REACT, P.PUBLIC_THREADS, P.PRIVATE_THREADS, P.THREAD_SEND) },
  { id: me.id, type: 1, allow: bits(P.VIEW, P.SEND, P.EMBED, P.HISTORY) },
]);

// Rôles
const sub = await ensureRole(SUB_NAME, 0x95a5a6);
const lus = [];
for (const g of groups) {
  g.ids = [];
  for (const n of g.names) {
    const name = /^LU\s/i.test(n) ? n : `LU ${n}`;
    const role = await ensureRole(name, COLORS[lus.length % COLORS.length]);
    lus.push({ name, role });
    g.ids.push(role.id);
  }
}

// Une catégorie privée par rôle (les salons créés dedans reprennent ses permissions)
const player = { type: 0,
  allow: bits(P.VIEW, P.SEND, P.HISTORY, P.REACT, P.EMBED, P.ATTACH, P.CONNECT, P.SPEAK, P.STREAM),
  deny: PTT ? bits(P.VAD) : "0" };
const officer = bits(P.VIEW, P.SEND, P.HISTORY, P.REACT, P.EMBED, P.ATTACH, P.CONNECT, P.SPEAK,
  P.STREAM, P.MOVE, P.MUTE, P.MANAGE_MESSAGES);

async function ensurePrivateCategory(name, roleIds) {
  const overwrites = [
    { id: GUILD, type: 0, deny: bits(P.VIEW) },  // @everyone
    ...roleIds.map((id) => ({ id, ...player })),
    ...OFFICERS.map((id) => ({ id, type: 0, allow: officer })),
    { id: me.id, type: 1, allow: bits(P.VIEW, P.MANAGE_CHANNELS) },  // le bot garde la main
  ];
  const cat = await ensureChannel(name, 4, undefined, overwrites);
  return [
    cat,
    await ensureChannel(name.toLowerCase().replace(/\s+/g, "-"), 0, cat.id, overwrites),
    await ensureChannel(name, 2, cat.id, overwrites),
  ];
}

// Remplaçant : vu par toutes les LU. Sur une relance, les LU ajoutées y reçoivent l'accès.
const luIds = lus.map((l) => l.role.id);
for (const ch of await ensurePrivateCategory(SUB_NAME, [sub.id, ...luIds])) {
  const known = new Set((ch.permission_overwrites || []).map((o) => o.id));
  for (const lu of lus.filter((l) => !known.has(l.role.id))) {
    await api("PUT", `/channels/${ch.id}/permissions/${lu.role.id}`, player);
    report.push(`~ accès ${lu.name} ajouté à ${ch.name}`);
  }
}
for (const lu of lus) await ensurePrivateCategory(lu.name, [lu.role.id]);

// wrangler.toml (sections séparées par "|")
const tomlPath = new URL("../wrangler.toml", import.meta.url);
const titles = groups.some((g) => g.title) ? groups.map((g) => g.title).join("|") : "";
const toml = readFileSync(tomlPath, "utf8")
  .replace(/^LU_ROLE_IDS = ".*"$/m, `LU_ROLE_IDS = "${groups.map((g) => g.ids.join(",")).join("|")}"`)
  .replace(/^LU_GROUPS = ".*"$/m, `LU_GROUPS = "${titles}"`)
  .replace(/^LU_SUB_ROLE_ID = ".*"$/m, `LU_SUB_ROLE_ID = "${sub.id}"`);
writeFileSync(tomlPath, toml);

console.log(report.join("\n"));
console.log(`\nwrangler.toml mis à jour (${lus.length} LU + Remplaçant).`);
console.log(`Salon du panneau : #${panel.name} (${panel.id})`);
console.log("Ensuite : npx wrangler deploy, node src/register.js, puis /panneau-lu dans ce salon.");
