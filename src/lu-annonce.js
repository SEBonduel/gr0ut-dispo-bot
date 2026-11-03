/**
 * Annonce en tête du panneau des line-ups (ping @everyone à la publication seulement).
 * Markdown Discord : # titres, **gras**, *italique*, -# petit texte gris.
 * Les boutons bleus / verts suivent l'ordre des sections de LU_GROUPS (cf. GROUP_STYLES).
 */
export function luAnnouncement({ subChannels = [], contact = "" }) {
  const [subText, subVoice] = subChannels;
  const bench = subText && subVoice ? `<#${subText}> et <#${subVoice}>` : "Les salons **Remplaçant**";
  const who = /^\d+$/.test(contact) ? `<@${contact}>` : contact ? `**${contact}**` : "un officier";
  return `@everyone
# Manœuvres : les line-ups sont en place

Salut à tous,

Les Manœuvres arrivent et les line-ups sont fixées. Chaque LU a maintenant **son salon écrit et son vocal à elle**, pour caler les compos, parler strat et se retrouver en vocal sans se marcher dessus.

## Comment récupérer le rôle de ta LU
Tout se passe **juste en dessous de ce message**, en un clic :
- Clique sur le bouton de **la LU qui t'a été attribuée** : le rôle est donné direct et tes salons apparaissent dans la catégorie *Manœuvres*.
- Les boutons **bleus**, c'est la *montée de palier*. Les **verts**, le *full reset*.
- **Une seule LU par personne** : ne prends que la tienne. Si tu ne sais pas dans laquelle tu es, demande à un officier.
- Erreur de clic ? Reclique sur la bonne LU, ou sur **Quitter** pour tout retirer.

## Le rôle Remplaçant
Pas de LU fixe, ou tu as mis *peut-être* dans les dispos ? Clique sur **Remplaçant**.
Ça se cumule avec une LU (tu peux être dans une LU **et** remplaçant), et un deuxième clic l'enlève.
${bench}, c'est le **banc de touche** : les remplaçants s'y signalent quand ils sont dispo, et les chefs de LU viennent y chercher du monde quand il manque quelqu'un.

## Qui voit quoi
- **Ce salon** : toute la commu, mais personne n'écrit dedans. Il sert uniquement à récupérer son rôle.
- **Le salon et le vocal de ta LU** : les joueurs de ta LU, plus les **commandants en second** qui suivent toutes les LU.
- **Les salons Remplaçant** : les remplaçants, toutes les LU et les commandants en second.

Une LU de plus à monter ou une LU à renommer ? Envoyez un MP à ${who}.

-# La compo de chaque LU, juste en dessous, se met à jour à chaque clic.`;
}
