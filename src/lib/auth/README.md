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

Dashboard Clerk → **Sessions** → **Customize session token** → Edit :

```json
{
  "role":      "{{user.public_metadata.role}}",
  "firstName": "{{user.first_name}}",
  "lastName":  "{{user.last_name}}"
}
```

- `role` est lu par `requireRole()` côté serveur.
- `firstName` / `lastName` permettent d'afficher l'avatar/menu user dans
  l'UI sans round-trip API Clerk supplémentaire à chaque page.

### 2. publicMetadata.role pour chaque utilisateur

Dashboard Clerk → **Users** → sélectionner un utilisateur →
**Metadata** → **Public** → ajouter :

```json
{
  "role": "admin"
}
```

ou

```json
{
  "role": "commercial"
}
```

**Toute autre valeur** (`"superadmin"`, `""`, `null`, absente) → l'utilisateur
sera refusé par `requireRole()` avec `ForbiddenError` et un message FR
« Rôle utilisateur non configuré. Contactez l'administrateur. »

Sentinelle de config : un `logger.warn` est émis côté serveur quand le
JWT n'a pas la forme attendue — facile à voir en dev.

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

Mock `@clerk/nextjs/server::auth` via `vi.mock`. Pas de `@clerk/testing`
en S10.1.1 — réservé pour Playwright E2E (sprint S11+).
