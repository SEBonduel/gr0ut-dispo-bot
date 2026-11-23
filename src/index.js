/**
 * GR0UT — Bot "Dispo Jeux de guerre" (Cloudflare Worker, application Discord dédiée).
 *
 * Chaque vendredi 10h (heure de Paris), poste dans DISPO_CHANNEL_ID un sondage à
 * boutons "es-tu dispo pour les Jeux de guerre de demain ?" (Présent / Absent /
 * Peut-être). Les clics mettent à jour en direct la liste et les compteurs.
 *
 * Pourquoi un worker + une app bot : les webhooks Discord ne peuvent pas porter de
 * boutons ; seule une application bot peut poster des composants et gérer les clics.
 *
 * Commande /panneau-lu : poste le panneau des line-ups des Manœuvres. Chaque joueur
 * clique sur sa LU (ou Remplaçant) et reçoit le rôle qui ouvre ses salons.
 *
 * Commandes /stream-ajouter, /stream-retirer, /stream-liste, /panneau-stream (panneau à
 * boutons) et route POST /twitch : annonces des lives Twitch dans le salon Stream
 * (voir src/stream.js).
 *
 * Secrets (wrangler secret put ...):
 *   DISCORD_PUBLIC_KEY, DISCORD_TOKEN, TEST_KEY,
 *   TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_EVENTSUB_SECRET
 * Vars (wrangler.toml): DISCORD_APP_ID, DISPO_CHANNEL_ID, LU_ROLE_IDS, LU_GROUPS,
 *   LU_SUB_ROLE_ID, LU_SUB_CHANNEL_IDS, LU_CONTACT, STREAM_CHANNEL_ID, STREAM_PING,
 *   STREAM_ROLE_IDS, STREAMER_ROLE_ID
 * Binding KV : DISPO
 */

import {
  verifyKey,
  InteractionType,
  InteractionResponseType,
} from "discord-interactions";
import { luAnnouncement } from "./lu-annonce.js";
import { STREAM_COMMANDS, streamCommand, streamComponent, handleTwitchWebhook } from "./stream.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

// Échappe le Markdown Discord : sinon les "_" des pseudos soulignent/italicisent la liste.
const esc = (s) => String(s).replace(/([\\*_~`|])/g, "\\$1");

// --- Sondage de dispo --------------------------------------------------------

const BUCKETS = { present: "✅ Présents", absent: "❌ Absents", maybe: "🤔 Peut-être" };

function dispoButtons(dateKey) {
  return [{
    type: 1,
    components: [
      { type: 2, style: 3, label: "Présent", custom_id: `dispo:present:${dateKey}` },
      { type: 2, style: 4, label: "Absent", custom_id: `dispo:absent:${dateKey}` },
      { type: 2, style: 2, label: "Peut-être", custom_id: `dispo:maybe:${dateKey}` },
    ],
  }];
}

function dispoContent(tally) {
  const names = (o) => Object.values(o || {}).map(esc);
  const lines = ["@everyone",
                 "🎯 **Jeux de guerre demain soir (samedi, 22h)** - Renseigne ta dispo", ""];
  for (const [k, label] of Object.entries(BUCKETS)) {
    const n = names(tally[k]);
    lines.push(`${label} (${n.length}) :`, n.length ? n.join(", ") : "-", "");
  }
  lines.push("_Clique sur un bouton (tu peux changer d'avis à tout moment)._");
  return lines.join("\n");
}

async function sendDispoPoll(env, dateKey, silent = false) {
  if (!env.DISPO_CHANNEL_ID || !env.DISCORD_TOKEN) {
    return { ok: false, reason: "DISPO_CHANNEL_ID / DISCORD_TOKEN manquant" };
  }
  const tally = { present: {}, absent: {}, maybe: {} };
  await env.DISPO.put(`dispo:${dateKey}`, JSON.stringify(tally));
  const r = await fetch(
    `https://discord.com/api/v10/channels/${env.DISPO_CHANNEL_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${env.DISCORD_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        content: dispoContent(tally),
        components: dispoButtons(dateKey),
        // ping @everyone une fois à la publication (sauf test en mode silencieux)
        allowed_mentions: { parse: silent ? [] : ["everyone"] },
      }),
    },
  );
  return { ok: r.ok, status: r.status, detail: r.ok ? "" : (await r.text()).slice(0, 300) };
}

/** Ne poste qu'au vendredi 10h Paris, une seule fois (verrou KV par date). */
async function maybeSendDispoPoll(env) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris", weekday: "short", hour: "2-digit", hour12: false,
    day: "2-digit", month: "2-digit", year: "numeric",
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  if (get("weekday") !== "Fri" || parseInt(get("hour"), 10) !== 10) {
    return { ok: false, reason: "hors créneau vendredi 10h Paris" };
  }

  const dateKey = `${get("year")}-${get("month")}-${get("day")}`;
  if ((await env.DISPO.get("dispo_posted")) === dateKey) {
    return { ok: false, reason: `déjà posté (${dateKey})` };
  }
  await env.DISPO.put("dispo_posted", dateKey);
  const res = await sendDispoPoll(env, dateKey);
  // Trace du résultat (ex. 404 Unknown Channel si le salon a été supprimé).
  await env.DISPO.put("last_send",
    JSON.stringify({ at: new Date().toISOString(), channel: env.DISPO_CHANNEL_ID, ...res }));
  // Échec d'envoi : on libère le verrou pour laisser le prochain tick réessayer.
  if (!res.ok) await env.DISPO.delete("dispo_posted");
  return res;
}

/** Clic sur un bouton : met à jour le décompte et réédite le message. */
async function handleDispoClick(interaction, env, id) {
  const [, choice, dateKey] = id.split(":");
  const key = `dispo:${dateKey}`;
  const tally = (await env.DISPO.get(key, "json")) || { present: {}, absent: {}, maybe: {} };
  const user = interaction.member?.user || interaction.user || {};
  const uid = user.id;
  const name = interaction.member?.nick || user.global_name || user.username || "Joueur";
  // Un seul choix par personne : on retire des autres puis on met dans le bon.
  delete tally.present[uid]; delete tally.absent[uid]; delete tally.maybe[uid];
  if (BUCKETS[choice]) tally[choice][uid] = name;
  await env.DISPO.put(key, JSON.stringify(tally));
  return json({
    type: InteractionResponseType.UPDATE_MESSAGE,
    data: {
      content: dispoContent(tally),
      components: dispoButtons(dateKey),
      allowed_mentions: { parse: [] },  // édition : garde le texte @everyone mais NE re-ping personne
    },
  });
}

// --- Panneau des line-ups (Manœuvres) -----------------------------------------
// Un message à boutons : une LU par bouton + Remplaçant + Quitter. Un clic sur une LU
// donne son rôle et retire l'ancienne LU (une seule à la fois) ; Remplaçant se cumule
// avec une LU et se retire en re-cliquant. Les salons (texte + vocal par LU, Remplaçant
// vu par toutes les LU, tous dans la catégorie Manœuvres) sont créés par
// src/setup-lu.js. Les listes du panneau sont relues sur Discord à chaque clic : il
// faut l'intent "Server Members" du bot.

const API = "https://discord.com/api/v10";

/**
 * Rôles des LU (ordre des boutons) et rôle Remplaçant, depuis wrangler.toml.
 * Sections : LU_ROLE_IDS "a,b|c,d" + LU_GROUPS "Titre 1|Titre 2".
 */
function luConfig(env) {
  const titles = (env.LU_GROUPS || "").split("|").map((s) => s.trim());
  const groups = (env.LU_ROLE_IDS || "").split("|").map((part, i) => ({
    title: titles[i] || "",
    ids: part.split(",").map((s) => s.trim()).filter(Boolean),
  })).filter((g) => g.ids.length);
  const lus = groups.flatMap((g) => g.ids);
  const sub = (env.LU_SUB_ROLE_ID || "").trim();
  const subChannels = (env.LU_SUB_CHANNEL_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return { groups, lus, sub, subChannels, slots: [...lus, sub].filter(Boolean) };
}

// Couleur des boutons par section (bleu, vert), expliquée dans l'annonce (lu-annonce.js).
const GROUP_STYLES = [1, 3];

const discord = (env, method, path, body) =>
  fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${env.DISCORD_TOKEN}`,
      "content-type": "application/json",
      "X-Audit-Log-Reason": encodeURIComponent("Panneau des LU"),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

// Réponses à une interaction (édition du panneau, message éphémère) : pas de token bot.
const webhook = (interaction, method, suffix, body) =>
  fetch(`${API}/webhooks/${interaction.application_id}/${interaction.token}${suffix}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** Tous les membres du serveur (null si l'intent "Server Members" est désactivé). */
async function fetchMembers(env, guildId) {
  const all = [];
  let after = "0";
  for (let i = 0; i < 10; i++) {
    const r = await discord(env, "GET", `/guilds/${guildId}/members?limit=1000&after=${after}`);
    if (!r.ok) return null;
    const page = await r.json();
    all.push(...page);
    if (page.length < 1000) break;
    after = page[page.length - 1].user.id;
  }
  return all;
}

function luEmbed(roles, members, cfg) {
  const name = (m) => m.nick || m.user.global_name || m.user.username;
  const who = (id) => members && members.filter((m) => m.roles.includes(id)).map(name)
    .sort((a, b) => a.localeCompare(b, "fr", { sensitivity: "base" })).map(esc);
  const count = (w) => (w ? w.length : "?");
  const list = (w) => (!w ? "?" : w.length ? w.join(", ") : "-");
  const lines = [];
  for (const g of cfg.groups) {
    if (g.title) lines.push(`### ${esc(g.title)}`);
    for (const id of g.ids.filter((id) => roles[id])) {
      const w = who(id);
      lines.push(`**${esc(roles[id].name)}** (${count(w)}) : ${list(w)}`);
    }
  }
  if (roles[cfg.sub]) {
    const w = who(cfg.sub);
    lines.push(`### ${esc(roles[cfg.sub].name)} (${count(w)})`, list(w));
  }
  let description = lines.join("\n");
  if (description.length > 4096) description = description.slice(0, 4090) + " ...";
  return {
    title: "Composition des line-ups",
    description,
    color: 0xb22222,
    footer: { text: members ? "Mis à jour" : "Listes indisponibles (intent Server Members désactivé)" },
    timestamp: new Date().toISOString(),
  };
}

function luButtons(roles, cfg) {
  const button = (id, style) =>
    ({ type: 2, style, label: roles[id].name.slice(0, 80), custom_id: `lu:${id}` });
  const rows = [];
  cfg.groups.forEach((g, i) => {
    const ids = g.ids.filter((id) => roles[id]);
    const style = GROUP_STYLES[i % GROUP_STYLES.length];
    for (let j = 0; j < ids.length; j += 5) {
      rows.push({ type: 1, components: ids.slice(j, j + 5).map((id) => button(id, style)) });
    }
  });
  // 5 lignes max par message : 4 pour les LU, la dernière pour Remplaçant / Quitter.
  if (rows.length > 4) {
    throw new Error("trop de LU pour le panneau : 4 lignes de 5 boutons max, " +
      "chaque section commence sur une nouvelle ligne");
  }
  const last = roles[cfg.sub] ? [button(cfg.sub, 2)] : [];
  last.push({ type: 2, style: 4, label: "Quitter", custom_id: "lu:quit" });
  rows.push({ type: 1, components: last });
  return rows;
}

/**
 * Contenu du panneau, relu sur Discord. `override` = rôles à jour du joueur qui vient
 * de cliquer (la liste des membres peut encore renvoyer ses anciens rôles).
 */
async function buildLuPanel(env, guildId, override) {
  const cfg = luConfig(env);
  const r = await discord(env, "GET", `/guilds/${guildId}/roles`);
  if (!r.ok) throw new Error(`impossible de lire les rôles du serveur (${r.status})`);
  const roles = Object.fromEntries((await r.json()).map((x) => [x.id, x]));
  let members = await fetchMembers(env, guildId);
  if (members && override) {
    members = members.map((m) => (m.user.id === override.id ? { ...m, roles: override.roles } : m));
  }
  return {
    content: luAnnouncement({ subChannels: cfg.subChannels, contact: (env.LU_CONTACT || "").trim() }),
    embeds: [luEmbed(roles, members, cfg)],
    components: luButtons(roles, cfg),
    allowed_mentions: { parse: [] },  // les mises à jour ne re-pinguent personne
  };
}

/** Commande /panneau-lu : poste le panneau dans le salon courant. */
async function postLuPanel(interaction, env) {
  let msg;
  try {
    if (!luConfig(env).lus.length) {
      msg = "❌ Aucune LU configurée : remplis LU_ROLE_IDS dans wrangler.toml puis redéploie.";
    } else {
      const data = await buildLuPanel(env, interaction.guild_id);
      // Ping @everyone une seule fois, à la publication
      const r = await discord(env, "POST", `/channels/${interaction.channel_id}/messages`,
        { ...data, allowed_mentions: { parse: ["everyone"] } });
      msg = r.ok ? "✅ Panneau des LU posté."
        : `❌ Impossible de poster ici (${r.status}) : le bot doit pouvoir voir ce salon, ` +
          "y envoyer des messages, intégrer des liens et mentionner @everyone.";
    }
  } catch (e) {
    msg = `❌ ${e.message}`;
  }
  await webhook(interaction, "PATCH", "/messages/@original", { content: msg });
}

/** Clic sur le panneau : change le rôle LU du joueur, répond en éphémère, rafraîchit. */
async function handleLuClick(interaction, env) {
  const cfg = luConfig(env);
  const guildId = interaction.guild_id;
  const uid = interaction.member.user.id;
  const target = interaction.data.custom_id.slice("lu:".length); // id de rôle ou "quit"
  const has = (id) => interaction.member.roles.includes(id);
  const currentLus = cfg.lus.filter(has);
  const role = (id) => `<@&${id}>`;
  let reply, done;
  let remove = [], add = [];
  let override = null;

  if (target !== "quit" && !cfg.slots.includes(target)) {
    reply = "Ce bouton ne correspond plus à aucune LU : demande à un officier de reposter le panneau.";
  } else if (target === "quit") {
    // Quitter : retire la LU et Remplaçant.
    remove = cfg.slots.filter(has);
    if (!remove.length) reply = "Tu n'es dans aucune LU.";
    else done = `Tu as quitté ${remove.map(role).join(", ")}.`;
  } else if (target === cfg.sub) {
    // Remplaçant se cumule avec une LU : le bouton l'ajoute ou le retire.
    if (has(target)) { remove = [target]; done = `Tu n'es plus ${role(target)}.`; }
    else { add = [target]; done = `✅ C'est noté, tu es ${role(target)}.`; }
  } else if (currentLus.length === 1 && currentLus[0] === target) {
    reply = `Tu es déjà dans ${role(target)}.`;
  } else {
    // Une seule LU à la fois : on retire les autres LU (Remplaçant est gardé).
    remove = currentLus.filter((id) => id !== target);
    add = currentLus.includes(target) ? [] : [target];
    done = `✅ C'est noté, tu es dans ${role(target)}.`;
  }

  if (!reply) {
    let ok = true;
    for (const [method, id] of [...remove.map((id) => ["DELETE", id]), ...add.map((id) => ["PUT", id])]) {
      const r = await discord(env, method, `/guilds/${guildId}/members/${uid}/roles/${id}`);
      if (!r.ok) { ok = false; break; }
    }
    if (!ok) {
      reply = "❌ Je n'ai pas pu changer tes rôles. Un officier doit vérifier que le rôle du bot " +
        "a « Gérer les rôles » et qu'il est placé au-dessus des rôles LU.";
    } else {
      override = { id: uid, roles: interaction.member.roles.filter((id) => !remove.includes(id)).concat(add) };
      reply = done;
    }
  }

  await Promise.all([
    webhook(interaction, "POST", "", { content: reply, flags: 64, allowed_mentions: { parse: [] } }),
    buildLuPanel(env, guildId, override)
      .then((data) => webhook(interaction, "PATCH", "/messages/@original", data))
      .catch(() => {}),  // panneau pas rafraîchi : le prochain clic le remettra à jour
  ]);
}

// --- Interactions Discord ----------------------------------------------------

async function handleInteraction(interaction, env, ctx, origin) {
  if (interaction.type === InteractionType.PING) {
    return json({ type: InteractionResponseType.PONG });
  }

  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    // Commandes /stream-* : l'URL publique du worker sert de callback aux abonnements Twitch.
    if (STREAM_COMMANDS.has(interaction.data?.name)) {
      return streamCommand(interaction, env, ctx, origin);
    }
    // Commande /sondage : poste un sondage de dispo à la demande.
    if (interaction.data?.name === "sondage") {
      const dateKey = interaction.id; // identifiant unique de ce sondage
      const tally = { present: {}, absent: {}, maybe: {} };
      await env.DISPO.put(`dispo:${dateKey}`, JSON.stringify(tally));
      return json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: dispoContent(tally),
          components: dispoButtons(dateKey),
          allowed_mentions: { parse: ["everyone"] },
        },
      });
    }
    // Commande /panneau-lu : réponse différée (éphémère) le temps de lire rôles et membres.
    if (interaction.data?.name === "panneau-lu") {
      ctx.waitUntil(postLuPanel(interaction, env));
      return json({
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: 64 },  // éphémère : seul l'officier voit "Panneau posté"
      });
    }
  }

  // Panneau du salon Stream : boutons, et fenêtre de saisie du pseudo Twitch (type 5).
  if ((interaction.type === InteractionType.MESSAGE_COMPONENT || interaction.type === 5) &&
      (interaction.data?.custom_id || "").startsWith("stream:")) {
    return streamComponent(interaction, env, ctx, origin);
  }

  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    const id = interaction.data.custom_id || "";
    if (id.startsWith("dispo:")) return handleDispoClick(interaction, env, id);
    // Clic LU : on accuse réception tout de suite (délai de 3 s), le travail suit.
    if (id.startsWith("lu:")) {
      ctx.waitUntil(handleLuClick(interaction, env).catch(() => {}));
      return json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
    }
  }
  return json({ type: InteractionResponseType.PONG });
}

// --- Entrées du Worker -------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/interactions" && request.method === "POST") {
      const sig = request.headers.get("x-signature-ed25519");
      const ts = request.headers.get("x-signature-timestamp");
      const raw = await request.text();
      const valid = sig && ts &&
        (await verifyKey(raw, sig, ts, env.DISCORD_PUBLIC_KEY));
      if (!valid) return new Response("Bad request signature", { status: 401 });
      return handleInteraction(JSON.parse(raw), env, ctx, url.origin);
    }

    // Appels EventSub de Twitch (début de live) : signés avec TWITCH_EVENTSUB_SECRET.
    if (url.pathname === "/twitch" && request.method === "POST") {
      return handleTwitchWebhook(request, env, ctx);
    }

    return new Response("GR0UT dispo bot OK", { status: 200 });
  },

  // Cron : vendredi 08:00 et 09:00 UTC (= 10h Paris été/hiver). La garde interne
  // (vendredi 10h Paris + verrou KV) garantit un envoi unique.
  async scheduled(event, env, ctx) {
    // Battement de cœur : trace chaque déclenchement de cron (diagnostic).
    try {
      await env.DISPO.put("last_tick",
        JSON.stringify({ at: new Date().toISOString(), cron: event.cron }));
    } catch (e) { /* ne doit jamais bloquer l'envoi */ }
    await maybeSendDispoPoll(env);
  },
};
