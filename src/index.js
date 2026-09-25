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
 * Secrets (wrangler secret put ...):
 *   DISCORD_PUBLIC_KEY, DISCORD_TOKEN, TEST_KEY
 * Vars (wrangler.toml): DISCORD_APP_ID, DISPO_CHANNEL_ID
 * Binding KV : DISPO
 */

import {
  verifyKey,
  InteractionType,
  InteractionResponseType,
} from "discord-interactions";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

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
  const names = (o) => Object.values(o || {});
  const lines = ["@everyone",
                 "🎯 **Jeux de guerre demain soir (samedi, 22h)** - Renseigne ta dispo", ""];
  for (const [k, label] of Object.entries(BUCKETS)) {
    const n = names(tally[k]);
    lines.push(`${label} (${n.length}) : ${n.length ? n.join(", ") : "-"}`);
  }
  lines.push("", "_Clique sur un bouton (tu peux changer d'avis à tout moment)._");
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

// --- Interactions Discord ----------------------------------------------------

async function handleInteraction(interaction, env) {
  if (interaction.type === InteractionType.PING) {
    return json({ type: InteractionResponseType.PONG });
  }

  // Commande /sondage : poste un sondage de dispo à la demande.
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
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
  }

  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    const id = interaction.data.custom_id || "";
    if (id.startsWith("dispo:")) return handleDispoClick(interaction, env, id);
  }
  return json({ type: InteractionResponseType.PONG });
}

// --- Entrées du Worker -------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/interactions" && request.method === "POST") {
      const sig = request.headers.get("x-signature-ed25519");
      const ts = request.headers.get("x-signature-timestamp");
      const raw = await request.text();
      const valid = sig && ts &&
        (await verifyKey(raw, sig, ts, env.DISCORD_PUBLIC_KEY));
      if (!valid) return new Response("Bad request signature", { status: 401 });
      return handleInteraction(JSON.parse(raw), env);
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
