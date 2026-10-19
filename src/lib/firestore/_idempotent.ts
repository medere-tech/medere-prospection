/**
 * Primitifs d'idempotence Firestore partages — docId deterministe + tx.create
 * atomique + fallback de reconfirmation par relecture.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi un module separe
 *
 * `addInboundIdempotent` (messages.ts) et `addOrphanInboundIdempotent`
 * (orphan-inbounds.ts) partagent STRICTEMENT la meme mecanique de defense :
 *
 *   1. docId derive de `safeExternalIdHash(externalId)` (prefixe `oih_`,
 *      chunking anti-scrubber).
 *   2. `tx.create(docRef, data)` — Firestore refuse ALREADY_EXISTS si un
 *      autre pipeline a deja commit ce docId.
 *   3. Catch ALREADY_EXISTS -> retour "created=false" (idempotent).
 *   4. Fallback defensif : si le code d'erreur n'est pas reconnu
 *      (anti-regression firebase-admin), relire le doc et comparer le
 *      champ discriminant (`externalId`) pour confirmer le doublon sans
 *      jamais avaler une erreur transiente.
 *
 * Les deux fonctions avaient historiquement une copie locale de cette
 * logique (`isInboundAlreadyExistsError` + bloc catch). On extrait ici
 * pour :
 *   - supprimer la duplication (seule la logique de WRITE differe entre
 *     messages/{id} et inbound_messages_orphans/{id}) ;
 *   - verrouiller la detection dans UN seul endroit testable.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Compatibilite stricte
 *
 * `addInboundIdempotent` passait tous ses tests avec la logique inline.
 * Apres bascule sur ces primitifs, le comportement observe doit etre
 * STRICTEMENT identique : tests existants `messages.test.ts
 * (addInboundIdempotent)` passent sans modification.
 */
import type { DocumentReference } from "firebase-admin/firestore";

/**
 * Detecte une erreur `ALREADY_EXISTS` du SDK firebase-admin sans dependre
 * d'un import gRPC direct.
 *
 * Formes connues :
 *   - `err.code === 6` (code numerique gRPC)
 *   - `err.code === "already-exists"` (version string Firestore client)
 *
 * ⚠️ On ne lit JAMAIS le texte du message (`err.message.includes("already exists")`) :
 * fragile, risque d'avaler une autre erreur et de perdre un STOP legitime.
 * Pour les SDK futurs qui wrapperaient le code sous `err.details.code` ou
 * `err.cause.code`, le fallback `confirmAlreadyExistsByReread` prend le relais.
 */
export function isAlreadyExistsError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === 6 || code === "already-exists";
}

/**
 * Fallback defensif : relit le docId deterministe et compare un champ
 * discriminant (ex: `externalId`) pour confirmer qu'une erreur non-reconnue
 * etait bien un ALREADY_EXISTS masque, PAS une erreur transiente.
 *
 * Semantique :
 *   - doc existe + `expectedField` matche `expectedValue` -> `true` (c'etait
 *     bien un doublon atomique, le caller renvoie `created: false`).
 *   - doc existe + mismatch -> `false` (collision inattendue : le caller
 *     DOIT relancer l'erreur originale pour que Inngest retry/investigue).
 *   - doc absent -> `false` (l'erreur n'avait rien a voir avec ALREADY_EXISTS,
 *     ex: Firestore 5xx transient -> le caller DOIT relancer).
 *
 * ⚠️ Ce fallback NE sauve PAS le pipeline en cas d'erreur transiente. Il
 * distingue "doublon vraiment detecte" vs "autre probleme". Le re-throw
 * cote caller preserve l'invariant "jamais perdre un STOP silencieusement".
 */
export async function confirmAlreadyExistsByReread(
  docRef: DocumentReference,
  discriminant: { expectedField: string; expectedValue: unknown },
): Promise<boolean> {
  const existing = await docRef.get();
  if (!existing.exists) return false;
  const got = existing.get(discriminant.expectedField);
  return got === discriminant.expectedValue;
}
