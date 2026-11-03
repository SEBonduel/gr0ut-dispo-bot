/**
 * Crée les rôles et salons des line-ups (Manœuvres), puis remplit LU_ROLE_IDS,
 * LU_GROUPS, LU_SUB_ROLE_ID et LU_SUB_CHANNEL_IDS dans wrangler.toml.
 *
 * Usage :
 *   node --env-file=.dev.vars src/setup-lu.js "Montée de palier:" ICENIGHT BOA "Full reset:" KENTIN
 * Un argument qui finit par ":" ouvre une section du panneau.
 * Variables d'environnement (.dev.vars) :
 *   GUILD_ID, DISCORD_TOKEN
 *   MEMBER_ROLE_IDS="id1,id2"   commu interne : voit la catégorie et le salon du panneau
 *                               (sans cette variable : tout le serveur)
 *   OFFICER_ROLE_IDS="id1,id2"  rôles qui voient toutes les LU (+ déplacer/rendre muet)
 *   PTT=1                       impose le push-to-talk dans les vocaux des LU
 *
 * Tout va dans la catégorie Manœuvres, au style des salons du serveur (src/lu-style.js) :
 *   - 📋Rôles-LU : le panneau, lisible par la commu interne, personne n'y écrit ;
 *   - les rôles "Remplaçant" et "LU <NOM>" (sans aucune permission serveur) ;
 *   - 💬Remplaçant (texte) et 🔄 Remplaçant (vocal) : visible par Remplaçant, toutes les LU et les officiers ;
 *   - 💬LU-<NOM> (texte) et ⚔️ LU <NOM> (vocal) par LU : visible par le rôle de la LU et
 *     les officiers.
 * Ce qui existe déjà (même nom) est laissé tel quel, sauf les accès qui manquent (nouvelles
 * LU aux salons Remplaçant, officiers ajoutés à OFFICER_ROLE_IDS) : relancer avec la liste
 * complète pour ajouter une LU. Les boutons du panneau suivent l'ordre des noms donnés.
 *
 * Le bot doit pouvoir accorder toutes ces permissions : le plus simple est de donner
 * Administrateur à son rôle le temps du script, puis de ne garder que Gérer les rôles.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { categoryName, textName, voiceName } from "./lu-style.js";

const GUILD = process.env.GUILD_ID;
const TOKEN = process.env.DISCORD_TOKEN;
const idList = (v) => (v || "").split(",").map((s) => s.trim()).filter(Boolean);
const MEMBERS = idList(process.env.MEMBER_ROLE_IDS);
const OFFICERS = idList(process.env.OFFICER_ROLE_IDS);
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
  console.error("Usage : node --env-file=.dev.vars src/setup-lu.js ICENIGHT BOA ...");
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
  THREAD_SEND: 1n << 38n, APP_COMMANDS: 1n << 31n, ACTIVITIES: 1n << 39n,
  VOICE_MESSAGES: 1n << 46n, POLLS: 1n << 49n, EXTERNAL_APPS: 1n << 50n,
  MENTION_EVERYONE: 1n << 17n,
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
const CATEGORY = categoryName("Manoeuvres");  // ────────── 𝕄𝕒𝕟𝕠𝕖𝕦𝕧𝕣𝕖𝕤 ──────────
// Salons texte en 💬 ; vocaux : 🔄 pour Remplaçant, ⚔️ pour les LU.
const PANEL_EMOJI = "📋", TEXT_EMOJI = "💬", SUB_VOICE_EMOJI = "🔄", LU_VOICE_EMOJI = "⚔️";

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
  let ch = channels.find((c) => c.type === type && c.name === name &&
    (c.parent_id ?? undefined) === parentId);
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

const hidden = { id: GUILD, type: 0, deny: bits(P.VIEW) };  // @everyone
const bot = (...ps) => ({ id: me.id, type: 1, allow: bits(P.VIEW, ...ps) });  // le bot garde la main
// Panneau en lecture stricte : ni message, ni réaction, ni fil, ni commande / d'un autre
// bot ou appli (leurs réponses s'afficheraient dans le salon). Les admins passent outre.
const NO_WRITE = [P.SEND, P.REACT, P.PUBLIC_THREADS, P.PRIVATE_THREADS, P.THREAD_SEND,
  P.APP_COMMANDS, P.ACTIVITIES, P.VOICE_MESSAGES, P.POLLS, P.EXTERNAL_APPS];

// Catégorie et salon du panneau : commu interne (ou tout le serveur), personne n'écrit
// dans le panneau sauf le bot. Créés en premier pour être en haut de la catégorie.
const cat = await ensureChannel(CATEGORY, 4, undefined, MEMBERS.length
  ? [hidden, ...MEMBERS.map((id) => ({ id, type: 0, allow: bits(P.VIEW) })), bot(P.MANAGE_CHANNELS)]
  : [bot(P.MANAGE_CHANNELS)]);
const panel = await ensureChannel(textName(PANEL_EMOJI, "Rôles LU"), 0, cat.id, MEMBERS.length
  ? [{ id: GUILD, type: 0, deny: bits(P.VIEW, ...NO_WRITE) },
     ...MEMBERS.map((id) => ({ id, type: 0, allow: bits(P.VIEW, P.HISTORY) })),
     bot(P.SEND, P.EMBED, P.HISTORY, P.MENTION_EVERYONE)]
  : [{ id: GUILD, type: 0, allow: bits(P.VIEW, P.HISTORY), deny: bits(...NO_WRITE) },
     bot(P.SEND, P.EMBED, P.HISTORY, P.MENTION_EVERYONE)]);

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

// Salons privés (texte + vocal) de chaque rôle, avec leurs propres permissions
const player = { type: 0,
  allow: bits(P.VIEW, P.SEND, P.HISTORY, P.REACT, P.EMBED, P.ATTACH, P.CONNECT, P.SPEAK, P.STREAM),
  deny: PTT ? bits(P.VAD) : "0" };
const officer = bits(P.VIEW, P.SEND, P.HISTORY, P.REACT, P.EMBED, P.ATTACH, P.CONNECT, P.SPEAK,
  P.STREAM, P.MOVE, P.MUTE, P.MANAGE_MESSAGES);

// Sur un salon déjà là, ajoute les accès qui lui manquent : [id du rôle, permissions, nom]
async function grantMissing(ch, grants) {
  const known = new Set((ch.permission_overwrites || []).map((o) => o.id));
  for (const [id, overwrite, label] of grants.filter(([id]) => !known.has(id))) {
    await api("PUT", `/channels/${ch.id}/permissions/${id}`, overwrite);
    report.push(`~ accès ${label} ajouté à ${ch.name}`);
  }
}

async function ensurePrivateChannels([textEmoji, voiceEmoji], name, roleIds) {
  const overwrites = [
    hidden,
    ...roleIds.map((id) => ({ id, ...player })),
    ...OFFICERS.map((id) => ({ id, type: 0, allow: officer })),
    bot(P.MANAGE_CHANNELS),
  ];
  const chans = [
    await ensureChannel(textName(textEmoji, name), 0, cat.id, overwrites),
    await ensureChannel(voiceName(voiceEmoji, name), 2, cat.id, overwrites),
  ];
  // Officiers ajoutés depuis la création : ils reçoivent l'accès aux salons existants
  const officers = OFFICERS.map((id) =>
    [id, { type: 0, allow: officer }, roles.find((r) => r.id === id)?.name ?? id]);
  for (const ch of chans) await grantMissing(ch, officers);
  return chans;
}

// Remplaçant : vu par toutes les LU. Sur une relance, les LU ajoutées y reçoivent l'accès.
const luIds = lus.map((l) => l.role.id);
const subChannels = await ensurePrivateChannels([TEXT_EMOJI, SUB_VOICE_EMOJI], SUB_NAME, [sub.id, ...luIds]);
for (const ch of subChannels) await grantMissing(ch, lus.map((l) => [l.role.id, player, l.name]));
for (const lu of lus) await ensurePrivateChannels([TEXT_EMOJI, LU_VOICE_EMOJI], lu.name, [lu.role.id]);

// wrangler.toml (sections séparées par "|")
const tomlPath = new URL("../wrangler.toml", import.meta.url);
const titles = groups.some((g) => g.title) ? groups.map((g) => g.title).join("|") : "";
const toml = readFileSync(tomlPath, "utf8")
  .replace(/^LU_ROLE_IDS = ".*"$/m, `LU_ROLE_IDS = "${groups.map((g) => g.ids.join(",")).join("|")}"`)
  .replace(/^LU_GROUPS = ".*"$/m, `LU_GROUPS = "${titles}"`)
  .replace(/^LU_SUB_ROLE_ID = ".*"$/m, `LU_SUB_ROLE_ID = "${sub.id}"`)
  .replace(/^LU_SUB_CHANNEL_IDS = ".*"$/m, `LU_SUB_CHANNEL_IDS = "${subChannels.map((c) => c.id).join(",")}"`);
writeFileSync(tomlPath, toml);

console.log(report.join("\n"));
console.log(`\nwrangler.toml mis à jour (${lus.length} LU + Remplaçant).`);
console.log(`Salon du panneau : #${panel.name} (${panel.id})`);
console.log("Ensuite : npx wrangler deploy, node src/register.js, puis /panneau-lu dans ce salon.");
