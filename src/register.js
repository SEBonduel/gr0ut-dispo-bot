/**
 * Enregistre les commandes slash /sondage et /panneau-lu (globales) auprès de Discord.
 * Usage : DISCORD_APP_ID=... DISCORD_TOKEN=... node src/register.js
 * (commande globale : propagation jusqu'à ~1h ; relancer si on change la définition)
 */
const APP_ID = process.env.DISCORD_APP_ID;
const TOKEN = process.env.DISCORD_TOKEN;

const commands = [
  {
    name: "sondage",
    description: "Lance un sondage de disponibilité (Jeux de guerre)",
    type: 1,
  },
  {
    name: "panneau-lu",
    description: "Poste le panneau de choix des line-ups (Manœuvres) dans ce salon",
    type: 1,
    default_member_permissions: "268435456",  // "Gérer les rôles" : officiers seulement
    contexts: [0],  // serveur uniquement
  },
];

const res = await fetch(`https://discord.com/api/v10/applications/${APP_ID}/commands`, {
  method: "PUT",
  headers: { Authorization: `Bot ${TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify(commands),
});
console.log(res.status, await res.text());
