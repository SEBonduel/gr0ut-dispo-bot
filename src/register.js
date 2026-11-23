/**
 * Enregistre les commandes slash (globales) auprès de Discord : /sondage, /panneau-lu,
 * /stream-ajouter, /stream-retirer, /stream-liste.
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
    description: "Poste le panneau des rôles de line-up (Manœuvres) dans ce salon",
    type: 1,
    default_member_permissions: "268435456",  // "Gérer les rôles" : officiers seulement
    contexts: [0],  // serveur uniquement
  },
  // Annonces des lives Twitch dans le salon Stream (src/stream.js)
  {
    name: "stream-ajouter",
    description: "Inscris ta chaîne Twitch : tes lives seront annoncés dans le salon Stream",
    type: 1,
    contexts: [0],
    options: [
      { type: 3, name: "pseudo", description: "Ton pseudo Twitch ou le lien de ta chaîne",
        required: true, min_length: 2, max_length: 100 },
      { type: 6, name: "membre", description: "(Officiers) membre à qui appartient la chaîne",
        required: false },
    ],
  },
  {
    name: "stream-retirer",
    description: "Retire une chaîne Twitch des annonces du salon Stream",
    type: 1,
    contexts: [0],
    options: [
      { type: 3, name: "pseudo", description: "Pseudo Twitch à retirer (par défaut : ta chaîne)",
        required: false, max_length: 100 },
    ],
  },
  {
    name: "stream-liste",
    description: "Liste les chaînes Twitch annoncées dans le salon Stream",
    type: 1,
    contexts: [0],
  },
];

const res = await fetch(`https://discord.com/api/v10/applications/${APP_ID}/commands`, {
  method: "PUT",
  headers: { Authorization: `Bot ${TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify(commands),
});
console.log(res.status, await res.text());
