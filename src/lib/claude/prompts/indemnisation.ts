/**
 * Helper indemnisation par spécialité (S10.2.3) — source de vérité unique.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rôle métier
 *
 * Mappe une `ContactSpeciality` (21 valeurs, alignée HubSpot CRM) vers :
 *   - `amount`  : montant annuel max ANDPC en euros, ou `null` si non chiffré.
 *   - `label`   : forme COURTE prête à coller dans l'accroche d'un SMS de
 *                 prospection (≤ 20 chars, GSM-7 only).
 *
 * Consommé par le prompt `first-sms` v3.0.0 (S10.2.2+, branchement à venir).
 * En v2.0.1 le prompt hardcodait `792€/an` pour tous les PS — refactor S10.2
 * pour personnaliser par profession sans laisser Claude reformuler le
 * montant (décision Déthié 26/06/2026 : le helper IMPOSE la string courte).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pureté & dépendances — invariant S10.2.3
 *
 * Ce module N'IMPORTE QUE des types erasés à la compilation
 * (`ContactSpeciality`). Aucun runtime importé : pas de SDK Admin, pas de
 * Zod, zéro dépendance lourde. Le type est re-dérivé depuis
 * `CONTACT_SPECIALITY_VALUES` (source de vérité dans `lib/firestore/contacts.ts`).
 * Un test sentinelle lit le source de ce fichier et vérifie qu'aucune
 * référence runtime au SDK Admin n'a été introduite — toute régression
 * future casse le test (anti-coupling defense-in-depth).
 *
 * Conséquence : le helper est consommable depuis n'importe où dans le
 * graphe (prompts Claude, scripts golden, futurs jobs Inngest) sans tirer
 * la dépendance Firestore.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Source des chiffres
 *
 * Déthié interne 26/06/2026 + barème ANDPC. Fallback honnête —
 * aucun chiffre inventé. Pour les spécialités non chiffrées (paramédical,
 * étudiants, "Autre"), on affiche `"100% pris en charge"` qui est
 * factuellement vrai (tout PS éligible ANDPC est pris en charge à 100%)
 * SANS prétendre à un montant qu'on n'a pas validé.
 *
 * 🔒 SENTINEL — toute modification d'un montant ou d'un label DOIT :
 *   1. Être validée business par Déthié + Harry (re-vérif barème ANDPC).
 *   2. Incrémenter la version du prompt consommateur (`first-sms` v3.x.y).
 *   3. Passer les tests sentinelles (charset, longueur, anti-dérive,
 *      exhaustivité, jeu de montants verrouillé).
 */

import type { ContactSpeciality } from "@/types/contact";

// ─────────────────────────────────────────────────────────────────────────────
// Types exposés
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Information d'indemnisation pour une spécialité donnée.
 *
 *   - `amount` : montant annuel max en euros, ou `null` si non chiffré
 *                (fallback honnête).
 *   - `label`  : forme COURTE prête à coller dans l'accroche (≤ 20 chars,
 *                GSM-7 only — ASCII printable + `€` + accents FR usuels).
 */
export interface IndemnisationInfo {
  /** Montant annuel max en euros, ou null si non chiffré. */
  amount: number | null;
  /** Forme COURTE prête à coller dans l'accroche (≤ 20 chars). */
  label: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mapping verrouillé par sentinelles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 🔒 SENTINEL — Mapping exhaustif `speciality → IndemnisationInfo`.
 *
 * Le typage `Record<ContactSpeciality, IndemnisationInfo>` FORCE la
 * complétude à la compilation : si quelqu'un ajoute une 22e valeur dans
 * `CONTACT_SPECIALITY_VALUES`, TypeScript refusera de compiler ce fichier
 * tant que la nouvelle clé n'est pas ajoutée ici — garde-fou anti-oubli.
 *
 * **Changelog**
 *   - 1.0.0 — version initiale S10.2.3. Mapping ANDPC validé Déthié
 *             26/06/2026 (cf. JSDoc header pour source).
 */
const INDEMNISATION_BY_SPECIALITY: Record<ContactSpeciality, IndemnisationInfo> = {
  // ── 945€/an — médecins libéraux & spécialistes (7) ───────────────────────
  Médecin: { amount: 945, label: "945€/an" },
  Pédiatre: { amount: 945, label: "945€/an" },
  Psychiatre: { amount: 945, label: "945€/an" },
  Gynécologue: { amount: 945, label: "945€/an" },
  Radiologue: { amount: 945, label: "945€/an" },
  Dermatologue: { amount: 945, label: "945€/an" },
  "Médecin vasculaire": { amount: 945, label: "945€/an" },

  // ── 792€/an — chirurgien-dentiste (1) ────────────────────────────────────
  "Chirurgien-dentiste": { amount: 792, label: "792€/an" },

  // ── 532€/an — MKDE (1) ───────────────────────────────────────────────────
  MKDE: { amount: 532, label: "532€/an" },

  // ── 473€/an — infirmiers (2) ─────────────────────────────────────────────
  IDE: { amount: 473, label: "473€/an" },
  Infirmier: { amount: 473, label: "473€/an" },

  // ── Fallback "100% pris en charge" — non chiffré, factuel (10) ───────────
  "Sage-Femme": { amount: null, label: "100% pris en charge" },
  Orthophoniste: { amount: null, label: "100% pris en charge" },
  Pharmacien: { amount: null, label: "100% pris en charge" },
  Psychologue: { amount: null, label: "100% pris en charge" },
  "Pédicure-podologue": { amount: null, label: "100% pris en charge" },
  "Assistant(e) dentaire": { amount: null, label: "100% pris en charge" },
  "Aide-soignante": { amount: null, label: "100% pris en charge" },
  "Autre profession paramédicale": { amount: null, label: "100% pris en charge" },
  Étudiant: { amount: null, label: "100% pris en charge" },
  Autre: { amount: null, label: "100% pris en charge" },
};

// ─────────────────────────────────────────────────────────────────────────────
// API publique
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Retourne le montant ANDPC + le label court à coller dans l'accroche
 * pour une spécialité donnée.
 *
 * Pure function — pas d'I/O, pas de side-effects. Lookup direct O(1) sur
 * le mapping verrouillé. Toute spécialité absente du mapping est impossible
 * par typage (`Record<ContactSpeciality, …>` exhaustif compile-time).
 *
 * @param speciality  Spécialité du PS (l'une des 21 valeurs alignées HubSpot).
 * @returns           `{ amount, label }` — `amount` peut être `null` (fallback).
 */
export function getIndemnisationForSpeciality(speciality: ContactSpeciality): IndemnisationInfo {
  return INDEMNISATION_BY_SPECIALITY[speciality];
}
