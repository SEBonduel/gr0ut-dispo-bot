/**
 * Style des noms de salons du serveur GR0UT : catégories en lettres ajourées entre
 * deux traits (────────── 𝕃𝕚𝕟𝕖 𝕌𝕡 ──────────), salons en gras précédés d'un emoji
 * (texte : 🔔𝐀𝐧𝐧𝐨𝐧𝐜𝐞𝐬, vocal : ⚔️ 𝐈𝐧𝐜𝐮𝐫𝐬𝐢𝐨𝐧 𝐆𝐑𝟎𝐔𝐓).
 */

// Lettres et chiffres vers un alphabet mathématique Unicode. Les accents sont gardés
// en caractères combinants (𝐞 + ́ = 𝐞́), comme sur les salons existants.
const restyle = (s, upper, lower, digit, special = {}) =>
  [...s.replace(/œ/g, "oe").replace(/Œ/g, "OE").normalize("NFD")].map((ch) => {
    if (special[ch]) return special[ch];
    const c = ch.codePointAt(0);
    if (c >= 65 && c <= 90) return String.fromCodePoint(upper + c - 65);
    if (c >= 97 && c <= 122) return String.fromCodePoint(lower + c - 97);
    if (c >= 48 && c <= 57) return String.fromCodePoint(digit + c - 48);
    return ch;
  }).join("");

export const bold = (s) => restyle(s, 0x1d400, 0x1d41a, 0x1d7ce);

// Lettres ajourées : ces majuscules existaient avant le bloc mathématique.
const DOUBLE_STRUCK = { C: "ℂ", H: "ℍ", N: "ℕ", P: "ℙ", Q: "ℚ", R: "ℝ", Z: "ℤ" };
export const doubleStruck = (s) => restyle(s, 0x1d538, 0x1d552, 0x1d7d8, DOUBLE_STRUCK);

export const categoryName = (s) => `────────── ${doubleStruck(s)} ──────────`;
export const textName = (emoji, s) => emoji + bold(s.trim().replace(/\s+/g, "-"));
export const voiceName = (emoji, s) => `${emoji} ${bold(s.trim())}`;
