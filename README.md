# GR0UT — Bot "Dispo Jeux de guerre" (Discord + Cloudflare Workers)

Un bot Discord dédié qui poste un **sondage de disponibilité à boutons** pour les
Jeux de guerre : **Présent / Absent / Peut-être**, avec liste et compteurs mis à
jour en direct. Application bot séparée (les webhooks ne peuvent pas porter de
boutons ; seule une app bot le peut).

## Fonctionnement

- **Auto** : chaque **vendredi 18h (heure de Paris)**, le bot poste le sondage dans
  `DISPO_CHANNEL_ID` avec un ping **@everyone** (une seule fois, à la publication).
- **Manuel** : la commande **`/sondage`** poste le même sondage à la demande.
- Chaque clic bascule le joueur dans la bonne liste (un seul choix par personne),
  et réédite le message sans re-pinger. Les réponses sont stockées dans KV.

Le cron tourne à 16:00 et 17:00 UTC le vendredi (= 18h Paris été/hiver) ; le code
ne poste qu'à 18h Paris, une seule fois (verrou KV).

## Mise en place

1. **Application Discord** (portail développeur) : récupère `DISCORD_APP_ID`,
   `DISCORD_PUBLIC_KEY` et le **token** du bot. Invite le bot sur le serveur avec
   les permissions *Voir le salon* + *Envoyer des messages* (+ *Mentionner
   @everyone* si tu veux le ping). Donne-lui l'accès au salon de dispo.
2. **Cloudflare** :
   ```bash
   npm install
   npx wrangler kv namespace create DISPO   # colle l'id dans wrangler.toml
   npx wrangler secret put DISCORD_PUBLIC_KEY
   npx wrangler secret put DISCORD_TOKEN
   npx wrangler deploy
   ```
3. **Vars** dans `wrangler.toml` : `DISCORD_APP_ID`, `DISPO_CHANNEL_ID`.
4. **Endpoint d'interactions** : portail Discord → *General Information* →
   *Interactions Endpoint URL* = `https://<worker>.workers.dev/interactions`.
5. **Commande `/sondage`** :
   ```bash
   DISCORD_APP_ID=... DISCORD_TOKEN=... node src/register.js
   ```
   (globale : propagation jusqu'à ~1h.)

## Notes

- Pour restreindre qui peut lancer `/sondage` : *Paramètres du serveur →
  Intégrations → (le bot) → Permissions des commandes*.
- Le ping `@everyone` nécessite la permission *Mentionner @everyone* pour le bot.
