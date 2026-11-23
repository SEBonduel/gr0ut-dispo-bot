/**
 * Annonces des lives Twitch dans le salon Stream (remplace Streamcord).
 *
 * - /stream-ajouter pseudo [membre] : un membre du clan (STREAM_ROLE_IDS) inscrit sa
 *   chaîne (une seule) ; un officier peut inscrire celle d'un autre membre. Le
 *   propriétaire de la chaîne reçoit le rôle STREAMER_ROLE_ID (TWITCH) s'il ne l'a pas.
 * - /stream-retirer [pseudo] : retire sa chaîne (un officier peut retirer n'importe laquelle).
 * - /stream-liste : chaînes inscrites et état de leur abonnement Twitch.
 *
 * Pour chaque chaîne, le bot ouvre chez Twitch un abonnement EventSub "stream.online" :
 * Twitch appelle POST /twitch dès que le live démarre (pas de cron, pas de sondage), et
 * le bot poste l'annonce dans STREAM_CHANNEL_ID.
 *
 * Secrets : TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET (appli de dev.twitch.tv),
 *   TWITCH_EVENTSUB_SECRET (10 à 100 caractères, signe les appels de Twitch).
 * Vars : STREAM_CHANNEL_ID, STREAM_PING ("everyone", id de rôle, ou vide),
 *   STREAM_ROLE_IDS (rôles qui peuvent s'inscrire eux-mêmes ; vide = tout le monde),
 *   STREAMER_ROLE_ID (rôle donné aux streamers inscrits ; vide = aucun).
 * KV (DISPO) : "streams" = { idTwitch: { login, name, discordId, subId, addedBy, addedAt } },
 *   "twitch:token" (jeton d'appli), "stream_live:<idTwitch>" (dernier live annoncé),
 *   "stream_last" (trace de la dernière annonce, pour diagnostic).
 */

const API = "https://discord.com/api/v10";
const HELIX = "https://api.twitch.tv/helix";

const ADMINISTRATOR = 8n;
const MANAGE_GUILD = 32n;
const MANAGE_ROLES = 268435456n;

export const STREAM_COMMANDS = new Set(["stream-ajouter", "stream-retirer", "stream-liste"]);

const esc = (s) => String(s).replace(/([\\*_~`|])/g, "\\$1");
const link = (login) => `[twitch.tv/${login}](<https://twitch.tv/${login}>)`;

// --- Twitch --------------------------------------------------------------------

const twitchReady = (env) =>
  Boolean(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET && env.TWITCH_EVENTSUB_SECRET);

/** Jeton d'appli Twitch (client credentials), gardé en KV jusqu'à son expiration. */
async function appToken(env, force = false) {
  if (!force) {
    const cached = await env.DISPO.get("twitch:token", "json");
    if (cached?.token && cached.exp > Date.now() + 60_000) return cached.token;
  }
  const r = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  if (!r.ok) throw new Error(`Twitch refuse les identifiants de l'appli (${r.status})`);
  const { access_token: token, expires_in: ttl } = await r.json();
  await env.DISPO.put("twitch:token", JSON.stringify({ token, exp: Date.now() + ttl * 1000 }),
    { expirationTtl: Math.max(60, ttl - 300) });
  return token;
}

/** Appel à l'API Helix ; un 401 (jeton expiré ou révoqué) relance une fois avec un jeton neuf. */
async function helix(env, method, path, body) {
  let r;
  for (const force of [false, true]) {
    r = await fetch(HELIX + path, {
      method,
      headers: {
        "Client-Id": env.TWITCH_CLIENT_ID,
        Authorization: `Bearer ${await appToken(env, force)}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status !== 401) break;
  }
  return r;
}

async function twitchUser(env, query) {
  const r = await helix(env, "GET", `/users?${query}`);
  if (!r.ok) throw new Error(`Twitch ne répond pas (${r.status})`);
  return (await r.json()).data?.[0] || null;
}

/** Abonnements "stream.online" de l'appli pour une chaîne. */
async function findSubs(env, broadcasterId) {
  const r = await helix(env, "GET", `/eventsub/subscriptions?user_id=${broadcasterId}`);
  if (!r.ok) throw new Error(`Twitch ne répond pas (${r.status})`);
  return ((await r.json()).data || []).filter((s) =>
    s.type === "stream.online" && s.condition?.broadcaster_user_id === broadcasterId);
}

const deleteSub = (env, id) => helix(env, "DELETE", `/eventsub/subscriptions?id=${id}`);

/** Garde un abonnement actif vers `callback` (recrée ceux en échec ou vers une autre URL). */
async function ensureSub(env, broadcasterId, callback) {
  const subs = await findSubs(env, broadcasterId);
  const good = subs.find((s) => s.transport?.callback === callback &&
    (s.status === "enabled" || s.status === "webhook_callback_verification_pending"));
  if (good) return good.id;
  for (const s of subs) await deleteSub(env, s.id);
  const r = await helix(env, "POST", "/eventsub/subscriptions", {
    type: "stream.online",
    version: "1",
    condition: { broadcaster_user_id: broadcasterId },
    transport: { method: "webhook", callback, secret: env.TWITCH_EVENTSUB_SECRET },
  });
  if (r.status !== 202) {
    throw new Error(`Twitch refuse l'abonnement (${r.status} : ${(await r.text()).slice(0, 200)})`);
  }
  return (await r.json()).data[0].id;
}

/** État des abonnements de l'appli, par chaîne ("enabled" prioritaire). */
async function subStatuses(env) {
  const out = {};
  let cursor = "";
  for (let i = 0; i < 10; i++) {
    const r = await helix(env, "GET",
      `/eventsub/subscriptions?type=stream.online${cursor ? `&after=${cursor}` : ""}`);
    if (!r.ok) throw new Error(`Twitch ne répond pas (${r.status})`);
    const page = await r.json();
    for (const s of page.data || []) {
      const id = s.condition?.broadcaster_user_id;
      if (id && out[id] !== "enabled") out[id] = s.status;
    }
    cursor = page.pagination?.cursor;
    if (!cursor) break;
  }
  return out;
}

/** Signature EventSub : HMAC-SHA256(secret, id + horodatage + corps brut). */
async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// --- Stockage -------------------------------------------------------------------

const loadStreams = async (env) => (await env.DISPO.get("streams", "json")) || {};
const saveStreams = (env, streams) => env.DISPO.put("streams", JSON.stringify(streams));

/** Accepte "vuxor1er", "@vuxor1er" ou un lien twitch.tv ; null si invalide. */
export function parseLogin(input) {
  const s = String(input || "").trim().toLowerCase()
    .replace(/^@/, "")
    .replace(/^(https?:\/\/)?((www|m)\.)?twitch\.tv\//, "")
    .split(/[/?#]/)[0];
  return /^[a-z0-9_]{2,25}$/.test(s) ? s : null;
}

// --- Annonce --------------------------------------------------------------------

function pingFor(env) {
  const p = String(env.STREAM_PING || "").trim().replace(/^@/, "");
  if (p === "everyone" || p === "here") return { text: `@${p} `, allowed: { parse: ["everyone"] } };
  if (/^\d+$/.test(p)) return { text: `<@&${p}> `, allowed: { parse: [], roles: [p] } };
  return { text: "", allowed: { parse: [] } };
}

/** Message d'annonce (le membre Discord est cité sans être pingé). */
export function buildAnnouncement(env, s) {
  const url = `https://twitch.tv/${s.login}`;
  const ping = pingFor(env);
  const who = s.discordId ? ` (<@${s.discordId}>)` : "";
  const embed = {
    author: { name: `${s.name} est en live sur Twitch`, url, ...(s.avatar ? { icon_url: s.avatar } : {}) },
    title: (s.title || "Live sur Twitch").slice(0, 256),
    url,
    color: 0x9146ff,
    fields: [{ name: "Jeu", value: (s.game || "-").slice(0, 1024), inline: true }],
    footer: { text: `twitch.tv/${s.login}` },
    timestamp: s.startedAt || new Date().toISOString(),
  };
  // Aperçu du live (paramètre anti-cache : Discord garde les images par URL)
  if (s.thumb) embed.image = { url: `${s.thumb}?t=${Date.now()}` };
  else if (s.avatar) embed.thumbnail = { url: s.avatar };
  return {
    content: `${ping.text}🔴 **${esc(s.name)}**${who} est en live !`,
    embeds: [embed],
    components: [{ type: 1, components: [{ type: 2, style: 5, label: "Regarder le live", url }] }],
    allowed_mentions: ping.allowed,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Titre, jeu, aperçu et avatar du live ; tout est facultatif (l'annonce part quand même). */
async function streamDetails(env, ev) {
  const d = {};
  try {
    // Juste après le démarrage, /streams peut encore être vide : on réessaie un peu.
    for (const wait of [0, 4000, 8000]) {
      if (wait) await sleep(wait);
      const r = await helix(env, "GET", `/streams?user_id=${ev.broadcaster_user_id}`);
      const live = r.ok ? (await r.json()).data?.[0] : null;
      if (live) {
        Object.assign(d, { title: live.title, game: live.game_name,
          thumb: live.thumbnail_url?.replace("{width}", "1280").replace("{height}", "720") });
        break;
      }
    }
    if (!d.title) {
      const r = await helix(env, "GET", `/channels?broadcaster_id=${ev.broadcaster_user_id}`);
      const ch = r.ok ? (await r.json()).data?.[0] : null;
      if (ch) Object.assign(d, { title: ch.title, game: ch.game_name });
    }
    const user = await twitchUser(env, `id=${ev.broadcaster_user_id}`);
    if (user) d.avatar = user.profile_image_url;
  } catch (e) { /* Twitch indisponible : annonce minimale */ }
  return d;
}

async function onStreamOnline(env, ev, sub) {
  const streams = await loadStreams(env);
  const entry = streams[ev.broadcaster_user_id];
  if (!entry) {
    // Chaîne retirée mais abonnement resté chez Twitch : on le coupe.
    await deleteSub(env, sub.id).catch(() => {});
    return;
  }
  // Twitch peut renvoyer le même événement : une seule annonce par live.
  const liveKey = `stream_live:${ev.broadcaster_user_id}`;
  if ((await env.DISPO.get(liveKey)) === ev.id) return;
  await env.DISPO.put(liveKey, ev.id, { expirationTtl: 7 * 86400 });

  const details = await streamDetails(env, ev);
  const r = await fetch(`${API}/channels/${env.STREAM_CHANNEL_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${env.DISCORD_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(buildAnnouncement(env, {
      login: ev.broadcaster_user_login, name: ev.broadcaster_user_name,
      discordId: entry.discordId, startedAt: ev.started_at, ...details,
    })),
  });
  await env.DISPO.put("stream_last", JSON.stringify({
    at: new Date().toISOString(), login: ev.broadcaster_user_login, status: r.status,
    detail: r.ok ? "" : (await r.text()).slice(0, 300),
  }));

  // Pseudo Twitch changé depuis l'inscription : on met la fiche à jour.
  if (entry.login !== ev.broadcaster_user_login || entry.name !== ev.broadcaster_user_name) {
    const fresh = await loadStreams(env);
    if (fresh[ev.broadcaster_user_id]) {
      Object.assign(fresh[ev.broadcaster_user_id],
        { login: ev.broadcaster_user_login, name: ev.broadcaster_user_name });
      await saveStreams(env, fresh);
    }
  }
}

/** POST /twitch : appels EventSub de Twitch (vérification, annonces, révocations). */
export async function handleTwitchWebhook(request, env, ctx) {
  const raw = await request.text();
  const id = request.headers.get("twitch-eventsub-message-id");
  const ts = request.headers.get("twitch-eventsub-message-timestamp");
  const sig = request.headers.get("twitch-eventsub-message-signature") || "";
  const type = request.headers.get("twitch-eventsub-message-type");
  if (!env.TWITCH_EVENTSUB_SECRET || !id || !ts) return new Response("Bad request", { status: 400 });

  const expected = `sha256=${await hmacHex(env.TWITCH_EVENTSUB_SECRET, id + ts + raw)}`;
  if (!sameString(sig, expected)) return new Response("Bad signature", { status: 403 });
  // Message rejoué : Twitch demande de refuser au-delà de 10 minutes.
  if (!(Math.abs(Date.now() - Date.parse(ts)) <= 10 * 60_000)) {
    return new Response("Too old", { status: 403 });
  }

  const body = JSON.parse(raw);
  if (type === "webhook_callback_verification") {
    return new Response(body.challenge, { headers: { "content-type": "text/plain" } });
  }
  if (type === "notification" && body.subscription?.type === "stream.online") {
    ctx.waitUntil(onStreamOnline(env, body.event, body.subscription).catch((e) =>
      env.DISPO.put("stream_last", JSON.stringify({ at: new Date().toISOString(), error: e.message }))));
  } else if (type === "revocation") {
    // Abonnement coupé par Twitch (chaîne supprimée, trop d'échecs...) : /stream-liste le
    // signale, et relancer /stream-ajouter le recrée.
    ctx.waitUntil(env.DISPO.put("stream_last", JSON.stringify({
      at: new Date().toISOString(), revoked: body.subscription?.condition?.broadcaster_user_id,
      status: body.subscription?.status,
    })));
  }
  return new Response(null, { status: 204 });
}

// --- Commandes ------------------------------------------------------------------

const option = (i, name) => i.data?.options?.find((o) => o.name === name)?.value;

const isStaff = (i) =>
  (BigInt(i.member?.permissions || 0) & (ADMINISTRATOR | MANAGE_GUILD | MANAGE_ROLES)) !== 0n;

function mayRegister(i, env) {
  const allowed = String(env.STREAM_ROLE_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return !allowed.length || (i.member?.roles || []).some((r) => allowed.includes(r));
}

const NOT_READY = "❌ Le bot n'a pas encore ses clés Twitch : préviens un admin.";

async function addStream(i, env, origin) {
  if (!twitchReady(env)) return NOT_READY;
  const uid = i.member.user.id;
  const staff = isStaff(i);
  const login = parseLogin(option(i, "pseudo"));
  if (!login) return "❌ Pseudo Twitch invalide : donne ton pseudo (ex. `vuxor1er`) ou le lien de ta chaîne.";
  const owner = option(i, "membre") || uid;
  if (owner !== uid && !staff) return "❌ Seuls les officiers peuvent inscrire la chaîne d'un autre membre.";
  if (!staff && !mayRegister(i, env)) return "❌ L'inscription des chaînes est réservée aux membres du clan.";

  const user = await twitchUser(env, `login=${login}`);
  if (!user) return `❌ Aucune chaîne Twitch ne s'appelle « ${esc(login)} ».`;

  const before = await loadStreams(env);
  const existing = before[user.id];
  if (existing && existing.discordId !== uid && !staff) {
    return `❌ ${link(user.login)} est déjà inscrite par <@${existing.discordId}>.`;
  }
  if (!existing && !staff) {
    const mine = Object.values(before).find((s) => s.discordId === uid);
    if (mine) {
      return `❌ Tu as déjà inscrit **${esc(mine.name)}** (une chaîne par membre) : ` +
        "retire-la d'abord avec `/stream-retirer`.";
    }
  }

  const subId = await ensureSub(env, user.id, `${origin}/twitch`);
  const streams = await loadStreams(env);
  streams[user.id] = {
    login: user.login, name: user.display_name,
    discordId: existing && !option(i, "membre") ? existing.discordId : owner,
    subId, addedBy: uid, addedAt: existing?.addedAt || new Date().toISOString(),
  };
  await saveStreams(env, streams);
  const where = env.STREAM_CHANNEL_ID ? `<#${env.STREAM_CHANNEL_ID}>` : "le salon Stream";
  return (existing
    ? `✅ **${esc(user.display_name)}** (${link(user.login)}) était déjà inscrite : abonnement Twitch vérifié.`
    : `✅ **${esc(user.display_name)}** (${link(user.login)}) est inscrite : chaque live sera annoncé dans ${where}.`) +
    await giveStreamerRole(i, env, streams[user.id].discordId);
}

/** Donne le rôle des streamers (STREAMER_ROLE_ID) au propriétaire s'il ne l'a pas déjà. */
async function giveStreamerRole(i, env, ownerId) {
  const roleId = String(env.STREAMER_ROLE_ID || "").trim();
  if (!roleId) return "";
  const auth = { Authorization: `Bot ${env.DISCORD_TOKEN}` };
  const memberUrl = `${API}/guilds/${i.guild_id}/members/${ownerId}`;
  // Rôles de l'auteur, ou du membre choisi dans l'option "membre" ; sinon relus sur Discord.
  let roles = ownerId === i.member.user.id ? i.member.roles : i.data?.resolved?.members?.[ownerId]?.roles;
  if (!roles) {
    const m = await fetch(memberUrl, { headers: auth });
    if (m.ok) roles = (await m.json()).roles;
  }
  if (roles?.includes(roleId)) return "";
  const r = await fetch(`${memberUrl}/roles/${roleId}`, {
    method: "PUT",
    headers: { ...auth, "X-Audit-Log-Reason": encodeURIComponent("Chaîne Twitch inscrite (/stream-ajouter)") },
  });
  if (!r.ok) {
    return `\n⚠️ Je n'ai pas pu donner le rôle <@&${roleId}> (${r.status}) : le rôle du bot doit ` +
      "avoir « Gérer les rôles » et être placé au-dessus.";
  }
  return ownerId === i.member.user.id
    ? `\nTu as reçu le rôle <@&${roleId}>.`
    : `\n<@${ownerId}> a reçu le rôle <@&${roleId}>.`;
}

async function removeStream(i, env) {
  const uid = i.member.user.id;
  const streams = await loadStreams(env);
  let id;
  if (option(i, "pseudo")) {
    const login = parseLogin(option(i, "pseudo"));
    id = Object.keys(streams).find((k) => streams[k].login === login);
    if (!id) return `❌ « ${esc(login || option(i, "pseudo"))} » n'est pas dans la liste (voir \`/stream-liste\`).`;
    if (streams[id].discordId !== uid && !isStaff(i)) return "❌ Tu ne peux retirer que ta propre chaîne.";
  } else {
    const mine = Object.keys(streams).filter((k) => streams[k].discordId === uid);
    if (!mine.length) return "Tu n'as inscrit aucune chaîne.";
    if (mine.length > 1) {
      return "Précise le pseudo à retirer : " + mine.map((k) => `\`${streams[k].login}\``).join(", ");
    }
    id = mine[0];
  }
  const { name, login } = streams[id];
  if (twitchReady(env)) {
    for (const s of await findSubs(env, id)) await deleteSub(env, s.id);
  }
  const fresh = await loadStreams(env);
  delete fresh[id];
  await saveStreams(env, fresh);
  return `✅ **${esc(name)}** (${link(login)}) n'est plus annoncée.`;
}

async function listStreams(i, env) {
  const streams = await loadStreams(env);
  const ids = Object.keys(streams)
    .sort((a, b) => streams[a].name.localeCompare(streams[b].name, "fr", { sensitivity: "base" }));
  if (!ids.length) return "Aucune chaîne inscrite pour l'instant : inscris la tienne avec `/stream-ajouter`.";
  let status = null;
  if (twitchReady(env)) {
    try { status = await subStatuses(env); } catch (e) { /* état inconnu */ }
  }
  const state = (id) => {
    if (!status) return "";
    const s = status[id];
    if (s === "enabled") return "";
    if (!s) return " ⚠️ abonnement Twitch absent (relancer `/stream-ajouter`)";
    if (s === "webhook_callback_verification_pending") return " ⏳ en cours d'activation";
    return ` ⚠️ abonnement Twitch en échec : ${s} (relancer \`/stream-ajouter\`)`;
  };
  const where = env.STREAM_CHANNEL_ID ? `<#${env.STREAM_CHANNEL_ID}>` : "le salon Stream";
  return [`📺 Chaînes annoncées dans ${where} (${ids.length}) :`,
    ...ids.map((id) => `- **${esc(streams[id].name)}** (${link(streams[id].login)}) : ` +
      `<@${streams[id].discordId}>${state(id)}`),
  ].join("\n");
}

/** Commandes /stream-* : réponse éphémère différée (les appels à Twitch peuvent dépasser 3 s). */
export function streamCommand(interaction, env, ctx, origin) {
  const run = { "stream-ajouter": addStream, "stream-retirer": removeStream, "stream-liste": listStreams };
  ctx.waitUntil(
    run[interaction.data.name](interaction, env, origin)
      .catch((e) => `❌ ${e.message}`)
      .then((content) => fetch(
        `${API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: content.slice(0, 2000), allowed_mentions: { parse: [] } }),
        })),
  );
  return new Response(JSON.stringify({ type: 5, data: { flags: 64 } }),
    { headers: { "content-type": "application/json" } });
}
