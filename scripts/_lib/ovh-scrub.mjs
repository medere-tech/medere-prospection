/**
 * Scrubber des telephones dans les messages d'erreur / URLs OVH, avant
 * log vers stderr.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi
 *
 *   OVH /sms/{service}/outgoing utilise le prefixe `receiver=00<pays>...`
 *   (ex: `receiver=0033612349876`). Le wrapper `@ovhcloud/node-ovh`
 *   recopie l'URL complete dans `err.message` lors d'une erreur HTTP
 *   (401, 429, 5xx, parsing JSON). Un `console.error(err.message)` qui
 *   atterrit dans un dump de terminal / shell history / log file imprime
 *   donc le E.164 complet du destinataire → fuite PII en clair.
 *
 *   On masque TOUT ce qui ressemble a un telephone (receiver=, +33 isole,
 *   0033 isole, FR national 0[1-9]…) aux 4 derniers chiffres avant stderr.
 *   Memes patterns que le scrubber Pino `src/lib/utils/logger.ts`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Usage
 *
 *   import { scrubOvhErrorMessage } from "./_lib/ovh-scrub.mjs";
 *   try { ... } catch (err) {
 *     console.error(scrubOvhErrorMessage(err && err.message ? err.message : String(err)));
 *   }
 */
export function scrubOvhErrorMessage(input) {
  if (typeof input !== "string" || input.length === 0) return input;
  let out = input;
  // Prefix `receiver=` suivi d'au moins 4 digits (eventuellement avec `+`
  // ou `00` prefix) → `receiver=****XXXX`. Lookahead sur tout non-digit
  // ou fin de chaine (couvre `&`, espace, `:`, `,`, `"`, `'`, `)`, EOL).
  out = out.replace(/receiver=[+0-9]*(\d{4})(?=\D|$)/gi, (_m, last4) => `receiver=****${last4}`);
  // E.164 isole `+33` + >=9 digits → `+33****XXXX`.
  out = out.replace(/\+33\d{5,}(\d{4})/g, (_m, last4) => `+33****${last4}`);
  // `0033` + >=5 digits → `0033****XXXX`.
  out = out.replace(/\b0033\d{5,}(\d{4})\b/g, (_m, last4) => `0033****${last4}`);
  // FR national 10 digits `0[1-9]...` → `****XXXX`.
  out = out.replace(/\b0[1-9]\d{4,}(\d{4})\b/g, (_m, last4) => `****${last4}`);
  return out;
}
