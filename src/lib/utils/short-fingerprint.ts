/**
 * Fingerprint court (8 chars hex) d'une string — diagnostic forensic sans
 * fuite de la valeur brute.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Usage
 *
 * Utile pour tracer une valeur dans un log ou un audit `payload` sans
 * exposer la valeur elle-même — typiquement un identifiant "semi-PII"
 * côté Médéré (jamais côté PS) qui matcherait par malchance le scrubber
 * `detectPiiInPayload` (ex : `OVH_SMS_SENDER` en format E.164 depuis
 * S9.7 Time2Chat).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ⚠️ Ce n'est PAS un hash crypto
 *
 * Algo djb2 (Dan Bernstein, hash de string simple). Suffisant pour :
 *   - un fingerprint forensic diag (retrouver "quel sender" par corrélation
 *     avec l'archive de la config env à la date de l'audit)
 *   - une clé de dédup best-effort côté log/monitoring
 *
 * PAS suffisant pour :
 *   - hasher de la PII sensible (nom, téléphone du PS, email) → utiliser
 *     `hashPii()` (`@/lib/utils/pii-detector`) qui applique HMAC-SHA256
 *     avec pepper `AUDIT_PII_PEPPER` (résistance dictionnaire + réversibilité
 *     interdite).
 *   - vérification d'intégrité / anti-collision cryptographique.
 *
 * Cohérent avec le pattern préexistant dans `hubspot/mapper.ts` et
 * `hubspot/contacts.ts` (2 copies privées, mêmes valeurs générées pour un
 * input donné — remplaçables par cet export dans une dette technique
 * future).
 *
 * @param value  Non-empty string. Une string vide `""` retourne `"00001505"`
 *               (djb2 initial `5381` en hex) — déterministe mais pas un
 *               vrai fingerprint. Le caller est responsable de valider
 *               l'input si un empty check est requis.
 * @returns      8 chars hex `[0-9a-f]{8}`, padding zéros à gauche si
 *               nécessaire.
 */
export function shortFingerprint(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) & 0xffffffff;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
