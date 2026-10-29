# GR0UT — Bot "Dispo Jeux de guerre" (Discord + Cloudflare Workers)

Un bot Discord dédié qui poste un **sondage de disponibilité à boutons** pour les
Jeux de guerre : **Présent / Absent / Peut-être**, avec liste et compteurs mis à
jour en direct. Application bot séparée (les webhooks ne peuvent pas porter de
boutons ; seule une app bot le peut).

## Fonctionnement

- **Auto** : chaque **vendredi 10h (heure de Paris)**, le bot poste le sondage dans
  `DISPO_CHANNEL_ID` avec un ping **@everyone** (une seule fois, à la publication).
- **Manuel** : la commande **`/sondage`** poste le même sondage à la demande.
- Chaque clic bascule le joueur dans la bonne liste (un seul choix par personne),
  et réédite le message sans re-pinger. Les réponses sont stockées dans KV.

Le cron tourne à 08:00 et 09:00 UTC le vendredi (= 10h Paris été/hiver) ; le code
ne poste qu'à 10h Paris, une seule fois (verrou KV). Le jour est écrit `FRI` :
chez Cloudflare, le jour 1 = dimanche, donc `5` désignerait le jeudi.

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

## Panneau des line-ups (Manœuvres)

La commande **`/panneau-lu`** (réservée à ceux qui ont *Gérer les rôles*) poste dans
le salon courant un panneau à boutons : une case par LU, **Remplaçant** et
**Quitter**. Un clic sur une LU donne son rôle et retire l'ancienne LU (une seule à
la fois). **Remplaçant** se cumule avec une LU : le bouton l'ajoute, un second clic le
retire. **Quitter** retire la LU et Remplaçant. Le joueur reçoit une confirmation
visible de lui seul, et le panneau affiche qui est dans chaque LU. Les noms des
boutons sont ceux des rôles : renommer un rôle suffit. Les LU peuvent être rangées en
sections (ex. *Montée de palier* / *Full reset*), chacune avec sa couleur de bouton.

Le message commence par une annonce (`src/lu-annonce.js`) qui explique comment récupérer
le rôle de sa LU, le rôle Remplaçant et qui voit quoi. Elle mentionne @everyone à la publication
seulement (les mises à jour du panneau ne re-pinguent pas), cite les salons Remplaçant
(`LU_SUB_CHANNEL_IDS`) et la personne à contacter pour créer ou renommer une LU
(`LU_CONTACT` : id Discord pour une mention cliquable, ou pseudo).

Tout est dans la catégorie **𝕄𝕒𝕟𝕠𝕖𝕦𝕧𝕣𝕖𝕤**, au style des autres salons du serveur
(`src/lu-style.js`), et chaque salon a ses propres permissions :

- `📋𝐑𝐨̂𝐥𝐞𝐬-𝐋𝐔` (le panneau) : lisible par la commu interne (`MEMBER_ROLE_IDS`, les
  rôles qui voient *Line Up*), personne n'y écrit sauf le bot ;
- `💬𝐑𝐞𝐦𝐩𝐥𝐚𝐜̧𝐚𝐧𝐭` (texte) et `🔄 𝐑𝐞𝐦𝐩𝐥𝐚𝐜̧𝐚𝐧𝐭` (vocal) : rôle Remplaçant **et** toutes les LU ;
- `💬𝐋𝐔-<𝐍𝐎𝐌>` (texte) et `⚔️ 𝐋𝐔 <𝐍𝐎𝐌>` (vocal) : uniquement le rôle de cette LU.

Mise en place :

1. **Rôles et salons** avec `src/setup-lu.js` : donne d'abord **Administrateur** au
   rôle du bot (il doit pouvoir accorder toutes ces permissions), mets `GUILD_ID`,
   `DISCORD_TOKEN` et `MEMBER_ROLE_IDS` dans `.dev.vars`, puis :
   ```bash
   node --env-file=.dev.vars src/setup-lu.js "Montée de palier:" ICENIGHT BOA "Full reset:" KENTIN
   ```
   Il crée la catégorie, le salon du panneau, les rôles `Remplaçant` et `LU <NOM>`
   et leurs salons, puis remplit `LU_ROLE_IDS`, `LU_GROUPS` et `LU_SUB_ROLE_ID` dans
   `wrangler.toml`. Un argument qui finit par `:` ouvre une section ; options :
   `OFFICER_ROLE_IDS=id1,id2` (rôles qui voient toutes les LU) et `PTT=1`
   (push-to-talk imposé).
2. **Rôle du bot** : retire Administrateur, garde *Gérer les rôles*, et vérifie qu'il
   est **au-dessus** des rôles LU (sinon Discord refuse l'attribution).
3. **Portail développeur** → *Bot* → *Privileged Gateway Intents* : active
   **Server Members Intent** (pour lister qui est dans chaque LU).
4. `npx wrangler deploy`, relance `node src/register.js` (ajoute `/panneau-lu`), puis
   tape `/panneau-lu` dans `📋𝐑𝐨̂𝐥𝐞𝐬-𝐋𝐔`.

Ajouter une LU : relance le script avec la liste complète (ce qui existe déjà est
gardé tel quel, la nouvelle LU reçoit l'accès aux salons Remplaçant), puis redéploie.
Le bouton apparaît sur le panneau au clic suivant. Le panneau tient 4 lignes de 5 LU,
chaque section commençant sur une nouvelle ligne.

## Notes

- Pour restreindre qui peut lancer `/sondage` : *Paramètres du serveur →
  Intégrations → (le bot) → Permissions des commandes*.
- Le ping `@everyone` nécessite la permission *Mentionner @everyone* pour le bot.
