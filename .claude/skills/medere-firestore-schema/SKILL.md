---
name: medere-firestore-schema
description: Schéma Firestore complet du projet Médéré Prospection — collections, documents, types TypeScript, règles de sécurité, patterns de requêtes. À utiliser dès qu'on crée, modifie, ou query une collection Firestore. Trigger sur les mots "Firestore", "Firebase", "contacts", "conversations", "messages", "audit_log", "collection", "document", "firestore.rules", "admin SDK", "schema", "Timestamp".
allowed-tools: Read, Edit, Write, Grep, Glob
---

# Médéré Firestore Schema — Source de vérité

Cette skill documente le schéma Firestore complet du projet. Toute opération de lecture/écriture DOIT respecter ces types et ces règles.

## Architecture générale

Firebase Firestore est utilisée comme base de données principale du projet. Accès via :
- **Côté serveur** (API routes, Inngest) : `firebase-admin` SDK qui **bypass les rules** → la sécurité est à la charge du code applicatif
- **Côté client** (dashboard React) : SDK client classique, soumis aux `firestore.rules`

**Règle d'or** : la logique métier critique vit dans les API routes, pas dans le client. Le client peut lire mais écrit uniquement via API.

## Collections

### 1. `contacts/` — Les professionnels de santé

**Document ID** : l'ID HubSpot du contact (sync direct, source de vérité = HubSpot).

```typescript
// src/types/contact.ts
import { Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';

export type ContactStatus =
  | 'pending'           // Importé, pas encore enrichi
  | 'enriched'          // Enrichi via Lusha, pas encore vérifié
  | 'ready'             // Prêt à être contacté
  | 'in_conversation'   // En cours de conversation
  | 'qualified'         // Lead chaud, hand-off effectué
  | 'opted_out'         // A demandé STOP
  | 'archived';         // Inactif, archivé

export type ContactSegment =
  | 'b2b_cabinet'       // Ligne pro de cabinet → B2B, intérêt légitime
  | 'b2c_mobile_perso'  // Mobile perso → B2C, vérif Bloctel obligatoire
  | 'unknown';          // À segmenter

export interface Contact {
  // Identité
  hubspotId: string;
  firstName: string;
  lastName: string;
  civilite?: 'Dr' | 'Pr' | 'M.' | 'Mme';
  speciality: 'dentiste' | 'generaliste' | 'ide' | 'autre';
  city: string;
  postalCode: string;
  email?: string;
  
  // Téléphone (objet imbriqué)
  phone: {
    e164: string;                   // +33612345678
    raw: string;                    // Format original
    type: 'mobile' | 'landline' | 'voip' | 'unknown';
    carrier?: string;
    valid: boolean;
    lookupAt: Timestamp;
  };
  
  // Segmentation B2B/B2C
  segment: ContactSegment;
  bloctelChecked: boolean;
  bloctelOptOut: boolean;
  bloctelCheckedAt?: Timestamp;
  
  // Consentement RGPD
  consent: {
    legitimateInterest: string;     // Texte documentant pourquoi on a le droit de contacter
    optedOut: boolean;
    optedOutAt?: Timestamp;
    optedOutReason?: string;
    optedOutChannel?: 'sms' | 'manual' | 'dashboard';
  };
  
  // Enrichissement
  enrichment: {
    source: 'lusha' | 'hubspot' | 'manual';
    enrichedAt: Timestamp;
    raw?: Record<string, unknown>;   // Données brutes pour audit
  };
  
  // État
  status: ContactStatus;
  campaignId: string;                // À quelle campagne il appartient
  assignedTo?: string;               // Slack user ID si attribué à un commercial
  
  // Metadata
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// Schema Zod pour validation runtime
export const ContactSchema = z.object({
  hubspotId: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  civilite: z.enum(['Dr', 'Pr', 'M.', 'Mme']).optional(),
  speciality: z.enum(['dentiste', 'generaliste', 'ide', 'autre']),
  city: z.string(),
  postalCode: z.string(),
  email: z.string().email().optional(),
  phone: z.object({
    e164: z.string().regex(/^\+\d{10,15}$/),
    raw: z.string(),
    type: z.enum(['mobile', 'landline', 'voip', 'unknown']),
    carrier: z.string().optional(),
    valid: z.boolean(),
    lookupAt: z.any(), // Timestamp
  }),
  segment: z.enum(['b2b_cabinet', 'b2c_mobile_perso', 'unknown']),
  bloctelChecked: z.boolean(),
  bloctelOptOut: z.boolean(),
  bloctelCheckedAt: z.any().optional(),
  consent: z.object({
    legitimateInterest: z.string().min(20, 'Doit documenter précisément l\'intérêt légitime'),
    optedOut: z.boolean(),
    optedOutAt: z.any().optional(),
    optedOutReason: z.string().optional(),
    optedOutChannel: z.enum(['sms', 'manual', 'dashboard']).optional(),
  }),
  enrichment: z.object({
    source: z.enum(['lusha', 'hubspot', 'manual']),
    enrichedAt: z.any(),
    raw: z.record(z.unknown()).optional(),
  }),
  status: z.enum(['pending', 'enriched', 'ready', 'in_conversation', 'qualified', 'opted_out', 'archived']),
  campaignId: z.string(),
  assignedTo: z.string().optional(),
  createdAt: z.any(),
  updatedAt: z.any(),
});
```

**Index Firestore composites nécessaires** :
- `status ASC, campaignId ASC, createdAt DESC` (liste des contacts par statut/campagne)
- `segment ASC, bloctelChecked ASC` (export Bloctel)
- `speciality ASC, city ASC` (filtres dashboard)
- `assignedTo ASC, status ASC` (vue commerciale)

### 2. `conversations/` — Sessions de discussion

**Document ID** : `${contactId}_${campaignId}` (unicité contact-campagne)

```typescript
// src/types/conversation.ts
export type ConversationStatus =
  | 'active'              // En attente de génération 1er SMS
  | 'awaiting_reply'      // SMS envoyé, on attend
  | 'in_dialogue'         // Échange en cours avec l'IA
  | 'qualified'           // Intent positif détecté
  | 'handed_off'          // Transféré à un commercial humain
  | 'closed'              // Conversation terminée
  | 'opted_out'           // PS a demandé STOP
  | 'blocked';            // Bloqué par compliance check

export type Intent = 'INTERESSE' | 'NEUTRE' | 'OBJECTION' | 'STOP' | 'unknown';

export interface Conversation {
  contactId: string;
  campaignId: string;
  channel: 'sms' | 'whatsapp';
  status: ConversationStatus;
  intent: Intent;
  
  messageCount: number;
  outboundCount: number;
  inboundCount: number;
  
  firstMessageAt?: Timestamp;
  lastMessageAt?: Timestamp;
  lastOutboundAt?: Timestamp;
  lastInboundAt?: Timestamp;
  lastIntentChangeAt?: Timestamp;
  
  // Hand-off vers un commercial humain
  handoff?: {
    assignedTo: string;                // Slack user ID
    assignedAt: Timestamp;
    acceptedAt?: Timestamp;
    acceptedBy?: string;
    hubspotDealId?: string;
    notes?: string;
  };
  
  // Relance automatique
  nextActionAt?: Timestamp;
  nextActionType?: 'followup_3d' | 'followup_7d' | 'archive' | 'none';
  followupCount: number;
  
  // Résumé pour le commercial
  summary?: string;
  
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

**Index Firestore composites** :
- `status ASC, intent ASC, lastMessageAt DESC` (vue conversations actives)
- `handoff.assignedTo ASC, status ASC` (vue par commercial)
- `nextActionAt ASC, status ASC` (job de relance)
- `campaignId ASC, status ASC, createdAt DESC` (vue campagne)

### 3. `conversations/{convId}/messages/` — Sous-collection messages

**Document ID** : auto-généré Firestore

```typescript
// src/types/message.ts
export type MessageDirection = 'outbound' | 'inbound';

export type MessageStatus =
  | 'queued'        // En attente d'envoi
  | 'sending'       // En cours d'envoi via OVH
  | 'sent'          // Envoyé, accusé OVH
  | 'delivered'     // Délivré au destinataire (si OVH le confirme)
  | 'failed'        // Échec envoi
  | 'received';     // Reçu (pour inbound)

export interface Message {
  direction: MessageDirection;
  body: string;                       // Contenu exact du SMS
  status: MessageStatus;
  channel: 'sms' | 'whatsapp';
  
  // Métadonnées externes
  externalId?: string;                // ID OVH (jobId) ou Twilio
  externalReceiver?: string;          // E.164 destinataire (outbound) ou expéditeur (inbound)
  
  // Génération IA
  generatedBy: 'ai' | 'human' | 'system';
  aiModel?: string;                   // ex: 'claude-sonnet-4-6'
  aiPromptVersion?: string;           // ex: 'first-sms-v1.0.0'
  aiTemperature?: number;
  aiTokens?: { input: number; output: number };
  
  // Classification (pour les inbound)
  intent?: Intent;
  intentConfidence?: number;
  intentReasoning?: string;
  
  // Coût
  cost?: number;                      // en centimes EUR
  
  // Timestamps
  createdAt: Timestamp;
  queuedAt?: Timestamp;
  sentAt?: Timestamp;
  deliveredAt?: Timestamp;
  receivedAt?: Timestamp;
  
  // Erreurs
  error?: {
    code: string;
    message: string;
    retryCount: number;
  };
}
```

**Index Firestore composites** :
- `direction ASC, createdAt DESC` (thread chronologique)
- `status ASC, createdAt ASC` (queue de messages à envoyer)

### 4. `audit_log/` — Journal d'actions sensibles

**Document ID** : auto-généré Firestore

```typescript
// src/types/audit-log.ts
export type AuditAction =
  | 'sms_sent'
  | 'sms_received'
  | 'sms_failed'
  | 'send_blocked'
  | 'opt_out'
  | 'handoff'
  | 'handoff_accepted'
  | 'manual_override'
  | 'prompt_changed'
  | 'bloctel_imported'
  | 'contact_deleted'
  | 'contact_anonymized'
  | 'campaign_started'
  | 'campaign_paused'
  | 'login'
  | 'role_changed';

export interface AuditLog {
  actorId: string;                    // 'system' | 'ai' | slack user id
  actorType: 'system' | 'ai' | 'human';
  action: AuditAction;
  targetType: 'contact' | 'conversation' | 'message' | 'campaign' | 'user' | 'prompt';
  targetId: string;
  payload: Record<string, unknown>;   // Contexte minimal, JAMAIS de PII en clair
  ipAddress?: string;
  userAgent?: string;
  timestamp: Timestamp;
}
```

**Règles** :
- Append-only : aucune modification, aucune suppression (sauf purge après 5 ans)
- Pas de PII en clair dans `payload` (phone, email, nom complet → hash ou ID Firestore)
- Écriture uniquement via Admin SDK (rules deny côté client)

**Index** :
- `actorId ASC, timestamp DESC`
- `targetType ASC, targetId ASC, timestamp DESC`
- `action ASC, timestamp DESC`

### 5. `prompts/` — Versioning des prompts LLM

**Document ID** : `${promptName}_${version}` (ex: `first-sms_1.0.0`)

```typescript
// src/types/prompt.ts
export interface PromptVersion {
  promptName: string;                 // ex: 'first-sms', 'classify-intent'
  version: string;                    // semver: '1.0.0'
  active: boolean;                    // Une seule version active par promptName
  template: string;                   // Le template complet (avec variables {{...}})
  modelId: string;                    // claude-sonnet-4-6
  temperature: number;
  maxTokens: number;
  
  // Metadata
  description: string;
  createdBy: string;                  // Slack user ID
  createdAt: Timestamp;
  activatedAt?: Timestamp;
  deactivatedAt?: Timestamp;
  
  // Performance tracking
  metrics?: {
    timesUsed: number;
    avgResponseRate?: number;
    avgPositiveIntent?: number;
  };
}
```

**Important** : pour modifier un prompt, on crée une nouvelle version, on désactive l'ancienne, on active la nouvelle. Aucune édition in-place.

### 6. `campaigns/` — Pilotage des envois

**Document ID** : auto-généré ou slug (`dentistes-idf-mai-2026`)

```typescript
export interface Campaign {
  name: string;
  description: string;
  status: 'draft' | 'active' | 'paused' | 'completed';
  
  // Cible
  filters: {
    speciality?: string[];
    cities?: string[];
    segments?: ContactSegment[];
  };
  
  contactCount: number;
  
  // Offre
  offerDescription: string;
  offerVariables?: Record<string, string>;   // Pour personnalisation dans le prompt
  
  // Configuration
  promptVersions: {
    firstSms: string;
    classify: string;
    reply: string;
    followup: string;
  };
  
  // Throttle
  maxSendPerDay: number;              // ex: 50
  
  // Métriques (mises à jour par jobs)
  metrics: {
    sent: number;
    delivered: number;
    replied: number;
    qualified: number;
    handed_off: number;
    opted_out: number;
    failed: number;
  };
  
  createdBy: string;
  createdAt: Timestamp;
  startedAt?: Timestamp;
  pausedAt?: Timestamp;
  completedAt?: Timestamp;
}
```

### 7. `blacklist/` — Numéros à ne JAMAIS contacter

**Document ID** : numéro E.164 (`+33612345678`)

```typescript
export interface BlacklistEntry {
  phoneE164: string;
  reason: 'opt_out' | 'bloctel' | 'invalid' | 'manual';
  optedOutFrom?: string;              // contactId si applicable
  addedAt: Timestamp;
  notes?: string;
}
```

**Vérification systématique avant chaque envoi** : si le numéro est dans `blacklist`, l'envoi est refusé instantanément.

## Règles de sécurité Firestore

Fichier : `firestore.rules` à la racine du repo.

```javascript
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {

    // Helpers
    function signedIn() {
      return request.auth != null;
    }
    
    function hasRole(role) {
      return signedIn() && request.auth.token.role == role;
    }
    
    function isAdmin() {
      return hasRole('admin');
    }
    
    function isCommercial() {
      return hasRole('commercial') || isAdmin();
    }
    
    function isAssignedToMe(resource) {
      return signedIn() && resource.data.handoff.assignedTo == request.auth.uid;
    }

    // === Contacts ===
    match /contacts/{contactId} {
      // Lecture : tous les commerciaux
      allow read: if isCommercial();
      // Écriture : admin uniquement (le reste se fait via API + Admin SDK)
      allow create, update, delete: if isAdmin();
    }

    // === Conversations ===
    match /conversations/{convId} {
      allow read: if isCommercial();
      // Update limité : commercial peut update SA conversation, admin peut tout
      allow update: if isAdmin() || isAssignedToMe(resource);
      allow create, delete: if isAdmin();
      
      // Sous-collection messages
      match /messages/{messageId} {
        allow read: if isCommercial();
        allow create: if isCommercial();       // Pour les messages humains commerciaux
        allow update, delete: if isAdmin();    // Pas de modification d'historique
      }
    }

    // === Audit log ===
    match /audit_log/{logId} {
      allow read: if isAdmin();
      allow write: if false;                   // Admin SDK seulement (bypass rules)
    }

    // === Prompts ===
    match /prompts/{promptId} {
      allow read: if isCommercial();
      allow create, update: if isAdmin();
      allow delete: if false;                  // Versioning : pas de suppression
    }

    // === Campaigns ===
    match /campaigns/{campaignId} {
      allow read: if isCommercial();
      allow write: if isAdmin();
    }

    // === Blacklist ===
    match /blacklist/{phoneE164} {
      allow read: if isCommercial();
      allow create: if isCommercial();         // Tout commercial peut blacklister
      allow update, delete: if isAdmin();      // Modification réservée à admin
    }

    // === Deny everything else ===
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

**À noter** : ces règles ne s'appliquent QU'AUX ACCÈS CLIENT (navigateur). Le backend (Next.js API routes, Inngest functions) utilise `firebase-admin` qui bypass tout. Donc la sécurité du backend doit être assurée par le code applicatif (vérif rôle utilisateur, etc.).

## Patterns de requêtes recommandés

### Lecture d'un contact avec vérif d'existence

```typescript
import { adminDb } from '@/lib/firestore/admin';

export async function getContact(contactId: string): Promise<Contact | null> {
  const doc = await adminDb.collection('contacts').doc(contactId).get();
  if (!doc.exists) return null;
  
  // Validation Zod sur les données lues (pour catch les corruptions)
  const parsed = ContactSchema.safeParse(doc.data());
  if (!parsed.success) {
    logger.error({ contactId, error: parsed.error }, 'Contact data corrupted');
    return null;
  }
  
  return parsed.data as Contact;
}
```

### Listing paginé pour le dashboard

```typescript
export async function listConversations(filters: {
  status?: ConversationStatus;
  assignedTo?: string;
  campaignId?: string;
  cursor?: string;                  // Document ID for pagination
  limit?: number;
}): Promise<{ conversations: Conversation[]; nextCursor: string | null }> {
  let query = adminDb.collection('conversations') as Query;
  
  if (filters.status) query = query.where('status', '==', filters.status);
  if (filters.assignedTo) query = query.where('handoff.assignedTo', '==', filters.assignedTo);
  if (filters.campaignId) query = query.where('campaignId', '==', filters.campaignId);
  
  query = query.orderBy('lastMessageAt', 'desc').limit(filters.limit ?? 25);
  
  if (filters.cursor) {
    const cursorDoc = await adminDb.collection('conversations').doc(filters.cursor).get();
    query = query.startAfter(cursorDoc);
  }
  
  const snap = await query.get();
  const conversations = snap.docs.map(d => ({ id: d.id, ...d.data() })) as Conversation[];
  const nextCursor = snap.docs.length === (filters.limit ?? 25) 
    ? snap.docs[snap.docs.length - 1].id 
    : null;
  
  return { conversations, nextCursor };
}
```

### Transaction pour opérations atomiques

Quand plusieurs documents doivent changer ensemble (ex: marquer une conversation `handed_off` + créer un deal HubSpot + logger l'audit), utiliser une transaction Firestore + des compensations pour les actions externes.

```typescript
export async function handoffConversation(convId: string, commercialId: string) {
  await adminDb.runTransaction(async (tx) => {
    const convRef = adminDb.collection('conversations').doc(convId);
    const conv = await tx.get(convRef);
    
    if (!conv.exists) throw new Error('Conversation not found');
    if (conv.data()!.status === 'handed_off') throw new Error('Already handed off');
    
    tx.update(convRef, {
      status: 'handed_off',
      handoff: {
        assignedTo: commercialId,
        assignedAt: Timestamp.now(),
      },
      updatedAt: Timestamp.now(),
    });
    
    // Audit log dans la même transaction
    tx.create(adminDb.collection('audit_log').doc(), {
      actorId: 'system',
      actorType: 'system',
      action: 'handoff',
      targetType: 'conversation',
      targetId: convId,
      payload: { commercialId },
      timestamp: Timestamp.now(),
    });
  });
  
  // Hors transaction (car appel externe non-atomique avec Firestore) :
  // - Créer deal HubSpot
  // - Notifier Slack
  // En cas d'échec, retry via Inngest, pas de rollback de la transaction Firestore.
}
```

## Pièges à éviter

| Piège | Conséquence | Solution |
|---|---|---|
| Lire un Timestamp comme un Date direct | Erreur runtime | `doc.data()!.createdAt.toDate()` |
| Stocker un objet null/undefined | Firestore le supprime du document | Utiliser `?` dans les types ou valeurs par défaut |
| Faire une requête sans index composite | Erreur Firestore en prod | Définir l'index dans `firestore.indexes.json` |
| Update partiel qui écrase un sous-objet | Perte de données | Utiliser dot notation : `'consent.optedOut': true` |
| Pas de tx pour des updates liées | Incohérence | `adminDb.runTransaction()` |
| Lecture en boucle au lieu de batch | N requêtes au lieu de 1 | `adminDb.getAll(...refs)` ou `where('id', 'in', [...])` |
| Querying sans `.limit()` | Lecture massive, coût exorbitant | Toujours `.limit(N)` |
| Modifier un audit_log | Perte de traçabilité | Append-only, JAMAIS de update |

## Migration depuis HubSpot

Le script `scripts/migrate-contacts.ts` importe les 26k contacts en respectant ce schéma :

```typescript
// Pseudocode
for await (const hubspotContact of hubspotIterator()) {
  const contact: Contact = {
    hubspotId: hubspotContact.id,
    firstName: hubspotContact.properties.firstname || '',
    lastName: hubspotContact.properties.lastname || '',
    speciality: inferSpeciality(hubspotContact),
    // ...
    phone: {
      raw: hubspotContact.properties.phone,
      e164: '',          // sera rempli après normalisation
      type: 'unknown',
      valid: false,
      lookupAt: Timestamp.now(),
    },
    segment: 'unknown',  // sera segmenté après Twilio Lookup
    status: 'pending',
    consent: {
      legitimateInterest: `Contact existant HubSpot Médéré importé le ${new Date().toISOString().slice(0, 10)}. Documentation détaillée de l'origine : [À COMPLETER PAR HARRY]`,
      optedOut: false,
    },
    // ...
  };
  
  const validated = ContactSchema.parse(contact);
  await adminDb.collection('contacts').doc(contact.hubspotId).set(validated);
}
```

**Note importante** : le champ `legitimateInterest` doit être précisé par Harry avant le go-live. Sans cette info, le contact reste en `status: 'pending'` et ne peut pas être contacté.

## Référence des fichiers du module

```
src/lib/firestore/
├── admin.ts             # Singleton firebase-admin
├── contacts.ts          # CRUD + queries contacts
├── conversations.ts     # CRUD + queries conversations
├── messages.ts          # CRUD messages (sous-collection)
├── audit-log.ts         # Append-only logger
├── prompts.ts           # Gestion versions prompts
├── campaigns.ts         # Gestion campagnes
├── blacklist.ts         # Gestion blacklist
└── transactions.ts      # Helpers pour les opérations atomiques

firestore.rules          # Règles de sécurité
firestore.indexes.json   # Index composites
```

## Tests

Toutes les fonctions de `lib/firestore/` doivent avoir leurs tests dans `tests/unit/firestore/`, utilisant le Firebase Emulator pour ne pas toucher la prod.

```bash
# Lancer l'emulator
firebase emulators:start --only firestore

# Lancer les tests contre l'emulator
FIRESTORE_EMULATOR_HOST=localhost:8080 npm test
```

Cibles de couverture : **90%+ sur `lib/firestore/`**.
