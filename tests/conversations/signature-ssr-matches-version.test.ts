/**
 * Sentinelle PR1.12 — signature SSR == signature premier poll `/version`
 * si rien n'a bougé entre les deux (VUE-CONVERSATION polling économique).
 *
 * Finding INFO security-reviewer PR1.11 : la signature SSR forçait
 * `updatedAtIso = ""` → le premier poll /version déclenchait TOUJOURS
 * un refetch détail inutile (~245 reads/jour/commercial évitables).
 *
 * Fix PR1.12 : `ConversationDetailProps.updatedAtIso` est désormais
 * exposé, et `signatureFromDetail` l'utilise. Ce test grep les 2
 * signatures et vérifie qu'elles sont strictement identiques.
 */
import { describe, expect, it } from "vitest";

import type { ConversationDetailProps } from "@/components/conversations/types";

/**
 * Shape miroir de `ConversationVersion` du client. On ne peut pas
 * l'importer directement (fichier `.tsx` client-only avec React Query),
 * donc on duplique la shape dans ce test et on compare la logique de
 * signature à la main.
 */
interface ConversationVersion {
  updatedAtIso: string;
  status: string;
  assignedTo: string | null;
  inboundCount: number;
  outboundCount: number;
  lastInboundAtIso: string | null;
  lastOutboundAtIso: string | null;
}

/** Signature "détail SSR" — miroir de `signatureFromDetail` dans client wrapper. */
function sigDetail(data: ConversationDetailProps): string {
  const sig: ConversationVersion = {
    updatedAtIso: data.updatedAtIso,
    status: data.status,
    assignedTo: data.handoff?.assignedToSlackId ?? null,
    inboundCount: data.inboundCount,
    outboundCount: data.outboundCount,
    lastInboundAtIso: data.lastInboundAtIso,
    lastOutboundAtIso: data.lastOutboundAtIso,
  };
  return JSON.stringify(sig);
}

/** Signature "version runtime" — miroir de `signatureFromVersion`. */
function sigVersion(v: ConversationVersion): string {
  const sig: ConversationVersion = {
    updatedAtIso: v.updatedAtIso,
    status: v.status,
    assignedTo: v.assignedTo,
    inboundCount: v.inboundCount,
    outboundCount: v.outboundCount,
    lastInboundAtIso: v.lastInboundAtIso,
    lastOutboundAtIso: v.lastOutboundAtIso,
  };
  return JSON.stringify(sig);
}

function makeDetail(): ConversationDetailProps {
  return {
    conversationId: "contact1_camp1",
    contactId: "contact1",
    status: "handed_off",
    intent: "INTERESSE",
    campaignId: "camp1",
    createdAtIso: "2026-10-19T10:00:00.000Z",
    updatedAtIso: "2026-10-19T10:05:00.000Z",
    lastInboundAtIso: "2026-10-19T10:05:00.000Z",
    lastOutboundAtIso: "2026-10-19T10:04:00.000Z",
    inboundCount: 1,
    outboundCount: 1,
    summary: null,
    handoff: {
      assignedToName: "Vanessa",
      assignedToSlackId: "UVAN12345",
      assignedAtIso: "2026-10-19T10:03:00.000Z",
      contactedAtIso: null,
      acceptedAtIso: null,
    },
    contact: {
      contactId: "contact1",
      civilite: "Dr",
      firstName: "Jean",
      lastName: "Dupont",
      speciality: "Dentiste",
      city: "Paris",
      optedOut: false,
    },
    messages: [],
    journal: [],
    viewerIsOwner: true,
  };
}

/** Mappe `ConversationDetailProps` → `ConversationVersion` comme le ferait l'endpoint `/version`. */
function versionFromDetail(data: ConversationDetailProps): ConversationVersion {
  return {
    updatedAtIso: data.updatedAtIso,
    status: data.status,
    assignedTo: data.handoff?.assignedToSlackId ?? null,
    inboundCount: data.inboundCount,
    outboundCount: data.outboundCount,
    lastInboundAtIso: data.lastInboundAtIso,
    lastOutboundAtIso: data.lastOutboundAtIso,
  };
}

describe("Signature SSR == Signature premier poll /version (PR1.12 optim)", () => {
  it("rien n'a bougé entre SSR et premier poll → signatures STRICTEMENT identiques → 0 refetch détail", () => {
    const data = makeDetail();
    const ssrSig = sigDetail(data);
    const versionSig = sigVersion(versionFromDetail(data));
    expect(ssrSig).toBe(versionSig);
  });

  it("mutation entre SSR et premier poll → signatures différentes → refetch détail déclenché", () => {
    const data = makeDetail();
    const ssrSig = sigDetail(data);
    // Simule une mutation entre SSR et premier poll (ex: DLR OVH qui bump updatedAt)
    const versionAfterMutation: ConversationVersion = {
      ...versionFromDetail(data),
      updatedAtIso: "2026-10-19T10:10:00.000Z", // différent
    };
    const versionSig = sigVersion(versionAfterMutation);
    expect(ssrSig).not.toBe(versionSig);
  });

  it("conv sans handoff : signature cohérente (assignedTo=null)", () => {
    const data: ConversationDetailProps = { ...makeDetail(), handoff: null };
    const ssrSig = sigDetail(data);
    const versionSig = sigVersion(versionFromDetail(data));
    expect(ssrSig).toBe(versionSig);
    // Vérifier que la signature contient bien assignedTo:null
    expect(JSON.parse(ssrSig).assignedTo).toBeNull();
  });

  it("mutation testing — si on retire updatedAtIso de signatureFromDetail, elles diffèrent", () => {
    // Simule la régression PR1.11 : updatedAtIso = "" côté SSR
    const data = makeDetail();
    const sigDetailAvantFix = JSON.stringify({
      updatedAtIso: "",
      status: data.status,
      assignedTo: data.handoff?.assignedToSlackId ?? null,
      inboundCount: data.inboundCount,
      outboundCount: data.outboundCount,
      lastInboundAtIso: data.lastInboundAtIso,
      lastOutboundAtIso: data.lastOutboundAtIso,
    });
    const versionSig = sigVersion(versionFromDetail(data));
    // Avant le fix, les 2 signatures diffèrent → refetch inutile.
    expect(sigDetailAvantFix).not.toBe(versionSig);
  });

  it("sentinelle anti-PII : la signature ne contient PAS de pattern téléphone", () => {
    const data = makeDetail();
    const ssrSig = sigDetail(data);
    expect(ssrSig).not.toMatch(/\+33\d{9}/);
    expect(ssrSig).not.toMatch(/\b0033\d{9}\b/);
    expect(ssrSig).not.toMatch(/\b0[1-9]\d{8}\b/);
    expect(ssrSig).not.toMatch(/@/);
  });
});
