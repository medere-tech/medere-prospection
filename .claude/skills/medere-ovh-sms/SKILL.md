---
name: medere-ovh-sms
description: Intégration OVHcloud SMS API pour le projet Médéré. Détaille l'authentification, l'envoi de SMS sortants, la réception via webhook, le parsing E.164, et la gestion d'erreurs. À utiliser pour tout travail sur l'envoi/réception SMS, sur les webhooks OVH, ou sur le wrapper src/lib/ovh/. Trigger sur les mots "OVH", "ovhcloud", "SMS sortant", "SMS entrant", "http2sms", "consumerKey", "appKey", "serviceName", "webhook OVH", "sender", "receiver", "E.164".
allowed-tools: Read, Edit, Write, Grep, Glob, Bash
---

# Médéré OVH SMS — Intégration complète

Cette skill documente tout ce qu'il faut savoir pour intégrer l'API OVH SMS dans le projet. Si tu modifies `src/lib/ovh/`, tu DOIS la consulter.

## Pourquoi OVHcloud SMS

- **Souverain français** : données restent en France, conforme RGPD strict
- **Prix compétitif** : ~0.035-0.045€/SMS sortant FR (vs 0.045€/SMS Twilio FR)
- **API stable et documentée** : SDK officiel `@ovhcloud/node-ovh`
- **Compte SMS dédié** chez Médéré (à créer si pas encore fait)

## Authentification OVH (essentielle à comprendre)

OVH utilise un système à 3 clés :

| Clé | Rôle | Où la récupérer |
|---|---|---|
| `appKey` | Identifie l'application (publique) | https://api.ovh.com/createApp/ |
| `appSecret` | Secret de l'application | Lors de la création de l'app |
| `consumerKey` | Identifie l'utilisateur final et SES DROITS | À générer via flow OAuth-like |

**Étape unique de setup** :

```typescript
// scripts/ovh-create-credentials.ts (à exécuter UNE FOIS)
import ovhApi from '@ovhcloud/node-ovh';

const ovh = ovhApi({
  endpoint: 'ovh-eu',
  appKey: process.env.OVH_APP_KEY,
  appSecret: process.env.OVH_APP_SECRET,
});

const result = await ovh.requestPromised('POST', '/auth/credential', {
  // PRINCIPE DU MOINDRE PRIVILÈGE : on demande uniquement les droits nécessaires
  accessRules: [
    { method: 'GET',  path: '/sms' },
    { method: 'GET',  path: '/sms/*' },
    { method: 'POST', path: '/sms/*/jobs' },           // envoyer SMS
    { method: 'GET',  path: '/sms/*/outgoing' },       // historique sortant
    { method: 'GET',  path: '/sms/*/outgoing/*' },
    { method: 'GET',  path: '/sms/*/incoming' },       // historique entrant
    { method: 'GET',  path: '/sms/*/incoming/*' },
  ],
});

console.log('Visite cette URL pour valider :', result.validationUrl);
console.log('Consumer key à sauvegarder :', result.consumerKey);
```

**Important** :
- Le consumer key n'est valide qu'APRÈS validation manuelle de l'URL par un admin OVH
- Il a une durée de vie (par défaut illimitée si pas spécifié, mais peut être révoqué)
- Le scope est strict : pas de droits inutiles (pas de `DELETE`, pas d'accès à `/me`, etc.)
- Si compromis : on le révoque depuis l'espace client OVH, on en regénère un nouveau

## Variables d'environnement nécessaires

```bash
OVH_ENDPOINT=ovh-eu                  # 'ovh-eu' pour la France
OVH_APP_KEY=                         # public
OVH_APP_SECRET=                      # secret
OVH_CONSUMER_KEY=                    # secret, scopé
OVH_SMS_SERVICE_NAME=                # ex: sms-ab12345-1 (récupérable via API)
OVH_SMS_SENDER=Medere                # nom d'expéditeur (max 11 chars, validé chez OVH)
OVH_WEBHOOK_SECRET=                  # secret partagé pour signer les webhooks entrants
```

## Wrapper client (`src/lib/ovh/client.ts`)

Singleton avec validation au boot :

```typescript
import ovhApi from '@ovhcloud/node-ovh';
import { env } from '@/lib/security/env';
import { logger } from '@/lib/utils/logger';

let _ovhClient: ReturnType<typeof ovhApi> | null = null;

export function getOvhClient() {
  if (_ovhClient) return _ovhClient;
  
  _ovhClient = ovhApi({
    endpoint: env.OVH_ENDPOINT,
    appKey: env.OVH_APP_KEY,
    appSecret: env.OVH_APP_SECRET,
    consumerKey: env.OVH_CONSUMER_KEY,
  });
  
  logger.info('OVH client initialized');
  return _ovhClient;
}
```

## Envoi d'un SMS (`src/lib/ovh/send-sms.ts`)

```typescript
import { getOvhClient } from './client';
import { env } from '@/lib/security/env';
import { z } from 'zod';

const SendSmsResponseSchema = z.object({
  totalCreditsRemoved: z.number(),
  ids: z.array(z.number()),
  validReceivers: z.array(z.string()),
  invalidReceivers: z.array(z.string()),
});

export type SendSmsParams = {
  receiver: string;       // E.164, ex: +33612345678
  message: string;        // Max 160 chars (1 SMS) ou plus (multi-SMS)
  smsClass?: 0 | 1 | 2 | 3;   // 1 = normal
  noStopClause?: boolean;     // true si on a déjà mis STOP dans le message
};

export type SendSmsResult =
  | { ok: true; jobId: number; credits: number; receivers: string[] }
  | { ok: false; reason: string; invalidReceivers?: string[] };

export async function sendSms(params: SendSmsParams): Promise<SendSmsResult> {
  const ovh = getOvhClient();
  
  // OVH attend des numéros sans le "+" parfois — à tester. Documentation officielle dit E.164 avec +.
  // Format recommandé d'après ovh/docs : "+33612345678"
  
  try {
    const response = await ovh.requestPromised(
      'POST',
      `/sms/${env.OVH_SMS_SERVICE_NAME}/jobs`,
      {
        message: params.message,
        sender: env.OVH_SMS_SENDER,
        receivers: [params.receiver],
        class: params.smsClass ?? 1,
        // OVH ajoute automatiquement une mention STOP en fin de message.
        // On désactive si on a déjà mis STOP nous-mêmes.
        noStopClause: params.noStopClause ?? true,
        // Booléen : si true, message stocké pour validation manuelle avant envoi
        validityPeriod: 2880,    // minutes, défaut 2880 (48h)
      }
    );
    
    const parsed = SendSmsResponseSchema.safeParse(response);
    if (!parsed.success) {
      logger.error({ response, error: parsed.error }, 'OVH response unexpected shape');
      return { ok: false, reason: 'Unexpected OVH response shape' };
    }
    
    if (parsed.data.invalidReceivers.length > 0) {
      return {
        ok: false,
        reason: 'Invalid receivers',
        invalidReceivers: parsed.data.invalidReceivers,
      };
    }
    
    if (parsed.data.ids.length === 0) {
      return { ok: false, reason: 'No job ID returned' };
    }
    
    return {
      ok: true,
      jobId: parsed.data.ids[0],
      credits: parsed.data.totalCreditsRemoved,
      receivers: parsed.data.validReceivers,
    };
  } catch (error) {
    // Erreurs OVH : 4xx (input invalide), 5xx (OVH down), réseau
    logger.error({ error, params: { ...params, receiver: '[REDACTED]' } }, 'OVH send failed');
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'Unknown OVH error',
    };
  }
}
```

**À noter** :
- `noStopClause: true` : on contrôle nous-même l'ajout du STOP, sinon OVH en rajoute un en plus (double mention)
- `receivers` est un tableau → pour scale, on peut envoyer en batch, MAIS pour l'audit log et la traçabilité on envoie 1 par 1
- `class: 1` = classe normale (stocké sur SIM, lu par destinataire)

## Récupération d'un SMS sortant

Pour vérifier le statut d'un SMS envoyé :

```typescript
export async function getOutgoingStatus(jobId: number) {
  const ovh = getOvhClient();
  const job = await ovh.requestPromised(
    'GET',
    `/sms/${env.OVH_SMS_SERVICE_NAME}/outgoing/${jobId}`
  );
  return job;
}
```

Status OVH possibles : `delivered`, `delivering`, `failed`, `error`, etc.

## Réception d'un SMS entrant — Webhook

### Configuration côté OVH

OVH ne signe PAS nativement les webhooks. Notre stratégie :

1. Configurer le callback URL dans l'espace client OVH : `https://medere-prospection.vercel.app/api/webhooks/ovh-sms?token=<OVH_WEBHOOK_SECRET>`
2. Le `?token=` sert de "signature" via shared secret
3. Vérification côté code : si le token ne match pas, on retourne 401 sans traiter

**Attention** : ce n'est PAS aussi sécurisé que HMAC. À renforcer si OVH améliore son système, ou en passant par un proxy comme Hookdeck.

### Endpoint webhook (`src/app/api/webhooks/ovh-sms/route.ts`)

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/security/env';
import { logger } from '@/lib/utils/logger';
import { parseIncomingSms } from '@/lib/ovh/parse-incoming';
import { inngest } from '@/inngest/client';
import { rateLimiter } from '@/lib/security/rate-limit';

export async function POST(req: NextRequest) {
  // 1. Rate limit par IP (anti-DDoS)
  const ip = req.headers.get('x-forwarded-for') ?? 'unknown';
  const rl = await rateLimiter.limit(`ovh-webhook:${ip}`);
  if (!rl.success) {
    return NextResponse.json({ error: 'Rate limited' }, { status: 429 });
  }
  
  // 2. Vérification du token "signature"
  const token = req.nextUrl.searchParams.get('token');
  if (token !== env.OVH_WEBHOOK_SECRET) {
    logger.warn({ ip }, 'OVH webhook called with invalid token');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  
  // 3. Parse le payload OVH
  let payload: unknown;
  try {
    const contentType = req.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      payload = await req.json();
    } else {
      // OVH peut envoyer en form-urlencoded
      const formData = await req.formData();
      payload = Object.fromEntries(formData.entries());
    }
  } catch (error) {
    logger.error({ error }, 'OVH webhook body parse failed');
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }
  
  // 4. Valider le shape
  const parsed = parseIncomingSms(payload);
  if (!parsed.ok) {
    logger.error({ payload, error: parsed.reason }, 'OVH webhook payload invalid');
    return NextResponse.json({ error: parsed.reason }, { status: 400 });
  }
  
  // 5. Ack immédiat à OVH (< 3s) — traitement async via Inngest
  await inngest.send({
    name: 'sms/inbound.received',
    data: parsed.message,
  });
  
  // 6. Retourner 200 vite
  return NextResponse.json({ ok: true }, { status: 200 });
}
```

### Parser du payload entrant (`src/lib/ovh/parse-incoming.ts`)

Le format exact OVH varie ; voici un parseur défensif :

```typescript
import { z } from 'zod';

// Format attendu OVH (à confirmer avec leur doc actuelle) :
const OvhIncomingSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  sender: z.string(),               // Le numéro du PS qui répond
  receiver: z.string().optional(),  // Notre sender ID
  message: z.string(),              // Contenu du SMS
  date: z.string().optional(),      // ISO timestamp
});

export type ParsedIncomingSms = {
  externalId: string;
  fromPhone: string;     // E.164 du PS
  body: string;
  receivedAt: Date;
};

export function parseIncomingSms(
  raw: unknown
): { ok: true; message: ParsedIncomingSms } | { ok: false; reason: string } {
  const result = OvhIncomingSchema.safeParse(raw);
  
  if (!result.success) {
    return { ok: false, reason: `Invalid shape: ${result.error.message}` };
  }
  
  // Normalisation du numéro en E.164
  const e164 = normalizePhone(result.data.sender);
  if (!e164) {
    return { ok: false, reason: `Cannot normalize phone: ${result.data.sender}` };
  }
  
  return {
    ok: true,
    message: {
      externalId: result.data.id,
      fromPhone: e164,
      body: result.data.message,
      receivedAt: result.data.date ? new Date(result.data.date) : new Date(),
    },
  };
}

function normalizePhone(raw: string): string | null {
  // Utilise libphonenumber-js pour parser
  const { parsePhoneNumberFromString } = require('libphonenumber-js');
  const parsed = parsePhoneNumberFromString(raw, 'FR');
  return parsed?.isValid() ? parsed.format('E.164') : null;
}
```

## Format E.164 — Règles strictes

Tous les numéros stockés dans Firestore et envoyés à OVH DOIVENT être en E.164 :

- **Format** : `+` suivi du code pays + numéro national, **sans espaces ni séparateurs**
- **France métropolitaine** : `+33` + 9 chiffres (en supprimant le 0 initial)
  - `0612345678` → `+33612345678`
  - `06 12 34 56 78` → `+33612345678`
- **DOM-TOM** : codes spécifiques (`+590` Guadeloupe, `+596` Martinique, `+594` Guyane, `+262` La Réunion/Mayotte)

Toujours utiliser `libphonenumber-js` pour parser, ne JAMAIS le faire à la main.

```typescript
import { parsePhoneNumberFromString } from 'libphonenumber-js';

export function normalizeToE164(raw: string, defaultCountry: 'FR' = 'FR'): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const parsed = parsePhoneNumberFromString(raw, defaultCountry);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.format('E.164');
}
```

## Gestion des erreurs OVH

| Code HTTP OVH | Signification | Action |
|---|---|---|
| 200 | OK | Continue |
| 400 | Input invalide | Logger + ne PAS retry, c'est un bug |
| 401/403 | Auth échouée | Alerter Slack admin, vérifier consumerKey |
| 404 | Route inconnue | Bug dans notre code |
| 429 | Rate limit OVH | Backoff exponentiel, retry après 30s |
| 500 | OVH erreur interne | Retry avec backoff |
| 503 | OVH down | Retry plus tard (Inngest gère) |

```typescript
import { sendSms } from '@/lib/ovh/send-sms';

export async function sendWithRetry(params: SendSmsParams) {
  return await inngest.send({
    name: 'sms/outbound.queued',
    data: params,
  });
}

// Et dans la Inngest function :
export const sendOutboundSms = inngest.createFunction(
  {
    id: 'send-outbound-sms',
    retries: 3,
    rateLimit: { limit: 10, period: '1m' },  // 10 envois/min max
  },
  { event: 'sms/outbound.queued' },
  async ({ event, step }) => {
    const result = await step.run('send-via-ovh', async () => {
      const r = await sendSms(event.data);
      if (!r.ok && r.reason.includes('429')) {
        throw new Error('OVH rate limited, will retry');  // Inngest retry
      }
      return r;
    });
    
    if (!result.ok) {
      // Erreur définitive
      await step.run('log-failure', async () => {
        await auditLog.create({ /* ... */ });
      });
      return;
    }
    
    await step.run('save-message', async () => {
      // Sauvegarder dans Firestore
    });
  }
);
```

## Coûts et budget

| Type | Coût unitaire |
|---|---|
| SMS sortant FR (1 segment de 160 chars) | ~0.040 € |
| SMS sortant FR (long, segmenté) | ~0.040 €/segment |
| SMS sortant DOM-TOM | ~0.060 € |
| SMS sortant international | varie |
| SMS entrant FR (réception) | gratuit ou minime selon plan |

**Budget MVP** : 200 contacts × 3 SMS moyens × 0.040€ = **24€**

**Budget scale 26k** : 26000 × 3 × 0.040€ = **3120€**

Pour budgéter, le champ `cost` dans chaque `Message` doit être rempli après chaque envoi (parsable depuis la réponse OVH ou estimé).

## Tests

```typescript
// tests/unit/ovh/send-sms.test.ts
import { describe, it, expect, vi } from 'vitest';
import { sendSms } from '@/lib/ovh/send-sms';

vi.mock('@ovhcloud/node-ovh', () => ({
  default: () => ({
    requestPromised: vi.fn().mockResolvedValue({
      totalCreditsRemoved: 1,
      ids: [42],
      validReceivers: ['+33612345678'],
      invalidReceivers: [],
    }),
  }),
}));

describe('sendSms', () => {
  it('retourne success avec jobId pour un envoi valide', async () => {
    const result = await sendSms({
      receiver: '+33612345678',
      message: 'Bonjour Dr X, ... STOP',
    });
    
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.jobId).toBe(42);
      expect(result.credits).toBe(1);
    }
  });
});
```

## Tests d'intégration avec OVH réel

À tester sur ton propre numéro AVANT de toucher aux contacts réels :

```bash
# Setup .env.local avec credentials test
OVH_SMS_SENDER=Medere
OVH_CONSUMER_KEY=<ton consumer key>

# Run le script de test
npx tsx scripts/test-ovh-send.ts +336xxxxxxxx "Test Médéré depuis le dev. STOP"
```

Le script doit :
1. Envoyer 1 SMS test
2. Logger le jobId
3. Attendre 30s
4. Vérifier le statut via GET /outgoing/{id}
5. Confirmer `delivered` ou afficher l'erreur

## Limites et points d'attention

- **Sender ID** : `OVH_SMS_SENDER` doit être validé chez OVH AVANT utilisation (process manuel via support). Pas n'importe quoi possible.
- **Caractères spéciaux** : un SMS avec accents (é, à, ç) coûte moins de caractères qu'avec emoji ou caractères chinois. Tester en local pour éviter les surprises.
- **STOP automatique OVH** : par défaut, OVH ajoute "STOP au [n°]" en fin de SMS. C'est inutile pour nous, on met `noStopClause: true` et on gère STOP nous-mêmes.
- **Webhooks OVH non signés** : faille potentielle. Mitigation : token dans l'URL + rate limit + vérification du shape strict.
- **Pas de WhatsApp via OVH** : pour WhatsApp (phase 2), il faudra passer par 360dialog ou Meta Cloud API.

## Référence rapide

Doc OVH officielle :
- https://help.ovhcloud.com/csm/fr-documentation-web-cloud-messaging-sms
- https://eu.api.ovh.com/console/?section=%2Fsms&branch=v1
- https://github.com/ovh/node-ovh

API console pour tester en live (avec ton token de session OVH) :
- https://eu.api.ovh.com/console/

## Fichiers du module

```
src/lib/ovh/
├── client.ts             # Singleton OVH
├── send-sms.ts           # Envoi unitaire
├── send-batch.ts         # Envoi en batch (futur)
├── parse-incoming.ts     # Parser webhook entrant
├── get-status.ts         # Récupérer statut d'un SMS sortant
├── credits.ts            # Vérif solde crédits SMS
└── types.ts              # Types partagés
```
