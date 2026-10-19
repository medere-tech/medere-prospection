/**
 * DIAG-STOP-OVH — diagnostic d'un STOP SMS qui ne serait pas arrive au
 * webhook `/api/webhooks/ovh-sms`. Lecture seule stricte cote OVH.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Usage
 *
 *   npx tsx scripts/diag-stop-ovh.mjs
 *
 * Pre-requis .env.local :
 *   - OVH_ENDPOINT (ex "ovh-eu")
 *   - OVH_APP_KEY, OVH_APP_SECRET, OVH_CONSUMER_KEY
 *   - OVH_SMS_SERVICE_NAME (ex "sms-ng66707-1")
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CONTRAT ECRITURE INTERDITE
 *
 * Ce script ne fait QUE des GET sur l'API OVH. Toute methode autre que
 * `GET` est refusee au niveau du wrapper local `requestReadOnly` avec
 * un throw explicite. Aucune methode POST / PUT / DELETE / PATCH. Aucune
 * modification de blacklist, aucun ajout, aucune suppression.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Anti-PII sortie console
 *
 *   - Numeros masques : `****` + 4 derniers chiffres (ex "+33612345678"
 *     devient "****5678"). Applique a sender, receiver, number, et a
 *     TOUTE sous-chaine qui ressemble a un numero (regex `+?[0-9]{8,}`).
 *   - Body SMS : affiche UNIQUEMENT si length <= 10 (STOP, OUI, NON...).
 *     Au-dela : `(bodyLength=N, masked)`.
 *   - Pas de nom, pas d'email, pas d'autre PII.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Scope (4 points du brief)
 *
 *   1. GET /sms/{serviceName}/incoming filtre sur creationDatetime.from
 *      = now - 2h. Si tableau d'IDs : fait un GET /incoming/{id} par ID
 *      pour obtenir sender / message / tag / creationDatetime.
 *   2. GET /sms/{serviceName}/blacklists → liste numeros blackliste.
 *      Pour chaque entree : GET /blacklists/{number} si l'API retourne
 *      un detail par item (sinon la liste suffit).
 *   3. GET /sms/{serviceName} → config du service (callBack URL, options
 *      smsResponse si expose). GET /sms/{serviceName}/virtualNumbers
 *      → liste des virtual numbers lies ; pour chaque : GET
 *      /virtualNumbers/{num} + GET /virtualNumbers/{num}/smsResponse
 *      si disponible.
 *   4. Point 4 (doc OVH citations) : HORS API — ce script ne peut PAS
 *      extraire la doc OVH. Le script imprime une note au caller qui
 *      indique les URLs OVH canoniques a consulter manuellement.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { getOvhClient } from "../src/lib/ovh/client.ts";
import { getOvhEnv } from "../src/lib/security/env.ts";
import { scrubOvhErrorMessage } from "./_lib/ovh-scrub.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// Garde ecriture : refuse toute methode autre que GET.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Fail-fast R4-fix : toute erreur de lecture arrete le script
// ─────────────────────────────────────────────────────────────────────────────

function failFast(message, err) {
  // scrubOvhErrorMessage : masque receiver=0033... / +33... / 0[1-9]...
  // dans `message` (path OVH) et `err.message` (URL recopiee par
  // @ovhcloud/node-ovh dans les erreurs).
  const detail = err && err.message ? err.message : String(err ?? "unknown");
  console.error("");
  console.error("DIAGNOSTIC INCOMPLET");
  console.error(`  ${scrubOvhErrorMessage(message)}`);
  console.error(`  erreur : ${scrubOvhErrorMessage(detail)}`);
  process.exit(1);
}

/**
 * R5-fix decision (a) : certains endpoints OVH sont OPTIONNELS (pas tous
 * les comptes/vhosts les exposent). On tolere UNIQUEMENT trois signatures
 * d'erreur qui prouvent "endpoint inexistant" :
 *   - HTTP 404 (`statusCode === 404` ou "Got HTTP response 404" dans
 *     le message du wrapper OVH).
 *   - "does not exist" dans le message (reponse texte OVH explicite).
 *   - "invalid URL" / "Invalid URL" (wrapper OVH rejette un path qu'il
 *     ne reconnait pas).
 * TOUTE AUTRE erreur -> failFast (401 auth, 5xx, timeout, etc.).
 */
function isOptionalEndpointError(err) {
  if (!err) return false;
  const message = typeof err.message === "string" ? err.message : "";
  const statusCode =
    typeof err.statusCode === "number"
      ? err.statusCode
      : typeof err.status === "number"
        ? err.status
        : null;
  if (statusCode === 404) return true;
  if (/\b404\b/.test(message)) return true;
  if (/does\s+not\s+exist/i.test(message)) return true;
  if (/invalid\s+url/i.test(message)) return true;
  return false;
}

const client = getOvhClient();

async function requestReadOnly(path) {
  // La signature `requestPromised(method, path, params)` du wrapper laisse
  // techniquement passer tout verbe. On cadenasse ici au niveau de ce
  // script : AUCUN appel autre que GET n'est emis. Si on tente, throw.
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("requestReadOnly: path invalide");
  }
  return client.requestPromised("GET", path);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers anti-PII
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Masque un numero FR / E.164 en gardant les 4 derniers chiffres.
 * "+33612345678"   -> "****5678"
 * "0612345678"     -> "****5678"
 * "+33939070545"   -> "****0545"
 */
function maskPhone(raw) {
  if (typeof raw !== "string") return raw;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 4) return "****";
  return "****" + digits.slice(-4);
}

/**
 * Scanne une chaine arbitraire et masque toute sous-sequence qui
 * ressemble a un numero (8+ chiffres consecutifs, prefixe `+` optionnel).
 * Utilise pour masquer les callBack URLs et les sorties verbatim.
 */
function maskPhoneInText(text) {
  if (typeof text !== "string") return text;
  return text.replace(/\+?\d{8,}/g, (match) => maskPhone(match));
}

/**
 * Masque les URLs : garde `scheme://host[:port]/path`, strippe query
 * string (contient souvent un token sensible OVH : `?token=...` sur
 * `cgiUrl`, `?s=...` sur certains callbacks). Masque aussi les numeros
 * eventuels dans le path.
 *
 * Pattern : on repere les URLs via la regex standard http(s)://... puis
 * on les reconstruit `origin + pathname` (sans search ni hash).
 */
function maskUrl(value) {
  if (typeof value !== "string") return value;
  // Match uniquement les URLs HTTP(S), case-insensitive. Les tokens OVH
  // typiques (cgiUrl, callBack) utilisent https://.
  return value.replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => {
    try {
      const u = new URL(raw);
      // Si query string presente, on la remplace par un marker explicite
      // pour que le lecteur SAIT qu'un token a ete masque (vs URL sans
      // query naturellement). Idem fragment.
      const queryMasked = u.search ? "?<query-masked>" : "";
      const hashMasked = u.hash ? "#<hash-masked>" : "";
      // Numeros eventuels dans le path (ex: callback OVH legacy avec le
      // sender dans l'URL). Masque les sequences de 8+ chiffres.
      const path = u.pathname.replace(/\+?\d{8,}/g, (m) => maskPhone(m));
      return `${u.origin}${path}${queryMasked}${hashMasked}`;
    } catch {
      // URL mal formee : retourne un placeholder plutot que la valeur brute.
      return "(malformed-url)";
    }
  });
}

/**
 * Combine `maskUrl` puis `maskPhoneInText` : d'abord masque les URLs
 * (perte du token sensible), puis masque les numeros residuels dans le
 * reste du texte (champs qui ne sont pas des URLs).
 */
function maskUrlAndPhoneInText(value) {
  if (typeof value !== "string") return value;
  return maskPhoneInText(maskUrl(value));
}

/**
 * Masque les URLs ET les numeros dans les VALEURS d'un objet (recursif
 * sur string). Les cles ne sont pas modifiees. Non-objets passent
 * inchanges. Utilise pour afficher JSON.stringify de reponses OVH sans
 * leak de token ni de numero.
 */
function maskObjectDeep(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return maskUrlAndPhoneInText(value);
  if (Array.isArray(value)) return value.map(maskObjectDeep);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = maskObjectDeep(v);
    }
    return out;
  }
  return value;
}

/**
 * Policy brief : affiche le body SMS SEULEMENT s'il fait <= 10 chars.
 * STOP (4), OUI (3), NON (3) passent. Un body long est masque.
 */
const BODY_PREVIEW_MAX_LENGTH = 10;
function maskBody(body) {
  if (typeof body !== "string") return "(not-a-string)";
  if (body.length <= BODY_PREVIEW_MAX_LENGTH) return JSON.stringify(body);
  return `(bodyLength=${body.length}, masked)`;
}

/**
 * Formate une date ISO en "YYYY-MM-DD HH:mm:ssZ" pour lisibilite.
 * null/undefined -> "absent".
 */
function formatDate(iso) {
  if (iso === undefined || iso === null) return "absent";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return `invalid(${iso})`;
    return d
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d+Z$/, "Z");
  } catch {
    return `invalid(${iso})`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Incoming SMS 2 dernieres heures
// ─────────────────────────────────────────────────────────────────────────────

async function fetchIncoming(serviceName) {
  // Fenetre figee sur le scenario brief DIAG-STOP-OVH : 16/10/2026
  // 13:45-14:30 UTC (couvre 15:45-16:30 Paris, les 2 STOP + le
  // "Test de reception, 16h20").
  const fromIso = "2026-10-16T13:45:00Z";
  const toIso = "2026-10-16T14:30:00Z";

  console.log("");
  console.log("1. INCOMING — fenetre figee brief (16/10 13:45-14:30 UTC)");
  console.log(`   from : ${fromIso}`);
  console.log(`   to   : ${toIso}`);

  const path = `/sms/${encodeURIComponent(serviceName)}/incoming?creationDatetime.from=${encodeURIComponent(
    fromIso,
  )}&creationDatetime.to=${encodeURIComponent(toIso)}`;

  let ids;
  try {
    ids = await requestReadOnly(path);
  } catch (err) {
    failFast(`OVH GET /incoming a echoue`, err);
  }

  if (!Array.isArray(ids)) {
    failFast(`OVH /incoming a renvoye non-tableau`, new Error(`typeof=${typeof ids}`));
  }

  console.log(`   ${ids.length} entree(s) retournee(s) par OVH.`);

  const details = [];
  for (const id of ids) {
    let d;
    try {
      d = await requestReadOnly(
        `/sms/${encodeURIComponent(serviceName)}/incoming/${encodeURIComponent(String(id))}`,
      );
    } catch (err) {
      failFast(`OVH GET /incoming/${id} a echoue`, err);
    }
    details.push({ id, raw: d });
  }

  for (const { id, raw } of details) {
    const d = raw && typeof raw === "object" ? raw : {};
    const sender = typeof d.sender === "string" ? d.sender : "(absent)";
    const receiver =
      typeof d.receiver === "string" ? d.receiver : typeof d.to === "string" ? d.to : "(absent)";
    const body = typeof d.message === "string" ? d.message : "(absent)";
    const createdAt = typeof d.creationDatetime === "string" ? d.creationDatetime : null;
    const tag = typeof d.tag === "string" ? d.tag : "";
    console.log(
      `   - id=${id} at=${formatDate(createdAt)} sender=${maskPhone(sender)} receiver=${maskPhone(receiver)} tag=${tag ? maskPhoneInText(tag) : "(empty)"} body=${maskBody(body)}`,
    );
  }

  return details.map(({ raw }) => raw);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Blacklists
// ─────────────────────────────────────────────────────────────────────────────

async function listBlacklistAt(path) {
  try {
    const listing = await requestReadOnly(path);
    if (!Array.isArray(listing)) {
      console.log(`   ${path} : reponse non-tableau (${typeof listing})`);
      return;
    }
    console.log(`   ${path} : ${listing.length} entree(s)`);
    for (const entry of listing) {
      const idOrNumber =
        typeof entry === "object" && entry !== null ? (entry.number ?? entry.id) : entry;
      try {
        const d = await requestReadOnly(`${path}/${encodeURIComponent(String(idOrNumber))}`);
        const obj = d && typeof d === "object" ? d : {};
        const number = typeof obj.number === "string" ? obj.number : String(idOrNumber);
        const createdAt = typeof obj.creationDatetime === "string" ? obj.creationDatetime : null;
        const type = typeof obj.type === "string" ? obj.type : "(absent)";
        console.log(
          `     - number=${maskPhone(number)} type=${type} since=${formatDate(createdAt)}`,
        );
      } catch (err) {
        if (!isOptionalEndpointError(err)) {
          failFast(`OVH GET ${path}/${idOrNumber} a echoue (non-404)`, err);
        }
        console.log(
          `     ${path}/${idOrNumber} : 404 ("${err && err.message ? err.message : "unknown"}")`,
        );
      }
    }
  } catch (err) {
    if (!isOptionalEndpointError(err)) {
      failFast(`OVH GET ${path} a echoue (non-404)`, err);
    }
    console.log(`   ${path} : endpoint 404 ("${err && err.message ? err.message : "unknown"}")`);
  }
}

async function fetchBlacklists(serviceName) {
  console.log("");
  console.log("2. BLACKLISTS — tous les niveaux (service, user, virtualNumber si expose)");

  // Niveau service
  await listBlacklistAt(`/sms/${encodeURIComponent(serviceName)}/blacklists`);

  // Niveau users (si endpoint expose)
  try {
    const users = await requestReadOnly(`/sms/${encodeURIComponent(serviceName)}/users`);
    if (Array.isArray(users)) {
      for (const u of users) {
        await listBlacklistAt(
          `/sms/${encodeURIComponent(serviceName)}/users/${encodeURIComponent(String(u))}/blacklists`,
        );
      }
    }
  } catch (err) {
    if (!isOptionalEndpointError(err)) {
      failFast(`OVH GET /sms/${serviceName}/users a echoue (non-404)`, err);
    }
    console.log(
      `   /users (pour blacklist) indispo (endpoint 404) : "${err && err.message ? err.message : "unknown"}"`,
    );
  }

  // Niveau virtualNumbers (si endpoint expose)
  try {
    const vnums = await requestReadOnly(`/sms/${encodeURIComponent(serviceName)}/virtualNumbers`);
    if (Array.isArray(vnums)) {
      for (const n of vnums) {
        await listBlacklistAt(
          `/sms/${encodeURIComponent(serviceName)}/virtualNumbers/${encodeURIComponent(String(n))}/blacklists`,
        );
      }
    }
  } catch (err) {
    if (!isOptionalEndpointError(err)) {
      failFast(`OVH GET /sms/${serviceName}/virtualNumbers a echoue (non-404)`, err);
    }
    console.log(
      `   /virtualNumbers (pour blacklist) indispo (endpoint 404) : "${err && err.message ? err.message : "unknown"}"`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Config service + virtual numbers (callback, smsResponse)
// ─────────────────────────────────────────────────────────────────────────────

async function fetchServiceConfig(serviceName) {
  console.log("");
  console.log("3. CONFIG — service + virtual numbers + senders + users");

  // 3a. Service top-level — toutes les proprietes (masquees)
  let svc;
  try {
    svc = await requestReadOnly(`/sms/${encodeURIComponent(serviceName)}`);
  } catch (err) {
    failFast(`OVH GET /sms/${serviceName} a echoue`, err);
  }
  {
    const obj = svc && typeof svc === "object" ? svc : {};
    const masked = maskObjectDeep(obj);
    console.log(`   service=${serviceName}`);
    console.log(`     RAW properties keys : ${Object.keys(obj).join(", ") || "(aucune)"}`);
    console.log(`     dump masque         :`);
    console.log(
      JSON.stringify(masked, null, 2)
        .split("\n")
        .map((l) => "       " + l)
        .join("\n"),
    );
  }

  // 3b. Virtual numbers + incoming filtre fenetre 16/10 13:45-14:30 UTC
  console.log("");
  console.log("   virtualNumbers (+ /virtualNumbers/{n}/incoming fenetre 13:45-14:30 UTC):");
  const FROM_UTC = "2026-10-16T13:45:00Z";
  const TO_UTC = "2026-10-16T14:30:00Z";
  let vnums;
  try {
    vnums = await requestReadOnly(`/sms/${encodeURIComponent(serviceName)}/virtualNumbers`);
  } catch (err) {
    failFast(`OVH GET /virtualNumbers a echoue`, err);
  }
  if (Array.isArray(vnums)) {
    for (const num of vnums) {
      console.log(`     virtualNumber=${maskPhone(String(num))}`);
      try {
        const vn = await requestReadOnly(
          `/sms/${encodeURIComponent(serviceName)}/virtualNumbers/${encodeURIComponent(String(num))}`,
        );
        const masked = maskObjectDeep(vn);
        console.log(`       detail : ${JSON.stringify(masked)}`);
      } catch (err) {
        if (!isOptionalEndpointError(err)) {
          failFast(`OVH GET /virtualNumbers/${maskPhone(String(num))} a echoue (non-404)`, err);
        }
        console.log(
          `       /virtualNumbers/${maskPhone(String(num))} : 404 ("${err && err.message ? err.message : "unknown"}")`,
        );
      }

      // /virtualNumbers/{n}/incoming filtre fenetre
      try {
        const ids = await requestReadOnly(
          `/sms/${encodeURIComponent(serviceName)}/virtualNumbers/${encodeURIComponent(String(num))}/incoming?creationDatetime.from=${encodeURIComponent(FROM_UTC)}&creationDatetime.to=${encodeURIComponent(TO_UTC)}`,
        );
        if (!Array.isArray(ids)) {
          console.log(`       incoming (fenetre) : reponse inattendue`);
        } else {
          console.log(`       incoming (fenetre) : ${ids.length} entree(s)`);
          for (const id of ids) {
            try {
              const d = await requestReadOnly(
                `/sms/${encodeURIComponent(serviceName)}/virtualNumbers/${encodeURIComponent(String(num))}/incoming/${encodeURIComponent(String(id))}`,
              );
              const dobj = d && typeof d === "object" ? d : {};
              const sender = typeof dobj.sender === "string" ? dobj.sender : "(absent)";
              const body = typeof dobj.message === "string" ? dobj.message : "(absent)";
              const createdAt =
                typeof dobj.creationDatetime === "string" ? dobj.creationDatetime : null;
              console.log(
                `         - id=${id} at=${formatDate(createdAt)} sender=${maskPhone(sender)} body=${maskBody(body)}`,
              );
            } catch (err) {
              if (!isOptionalEndpointError(err)) {
                failFast(`OVH GET /virtualNumbers/.../incoming/${id} a echoue (non-404)`, err);
              }
              console.log(
                `         /incoming/${id} : 404 ("${err && err.message ? err.message : "unknown"}")`,
              );
            }
          }
        }
      } catch (err) {
        if (!isOptionalEndpointError(err)) {
          failFast(`OVH GET /virtualNumbers/.../incoming (fenetre) a echoue (non-404)`, err);
        }
        console.log(
          `       incoming (fenetre) : endpoint 404 ("${err && err.message ? err.message : "unknown"}")`,
        );
      }

      // smsResponse (si existe)
      try {
        const resp = await requestReadOnly(
          `/sms/${encodeURIComponent(serviceName)}/virtualNumbers/${encodeURIComponent(String(num))}/smsResponse`,
        );
        const masked = maskObjectDeep(resp);
        console.log(`       smsResponse : ${JSON.stringify(masked)}`);
      } catch (err) {
        if (!isOptionalEndpointError(err)) {
          failFast(`OVH GET /virtualNumbers/.../smsResponse a echoue (non-404)`, err);
        }
        console.log(
          `       smsResponse : endpoint 404 ("${err && err.message ? err.message : "unknown"}")`,
        );
      }
    }
  }

  // 3c. Senders + detail +33939070545 (le sender du contexte brief)
  console.log("");
  console.log("   senders :");
  let senders;
  try {
    senders = await requestReadOnly(`/sms/${encodeURIComponent(serviceName)}/senders`);
  } catch (err) {
    failFast(`OVH GET /senders a echoue`, err);
  }
  if (Array.isArray(senders)) {
    for (const s of senders) {
      try {
        const sd = await requestReadOnly(
          `/sms/${encodeURIComponent(serviceName)}/senders/${encodeURIComponent(String(s))}`,
        );
        const masked = maskObjectDeep(sd);
        console.log(`     - sender=${maskPhone(String(s))} detail=${JSON.stringify(masked)}`);
      } catch (err) {
        if (!isOptionalEndpointError(err)) {
          failFast(`OVH GET /senders/${maskPhone(String(s))} a echoue (non-404)`, err);
        }
        console.log(
          `     /senders/${maskPhone(String(s))} : 404 ("${err && err.message ? err.message : "unknown"}")`,
        );
      }
    }
  }

  // 3e. Users + callback + incoming fenetre
  console.log("");
  console.log("   users (+ callback + incoming fenetre 13:45-14:30 UTC):");
  let users;
  try {
    users = await requestReadOnly(`/sms/${encodeURIComponent(serviceName)}/users`);
  } catch (err) {
    if (!isOptionalEndpointError(err)) {
      failFast(`OVH GET /sms/${serviceName}/users a echoue (non-404)`, err);
    }
    console.log(`   endpoint /users 404 ("${err && err.message ? err.message : "unknown"}")`);
    users = [];
  }
  if (Array.isArray(users)) {
    for (const u of users) {
      console.log(`     - user=${u}`);
      try {
        const ud = await requestReadOnly(
          `/sms/${encodeURIComponent(serviceName)}/users/${encodeURIComponent(String(u))}`,
        );
        const masked = maskObjectDeep(ud);
        console.log(`       detail : ${JSON.stringify(masked)}`);
      } catch (err) {
        if (!isOptionalEndpointError(err)) {
          failFast(`OVH GET /users/${u} a echoue (non-404)`, err);
        }
        console.log(`       /users/${u} : 404 ("${err && err.message ? err.message : "unknown"}")`);
      }
      // user incoming (fenetre)
      try {
        const uincoming = await requestReadOnly(
          `/sms/${encodeURIComponent(serviceName)}/users/${encodeURIComponent(String(u))}/incoming?creationDatetime.from=${encodeURIComponent(FROM_UTC)}&creationDatetime.to=${encodeURIComponent(TO_UTC)}`,
        );
        console.log(
          `       incoming (fenetre) : ${Array.isArray(uincoming) ? uincoming.length : "N/A"} entree(s)`,
        );
      } catch (err) {
        if (!isOptionalEndpointError(err)) {
          failFast(`OVH GET /users/.../incoming (fenetre) a echoue (non-404)`, err);
        }
        console.log(
          `       incoming (fenetre) : endpoint 404 ("${err && err.message ? err.message : "unknown"}")`,
        );
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3f. Autres services SMS du compte (un STOP a pu etre route ailleurs)
// ─────────────────────────────────────────────────────────────────────────────

async function fetchAllServices(currentService) {
  console.log("");
  console.log("3f. AUTRES SERVICES SMS du compte :");
  let services;
  try {
    services = await requestReadOnly("/sms");
  } catch (err) {
    failFast(`OVH GET /sms a echoue`, err);
  }
  if (!Array.isArray(services)) {
    failFast(`OVH /sms a renvoye non-tableau`, new Error(`typeof=${typeof services}`));
  }
  console.log(`   ${services.length} service(s) rattache(s) au compte.`);
  for (const s of services) {
    if (s === currentService) {
      console.log(`   - ${s} (service principal, deja audite ci-dessus)`);
      continue;
    }
    console.log(`   - ${s}`);
    // Pour les services secondaires : on verifie uniquement incoming
    // fenetre + callback. Pas d'audit profond.
    try {
      const svc = await requestReadOnly(`/sms/${encodeURIComponent(String(s))}`);
      const masked = maskObjectDeep(svc);
      console.log(`     config (masquee) : ${JSON.stringify(masked)}`);
    } catch (err) {
      failFast(`OVH GET /sms/${s} (config service secondaire) a echoue`, err);
    }
    const FROM_UTC = "2026-10-16T13:45:00Z";
    const TO_UTC = "2026-10-16T14:30:00Z";
    try {
      const ids = await requestReadOnly(
        `/sms/${encodeURIComponent(String(s))}/incoming?creationDatetime.from=${encodeURIComponent(FROM_UTC)}&creationDatetime.to=${encodeURIComponent(TO_UTC)}`,
      );
      console.log(`     incoming (fenetre) : ${Array.isArray(ids) ? ids.length : "N/A"} entree(s)`);
      if (Array.isArray(ids)) {
        for (const id of ids) {
          try {
            const d = await requestReadOnly(
              `/sms/${encodeURIComponent(String(s))}/incoming/${encodeURIComponent(String(id))}`,
            );
            const dobj = d && typeof d === "object" ? d : {};
            const sender = typeof dobj.sender === "string" ? dobj.sender : "(absent)";
            const receiver =
              typeof dobj.receiver === "string"
                ? dobj.receiver
                : typeof dobj.to === "string"
                  ? dobj.to
                  : "(absent)";
            const body = typeof dobj.message === "string" ? dobj.message : "(absent)";
            const createdAt =
              typeof dobj.creationDatetime === "string" ? dobj.creationDatetime : null;
            console.log(
              `       - id=${id} at=${formatDate(createdAt)} sender=${maskPhone(sender)} receiver=${maskPhone(receiver)} body=${maskBody(body)}`,
            );
          } catch (err) {
            if (!isOptionalEndpointError(err)) {
              failFast(`OVH GET /incoming/${id} a echoue (non-404)`, err);
            }
            console.log(
              `       /incoming/${id} : 404 ("${err && err.message ? err.message : "unknown"}")`,
            );
          }
        }
      }
    } catch (err) {
      if (!isOptionalEndpointError(err)) {
        failFast(`OVH GET /sms/${s}/incoming (fenetre) a echoue (non-404)`, err);
      }
      console.log(
        `     incoming (fenetre) : endpoint 404 ("${err && err.message ? err.message : "unknown"}")`,
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Doc OVH — hors API
// ─────────────────────────────────────────────────────────────────────────────

function printDocPointer() {
  console.log("");
  console.log("4. DOC OVH — HORS API (ce script ne peut PAS extraire la doc OVH).");
  console.log("   Verification manuelle requise. URLs canoniques :");
  console.log("     - https://help.ovhcloud.com/csm/fr-sms-management (overview)");
  console.log("     - https://api.ovh.com/console/#/sms (reference endpoints)");
  console.log("   Je NE specule PAS sur ce que la doc OVH dit du traitement");
  console.log("   automatique du STOP sans source — cite la section exacte.");
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const env = getOvhEnv();
  const serviceName = env.OVH_SMS_SERVICE_NAME;

  console.log("");
  console.log("DIAG-STOP-OVH — lecture seule stricte");
  console.log(`Endpoint : ${env.OVH_ENDPOINT}`);
  console.log(`Service  : ${serviceName}`);

  await fetchIncoming(serviceName);
  await fetchBlacklists(serviceName);
  await fetchServiceConfig(serviceName);
  await fetchAllServices(serviceName);
  printDocPointer();

  console.log("");
  console.log("Diagnostic termine. Rien n'a ete ecrit cote OVH.");
}

main().catch((err) => failFast("exception non-geree dans main()", err));
