# `src/lib/auth/` — RBAC Clerk

Helpers d'autorisation pour le dashboard admin Médéré. Branche le custom
claim JWT de Clerk sur le pattern `requireRole(role)` réutilisé dans
chaque server component / route handler protégé.

---

## Modèle de rôles

| Rôle | Membres MVP | Capacités |
|---|---|---|
| `admin` | Déthié, Harry, Justine | Voient tout. Envoient 1er SMS. Futur : voir audits + monitoring. |
| `commercial` | Vanessa, Zacharie, Jeremy, Sophie, etc. | Voient leurs contacts assignés. Envoient 1er SMS. |

**Hiérarchie** : `admin > commercial`. Un admin est un commercial++. Cela
reflète `firestore.rules::isCommercial()` qui autorise `hasRole('commercial') || hasRole('admin')`.

---

## Configuration Clerk dashboard (REQUISE)

### 1. JWT template — custom session claims

Dashboard Clerk → **Sessions** → **Customize session token** → Edit.

**Texte EXACT à copier dans le champ JSON** (ne pas réordonner, ne pas
ajouter de clé — `requireRole` fait un parse Zod strict) :

```json
{
  "role":         "{{user.public_metadata.role}}",
  "firstName":    "{{user.first_name}}",
  "lastName":     "{{user.last_name}}",
  "slackUserId":  "{{user.public_metadata.slackUserId}}"
}
```

**Puis cliquer « Apply changes » en bas de la page.** Les nouveaux
claims sont lus au prochain refresh de session de chaque utilisateur
(Clerk régénère le JWT à l'expiration naturelle ou au prochain sign-in).
Pour forcer une bascule immédiate en dev, se déconnecter et se reconnecter.

**À propos de chaque claim** :

- `role` est lu par `requireRole()` côté serveur. Valeurs attendues :
  `"admin"` ou `"commercial"`.
- `firstName` / `lastName` permettent d'afficher l'avatar/menu user dans
  l'UI sans round-trip API Clerk supplémentaire à chaque page.
- `slackUserId` (VUE-CONVERSATION PR0) : Slack user ID du commercial
  (`U05UVHGBURX`), lu depuis `publicMetadata.slackUserId`. Utilisé pour
  résoudre le titulaire d'une conversation (vue conversation, onglet
  « Mes conversations »). Validation côté serveur par regex
  `^U[A-Z0-9]+$` (Zod). Si `publicMetadata.slackUserId` est absent,
  Clerk remplace par la chaîne vide `""` dans le JWT — `requireRole`
  normalise `""` en `undefined` et dégrade gracieusement (le commercial
  verra l'onglet « Mes conversations » vide, fallback onglet « À traiter »).

### 2. publicMetadata.role pour chaque utilisateur

Dashboard Clerk → **Users** → sélectionner un utilisateur →
**Metadata** → **Public** → ajouter :

```json
{
  "role": "admin"
}
```

ou pour un commercial :

```json
{
  "role": "commercial",
  "slackUserId": "U05UVHGBURX"
}
```

- `role` : obligatoire, `"admin"` ou `"commercial"`.
- `slackUserId` : recommandé pour tous (admin Déthié = `U05UVHGBURX`,
  et chaque commercial avec son ID Slack du workspace Médéré).
  Techniquement optionnel pour un admin qui n'aurait pas de compte
  Slack ; obligatoire pour un commercial si on veut l'onglet
  « Mes conversations » peuplé. Format `U` suivi de majuscules
  et chiffres (ex: `U05UVHGBURX`).

**Toute autre valeur** de `role` (`"superadmin"`, `""`, `null`, absente)
→ l'utilisateur sera refusé par `requireRole()` avec `ForbiddenError`
et un message FR « Rôle utilisateur non configuré. Contactez l'administrateur. »

**Un `slackUserId` mal formé** (minuscules, caractères spéciaux, pas de
préfixe `U`) → refus Zod + `ForbiddenError`. Un `slackUserId` absent est
toléré (dégradation gracieuse).

Sentinelle de config : un `logger.warn` est émis côté serveur quand le
JWT n'a pas la forme attendue — facile à voir en dev.

### 3. Peuplement automatique des `slackUserId` (VUE-CONVERSATION PR0)

Pour éviter d'éditer les 10+ utilisateurs à la main dans Clerk dashboard :

```bash
# Dry-run (par défaut) — affiche ce qui SERAIT écrit
npx tsx scripts/sync-clerk-slack-ids.mjs

# Apply — écrit vraiment publicMetadata.slackUserId via Clerk Backend API
npx tsx scripts/sync-clerk-slack-ids.mjs --apply

# Force overwrite (si un slackUserId existant diffère)
npx tsx scripts/sync-clerk-slack-ids.mjs --apply --force-overwrite
```

Le script lit la table Airtable Commerciaux (même source que
`src/lib/airtable/commerciaux.ts`) et associe chaque utilisateur Clerk
par email. Garde-fous :

- refuse d'écrire si l'email d'un commercial Airtable n'a pas de compte
  Clerk ;
- refuse d'écrire si plusieurs commerciaux Airtable partagent le même
  email (ambiguïté) ;
- refuse d'écraser un `slackUserId` existant sans `--force-overwrite`.

Pré-requis env (noms identiques à l'app, cf. `src/lib/security/env.ts`) :
`CLERK_SECRET_KEY`, `AIRTABLE_PAT`, `AIRTABLE_BASE_ID`, `AIRTABLE_COMMERCIAUX_TABLE_ID`.

---

## Usage

### Server Component

```tsx
// src/app/admin/contacts/page.tsx
import { requireRole } from "@/lib/auth/require-role";

export default async function ContactsPage() {
  const { userId, role, firstName } = await requireRole("commercial");
  // ...
}
```

### Route Handler (API)

```ts
// src/app/api/admin/contacts/[id]/send-first-sms/route.ts
import { ForbiddenError, UnauthorizedError } from "@/lib/utils/errors";
import { requireRole } from "@/lib/auth/require-role";

export async function POST(req: Request) {
  try {
    const { userId, role } = await requireRole("commercial");
    // ...
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return Response.json(err.toClientBody(), { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return Response.json(err.toClientBody(), { status: 403 });
    }
    throw err;
  }
}
```

### Sémantique des erreurs

| Erreur | HTTP | clientMessage par défaut | Quand |
|---|---|---|---|
| `UnauthorizedError` | 401 | « Authentification requise. » | `userId` absent (pas de session Clerk) |
| `ForbiddenError` | 403 | « Accès refusé. » | `sessionClaims` mal configuré OU rôle insuffisant |

Le `clientMessage` peut être override via `new ForbiddenError({ clientMessage: "..." })`
quand un message contextuel a du sens (cf. la sentinelle config Clerk
dans `require-role.ts`).

---

## Tests

`require-role.test.ts` couvre ≥ 95% lines + branches :

- `userId` absent → 401, **pas** de warn
- `sessionClaims` null → 403 + warn sentinelle
- `role` invalide (Zod) → 403 + warn sans fuite de la valeur
- admin sur admin/commercial → OK
- commercial sur commercial → OK
- commercial sur admin → 403
- firstName/lastName présents → extraits
- firstName vide → 403 (Zod `min(1).optional()`)
- `slackUserId` bien formé (U + majuscules/digits) → extrait
- `slackUserId` absent OU chaîne vide `""` → normalisé en `undefined`
- `slackUserId` mal formé (minuscules, caractères spéciaux, pas de `U`) → 403

Mock `@clerk/nextjs/server::auth` via `vi.mock`. Pas de `@clerk/testing`
en S10.1.1 — réservé pour Playwright E2E (sprint S11+).
