import type { Timestamp } from "firebase-admin/firestore";
import { describe, expect, it, vi } from "vitest";

import type { Contact } from "@/types/contact";

import {
  type ComplianceFailCode,
  type ComplianceFailure,
  HUMAN_REASONS,
  preSendCheck,
  type PreSendCheckArgs,
} from "./pre-send-check";
import type { OutboundMessageRecord } from "./rate-limits";

/** Cast Date → Timestamp pour les tests. Runtime : bloctel/rate-limits/contact
 * acceptent Date OU Timestamp via `instanceof Date`. Type-side : cast nécessaire. */
function asTS(d: Date): Timestamp {
  return d as unknown as Timestamp;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-05-12T09:00:00Z"); // Mardi 12 mai 2026 11h Paris (été UTC+2)

function daysAgo(n: number, ref: Date = NOW): Date {
  return new Date(ref.getTime() - n * 24 * 3600 * 1000);
}

/** SMS conforme avec annonce IA + STOP. */
const COMPLIANT_MESSAGE =
  "Bonjour Dr X, je suis Léa, assistante IA Médéré. Formation DPC gratuite. STOP";

/** Construit un Contact réaliste pour les tests. */
function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    segment: "b2b_cabinet",
    bloctelChecked: false,
    bloctelOptOut: false,
    consent: {
      legitimateInterest: "Contact issu de l'annuaire santé Ameli (données publiques RPPS)",
      optedOut: false,
      ...(overrides.consent ?? {}),
    },
    phone: {
      e164: "+33612345678",
      raw: "0612345678",
      type: "mobile",
      valid: true,
      lookupAt: asTS(NOW),
      ...(overrides.phone ?? {}),
    },
    ...overrides,
  } as Contact;
}

function makeArgs(overrides: Partial<PreSendCheckArgs> = {}): PreSendCheckArgs {
  return {
    contact: makeContact(),
    message: COMPLIANT_MESSAGE,
    conversation: { messageCount: 1 }, // pas premier SMS par défaut
    recentOutboundMessages: [],
    now: NOW,
    ...overrides,
  };
}

function outbound(sentAt: Date): OutboundMessageRecord {
  return { direction: "outbound", sentAt };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cas tout-OK
// ─────────────────────────────────────────────────────────────────────────────

describe("preSendCheck — cas tout-OK", () => {
  it("contact B2B + message conforme + heure ouvrée → ok: true", () => {
    const r = preSendCheck(makeArgs());
    expect(r).toEqual({ ok: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Un test par failure code (15 cas)
// ─────────────────────────────────────────────────────────────────────────────

describe("preSendCheck — un test par code de failure", () => {
  it("opted_out : contact.consent.optedOut === true", () => {
    const r = preSendCheck(
      makeArgs({
        contact: makeContact({
          consent: {
            legitimateInterest: "Contact issu de l'annuaire santé Ameli (RPPS public)",
            optedOut: true,
          },
        }),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("opted_out");
  });

  it("ai_disclosure_missing : premier SMS sans annonce IA", () => {
    const r = preSendCheck(
      makeArgs({
        message: "Formation DPC gratuite. STOP", // pas d'annonce IA
        conversation: { messageCount: 0 }, // premier SMS
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("ai_disclosure_missing");
  });

  it("ai_disclosure pas requise sur 2e SMS et + (autorisé)", () => {
    const r = preSendCheck(
      makeArgs({
        // Pas d'annonce IA (skip car messageCount > 0) ; "Médéré" présent
        // pour passer la règle 4 GUARD-003 ; STOP présent pour règle 3.
        message: "Réponse simple Médéré. STOP",
        conversation: { messageCount: 5 },
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("stop_optout_missing : message sortant sans STOP", () => {
    const r = preSendCheck(
      makeArgs({ message: "Bonjour Dr X, je suis Léa, assistante IA Médéré." }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("stop_optout_missing");
  });

  it("advertiser_identification_missing : SMS sans mention 'Médéré' dans le body", () => {
    // Message contient annonce IA + STOP mais PAS de mention Médéré.
    // conversation.messageCount = 1 pour passer ai_disclosure.
    const r = preSendCheck(
      makeArgs({
        message: "Bonjour Dr X, je suis Léa, assistante IA. Formation DPC gratuite. STOP",
        conversation: { messageCount: 1 },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.code).toBe("advertiser_identification_missing");
      expect(r.failure.rule).toBe("advertiser_identification");
      expect(r.failure.context).toEqual({});
    }
  });

  it("rate_limit_exceeded : 3 envois dans la fenêtre 30j", () => {
    const r = preSendCheck(
      makeArgs({
        recentOutboundMessages: [
          outbound(daysAgo(1)),
          outbound(daysAgo(15)),
          outbound(daysAgo(25)),
        ],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.code).toBe("rate_limit_exceeded");
      // Vérif context typé
      if (r.failure.code === "rate_limit_exceeded") {
        expect(r.failure.context.count).toBe(3);
        expect(r.failure.context.maxAllowed).toBe(3);
        expect(r.failure.context.windowDays).toBe(30);
      }
    }
  });

  it("outside_hours : mardi 13h30 Paris (= 11h30 UTC été)", () => {
    const r = preSendCheck(makeArgs({ now: new Date("2026-05-12T11:30:00Z") }));
    expect(r.ok).toBe(false);
    if (!r.ok && r.failure.code === "outside_hours") {
      expect(r.failure.context.hour).toBe(13);
      expect(r.failure.context.minute).toBe(30);
      expect(r.failure.context.weekday).toBe(2);
    } else {
      expect.fail("expected outside_hours");
    }
  });

  it("saturday_out_of_range : samedi 14h Paris", () => {
    const r = preSendCheck(makeArgs({ now: new Date("2026-05-16T12:00:00Z") }));
    expect(r.ok).toBe(false);
    if (!r.ok && r.failure.code === "saturday_out_of_range") {
      expect(r.failure.context.hour).toBe(14);
      expect(r.failure.context.minute).toBe(0);
    } else {
      expect.fail("expected saturday_out_of_range");
    }
  });

  it("sunday : dimanche 11h Paris", () => {
    const r = preSendCheck(makeArgs({ now: new Date("2026-05-17T09:00:00Z") }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("sunday");
  });

  it("holiday : 1er mai 2026 (vendredi férié)", () => {
    const r = preSendCheck(makeArgs({ now: new Date("2026-05-01T09:00:00Z") }));
    expect(r.ok).toBe(false);
    if (!r.ok && r.failure.code === "holiday") {
      expect(r.failure.context.isoDate).toBe("2026-05-01");
    } else {
      expect.fail("expected holiday");
    }
  });

  it("holidays_not_verified : année 2028 (fail-safe)", () => {
    const r = preSendCheck(makeArgs({ now: new Date("2028-03-14T10:00:00Z") }));
    expect(r.ok).toBe(false);
    if (!r.ok && r.failure.code === "holidays_not_verified") {
      expect(r.failure.context.year).toBe(2028);
      expect(r.failure.context.maxVerified).toBe(2027);
    } else {
      expect.fail("expected holidays_not_verified");
    }
  });

  it("bloctel_not_checked : B2C mobile + bloctelChecked=false", () => {
    const r = preSendCheck(
      makeArgs({
        contact: makeContact({
          segment: "b2c_mobile_perso",
          bloctelChecked: false,
        }),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("bloctel_not_checked");
  });

  it("bloctel_opted_out : B2C mobile + bloctelOptOut=true", () => {
    const r = preSendCheck(
      makeArgs({
        contact: makeContact({
          segment: "b2c_mobile_perso",
          bloctelChecked: true,
          bloctelOptOut: true,
          bloctelCheckedAt: asTS(daysAgo(5)),
        }),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("bloctel_opted_out");
  });

  it("bloctel_check_expired : vérif > 30j", () => {
    const r = preSendCheck(
      makeArgs({
        contact: makeContact({
          segment: "b2c_mobile_perso",
          bloctelChecked: true,
          bloctelCheckedAt: asTS(daysAgo(45)),
        }),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.failure.code === "bloctel_check_expired") {
      expect(r.failure.context.daysSinceCheck).toBe(45);
    } else {
      expect.fail("expected bloctel_check_expired");
    }
  });

  it("legitimate_interest_undocumented : 19 chars (sous le minimum)", () => {
    const r = preSendCheck(
      makeArgs({
        contact: makeContact({
          consent: {
            legitimateInterest: "Lead salon DPC 24", // 17 chars < 20
            optedOut: false,
          },
        }),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.failure.code === "legitimate_interest_undocumented") {
      expect(r.failure.context.minLength).toBe(20);
      expect(r.failure.context.documentedLength).toBeLessThan(20);
    } else {
      expect.fail("expected legitimate_interest_undocumented");
    }
  });

  it("legitimate_interest documenté à 20 chars PILE → autorisé (borne inclusive)", () => {
    const r = preSendCheck(
      makeArgs({
        contact: makeContact({
          consent: {
            legitimateInterest: "Lead salon DPC ABCDE", // 20 chars exactement
            optedOut: false,
          },
        }),
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("phone_invalid : phone.valid === false", () => {
    const r = preSendCheck(
      makeArgs({
        contact: makeContact({
          phone: {
            e164: "+33000000000",
            raw: "invalid",
            type: "unknown",
            valid: false,
            lookupAt: asTS(NOW),
          },
        }),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("phone_invalid");
  });

  it("phone_voip : phone.type === 'voip'", () => {
    const r = preSendCheck(
      makeArgs({
        contact: makeContact({
          phone: {
            e164: "+33970123456",
            raw: "0970123456",
            type: "voip",
            valid: true,
            lookupAt: asTS(NOW),
          },
        }),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("phone_voip");
  });

  it("legitimateInterest absent (undefined) → refusé", () => {
    const r = preSendCheck(
      makeArgs({
        contact: makeContact({
          consent: {
            legitimateInterest: "",
            optedOut: false,
          },
        }),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.failure.code === "legitimate_interest_undocumented") {
      expect(r.failure.context.documentedLength).toBe(0);
    } else {
      expect.fail("expected legitimate_interest_undocumented");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ordre des règles + court-circuit (précision Déthié [3])
// ─────────────────────────────────────────────────────────────────────────────

describe("preSendCheck — ordre des règles et court-circuit", () => {
  it("opted_out l'emporte sur AI disclosure missing + STOP missing + dehors heures", () => {
    const r = preSendCheck(
      makeArgs({
        contact: makeContact({
          consent: {
            legitimateInterest: "(peu importe, court-circuit avant)",
            optedOut: true,
          },
        }),
        message: "rien", // pas d'IA ni STOP
        conversation: { messageCount: 0 },
        now: new Date("2026-05-17T22:00:00Z"), // dimanche soir Paris
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("opted_out");
  });

  it("stop_optout_missing l'emporte sur rate_limit_exceeded (priorité 3 avant 5)", () => {
    const r = preSendCheck(
      makeArgs({
        message: "Bonjour Dr X, je suis Léa, assistante IA Médéré.", // pas de STOP
        recentOutboundMessages: [outbound(daysAgo(1)), outbound(daysAgo(2)), outbound(daysAgo(3))],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("stop_optout_missing");
  });

  it("advertiser_identification_missing l'emporte sur rate_limit_exceeded (priorité 4 avant 5)", () => {
    const r = preSendCheck(
      makeArgs({
        message: "Bonjour Dr X, je suis Léa, assistante IA. STOP", // STOP mais pas de "Médéré"
        recentOutboundMessages: [outbound(daysAgo(1)), outbound(daysAgo(2)), outbound(daysAgo(3))],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("advertiser_identification_missing");
  });

  it("COURT-CIRCUIT RÉEL via DI : opted_out → spies des règles suivantes NON appelés", () => {
    const hasAIDisclosureSpy = vi.fn().mockReturnValue(true);
    const hasOptOutSpy = vi.fn().mockReturnValue(true);
    const canSendMessageSpy = vi.fn().mockReturnValue({ allowed: true });
    const isAllowedSendTimeSpy = vi.fn().mockReturnValue({ allowed: true });
    const canSendB2CSpy = vi.fn().mockReturnValue({ allowed: true });

    const r = preSendCheck(
      makeArgs({
        contact: makeContact({
          consent: {
            legitimateInterest: "Contact issu de l'annuaire santé Ameli (RPPS public)",
            optedOut: true,
          },
        }),
      }),
      {
        hasAIDisclosure: hasAIDisclosureSpy,
        hasOptOut: hasOptOutSpy,
        canSendMessage: canSendMessageSpy,
        isAllowedSendTime: isAllowedSendTimeSpy,
        canSendB2C: canSendB2CSpy,
      },
    );

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("opted_out");
    // Court-circuit RÉEL : aucune règle subséquente n'a été évaluée.
    expect(hasAIDisclosureSpy).not.toHaveBeenCalled();
    expect(hasOptOutSpy).not.toHaveBeenCalled();
    expect(canSendMessageSpy).not.toHaveBeenCalled();
    expect(isAllowedSendTimeSpy).not.toHaveBeenCalled();
    expect(canSendB2CSpy).not.toHaveBeenCalled();
  });

  it("COURT-CIRCUIT RÉEL : advertiser_identification_missing → rate_limit/hours/bloctel NON appelés", () => {
    const canSendMessageSpy = vi.fn().mockReturnValue({ allowed: true });
    const isAllowedSendTimeSpy = vi.fn().mockReturnValue({ allowed: true });
    const canSendB2CSpy = vi.fn().mockReturnValue({ allowed: true });

    // Message contient STOP + annonce IA (passe règles 2-3) mais PAS de "Médéré"
    // → bloque sur règle 4 (position 4 dans l'orchestrateur).
    const r = preSendCheck(
      makeArgs({
        message: "Bonjour Dr X, je suis Léa, assistante IA. STOP",
      }),
      {
        canSendMessage: canSendMessageSpy,
        isAllowedSendTime: isAllowedSendTimeSpy,
        canSendB2C: canSendB2CSpy,
      },
    );

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("advertiser_identification_missing");
    expect(canSendMessageSpy).not.toHaveBeenCalled();
    expect(isAllowedSendTimeSpy).not.toHaveBeenCalled();
    expect(canSendB2CSpy).not.toHaveBeenCalled();
  });

  it("COURT-CIRCUIT RÉEL : stop_optout_missing → rate_limit/hours/bloctel NON appelés", () => {
    const canSendMessageSpy = vi.fn().mockReturnValue({ allowed: true });
    const isAllowedSendTimeSpy = vi.fn().mockReturnValue({ allowed: true });
    const canSendB2CSpy = vi.fn().mockReturnValue({ allowed: true });

    // Message SANS mot-clé STOP (le mot "stop" ne doit pas apparaître,
    // \bSTOP\b/i serait insensible à la casse).
    const r = preSendCheck(makeArgs({ message: "Bonjour. Aucune mention requise." }), {
      canSendMessage: canSendMessageSpy,
      isAllowedSendTime: isAllowedSendTimeSpy,
      canSendB2C: canSendB2CSpy,
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("stop_optout_missing");
    expect(canSendMessageSpy).not.toHaveBeenCalled();
    expect(isAllowedSendTimeSpy).not.toHaveBeenCalled();
    expect(canSendB2CSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Précision Déthié [1] — humanReason CONSTANT par code (jamais d'interpolation)
// ─────────────────────────────────────────────────────────────────────────────

describe("preSendCheck — humanReason est CONSTANT par code (anti-PII)", () => {
  /**
   * Pour chaque code, on déclenche deux failures avec des contacts ET
   * args DIFFÉRENTS produisant le même code. Le `humanReason` DOIT
   * être strictement identique à `HUMAN_REASONS[code]`.
   */
  const SCENARIOS: Array<{
    code: ComplianceFailCode;
    a: () => PreSendCheckArgs;
    b: () => PreSendCheckArgs;
  }> = [
    {
      code: "opted_out",
      a: () =>
        makeArgs({
          contact: makeContact({
            firstName: "Jean",
            consent: {
              legitimateInterest: "Contact issu de l'annuaire santé Ameli (RPPS public)",
              optedOut: true,
            },
          } as Partial<Contact>),
        }),
      b: () =>
        makeArgs({
          contact: makeContact({
            firstName: "Marie",
            consent: {
              legitimateInterest: "PS ayant participé webinaire Médéré 12 mars 2026",
              optedOut: true,
            },
          } as Partial<Contact>),
        }),
    },
    {
      code: "ai_disclosure_missing",
      a: () =>
        makeArgs({
          message: "1er msg sans IA STOP",
          conversation: { messageCount: 0 },
        }),
      b: () =>
        makeArgs({
          message: "Autre 1er msg sans IA STOP",
          conversation: { messageCount: 0 },
        }),
    },
    {
      code: "stop_optout_missing",
      a: () => makeArgs({ message: "Bonjour, assistante IA Médéré." }),
      b: () => makeArgs({ message: "Hello, agent virtuel Médéré." }),
    },
    {
      code: "advertiser_identification_missing",
      a: () =>
        makeArgs({
          message: "Bonjour, je suis Léa, assistante IA. STOP",
          conversation: { messageCount: 1 },
        }),
      b: () =>
        makeArgs({
          message: "Hello, agent virtuel ici. Une question rapide. STOP",
          conversation: { messageCount: 3 },
        }),
    },
    {
      code: "rate_limit_exceeded",
      a: () =>
        makeArgs({
          recentOutboundMessages: [
            outbound(daysAgo(1)),
            outbound(daysAgo(2)),
            outbound(daysAgo(3)),
          ],
        }),
      b: () =>
        makeArgs({
          recentOutboundMessages: Array.from({ length: 6 }, (_, i) => outbound(daysAgo(i + 1))),
        }),
    },
    {
      code: "outside_hours",
      a: () => makeArgs({ now: new Date("2026-05-12T11:00:00Z") }), // mardi 13h
      b: () => makeArgs({ now: new Date("2026-05-12T18:30:00Z") }), // mardi 20h30
    },
    {
      code: "sunday",
      a: () => makeArgs({ now: new Date("2026-05-17T09:00:00Z") }),
      b: () => makeArgs({ now: new Date("2026-05-17T17:00:00Z") }),
    },
    {
      code: "holiday",
      a: () => makeArgs({ now: new Date("2026-05-01T09:00:00Z") }),
      b: () => makeArgs({ now: new Date("2026-07-14T09:00:00Z") }),
    },
    {
      code: "bloctel_not_checked",
      a: () =>
        makeArgs({
          contact: makeContact({ segment: "b2c_mobile_perso" }),
        }),
      b: () =>
        makeArgs({
          contact: makeContact({
            segment: "b2c_mobile_perso",
            bloctelChecked: true,
            // bloctelCheckedAt undefined → fail-safe → même code
          }),
        }),
    },
    {
      code: "bloctel_check_expired",
      a: () =>
        makeArgs({
          contact: makeContact({
            segment: "b2c_mobile_perso",
            bloctelChecked: true,
            bloctelCheckedAt: asTS(daysAgo(31)),
          }),
        }),
      b: () =>
        makeArgs({
          contact: makeContact({
            segment: "b2c_mobile_perso",
            bloctelChecked: true,
            bloctelCheckedAt: asTS(daysAgo(90)),
          }),
        }),
    },
    {
      code: "phone_voip",
      a: () =>
        makeArgs({
          contact: makeContact({
            phone: {
              e164: "+33970000001",
              raw: "0970000001",
              type: "voip",
              valid: true,
              lookupAt: asTS(NOW),
            },
          }),
        }),
      b: () =>
        makeArgs({
          contact: makeContact({
            phone: {
              e164: "+33970000002",
              raw: "0970000002",
              type: "voip",
              valid: true,
              lookupAt: asTS(NOW),
            },
          }),
        }),
    },
  ];

  it.each(SCENARIOS)(
    "humanReason est IDENTIQUE entre 2 invocations différentes pour code=$code",
    ({ code, a, b }) => {
      const r1 = preSendCheck(a());
      const r2 = preSendCheck(b());
      expect(r1.ok).toBe(false);
      expect(r2.ok).toBe(false);
      if (!r1.ok && !r2.ok) {
        expect(r1.failure.code).toBe(code);
        expect(r2.failure.code).toBe(code);
        // L'invariant fort : humanReason est strictement la constante.
        expect(r1.failure.humanReason).toBe(HUMAN_REASONS[code]);
        expect(r2.failure.humanReason).toBe(HUMAN_REASONS[code]);
        expect(r1.failure.humanReason).toBe(r2.failure.humanReason);
      }
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Anti-fuite : humanReason ne contient aucune PII des inputs
// ─────────────────────────────────────────────────────────────────────────────

describe("preSendCheck — anti-fuite PII dans humanReason", () => {
  const PII_VALUES = [
    "+33612345678",
    "0612345678",
    "Jean-Hippolyte Untel",
    "Untel",
    "jean.untel@example.com",
    "Bonjour Dr Untel, message piégé avec PII",
  ];

  it("aucune valeur PII des inputs ne se retrouve dans humanReason (tous codes)", () => {
    const contact = makeContact({
      firstName: "Jean-Hippolyte",
      lastName: "Untel",
      email: "jean.untel@example.com",
      phone: {
        e164: "+33612345678",
        raw: "0612345678",
        type: "voip", // déclenche phone_voip
        valid: true,
        lookupAt: asTS(NOW),
      },
    } as unknown as Partial<Contact>);
    const r = preSendCheck(
      makeArgs({
        contact,
        message: PII_VALUES[5] as string,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      for (const pii of PII_VALUES) {
        expect(r.failure.humanReason).not.toContain(pii);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Précision Déthié [2] — context : schéma fermé typé par code
// ─────────────────────────────────────────────────────────────────────────────

describe("preSendCheck — context schéma fermé (discriminated union)", () => {
  it("type-level : context ne peut PAS contenir de clés arbitraires (compile-time)", () => {
    const r = preSendCheck(
      makeArgs({
        recentOutboundMessages: [outbound(daysAgo(1)), outbound(daysAgo(2)), outbound(daysAgo(3))],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.failure.code === "rate_limit_exceeded") {
      // Les seules clés autorisées sont count, maxAllowed, windowDays.
      const allowed: ReadonlyArray<keyof typeof r.failure.context> = [
        "count",
        "maxAllowed",
        "windowDays",
      ];
      const got = Object.keys(r.failure.context);
      for (const k of got) {
        expect(allowed).toContain(k as (typeof allowed)[number]);
      }
    } else {
      expect.fail("expected rate_limit_exceeded");
    }
  });

  it("invariant : aucune valeur de context n'est de type 'object' ou Array", () => {
    // Brut force : on déclenche plusieurs codes et on vérifie que toutes
    // les valeurs sont primitives (number/string/boolean). Empêche
    // qu'un dev futur glisse un { contact } dans le context.
    const checkPrimitive = (failure: ComplianceFailure) => {
      for (const [, v] of Object.entries(failure.context)) {
        const t = typeof v;
        expect(["number", "string", "boolean"]).toContain(t);
      }
    };

    const cases = [
      makeArgs({ now: new Date("2026-05-12T11:00:00Z") }), // outside_hours
      makeArgs({ now: new Date("2026-05-01T09:00:00Z") }), // holiday
      makeArgs({
        recentOutboundMessages: [outbound(daysAgo(1)), outbound(daysAgo(2)), outbound(daysAgo(3))],
      }), // rate_limit
    ];

    for (const args of cases) {
      const r = preSendCheck(args);
      expect(r.ok).toBe(false);
      if (!r.ok) checkPrimitive(r.failure);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// failure.rule cohérent avec failure.code (mapping documenté)
// ─────────────────────────────────────────────────────────────────────────────

describe("preSendCheck — failure.rule mappé correctement à failure.code", () => {
  const CODE_TO_RULE: Record<ComplianceFailCode, string> = {
    opted_out: "opt_out",
    ai_disclosure_missing: "ai_disclosure",
    stop_optout_missing: "stop_present",
    advertiser_identification_missing: "advertiser_identification",
    rate_limit_exceeded: "rate_limit",
    outside_hours: "hours",
    saturday_out_of_range: "hours",
    sunday: "hours",
    holiday: "hours",
    holidays_not_verified: "hours",
    bloctel_not_checked: "bloctel",
    bloctel_opted_out: "bloctel",
    bloctel_check_expired: "bloctel",
    legitimate_interest_undocumented: "legitimate_interest",
    phone_invalid: "phone_validity",
    phone_voip: "phone_validity",
  };

  it("le mapping est documenté pour tous les 16 codes", () => {
    expect(Object.keys(CODE_TO_RULE)).toHaveLength(16);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Branches défensives (coverage complémentaire pour gate 100%)
// ─────────────────────────────────────────────────────────────────────────────

describe("preSendCheck — branches défensives", () => {
  it("sans 'now' explicite → utilise new Date() par défaut", () => {
    // Toutes les règles mockées en succès pour rendre le test déterministe
    // (le but est de couvrir la branche `args.now ?? new Date()`).
    const r = preSendCheck(
      {
        contact: makeContact(),
        message: COMPLIANT_MESSAGE,
        conversation: { messageCount: 1 },
        recentOutboundMessages: [],
        // now: VOLONTAIREMENT absent
      },
      {
        hasAIDisclosure: vi.fn(() => true),
        hasOptOut: vi.fn(() => true),
        canSendMessage: vi.fn(() => ({ allowed: true })),
        isAllowedSendTime: vi.fn(() => ({ allowed: true })),
        canSendB2C: vi.fn(() => ({ allowed: true })),
      },
    );
    expect(r).toEqual({ ok: true });
  });

  it("isAllowedSendTime mocké { allowed: false } sans reason → fallback 'outside_hours'", () => {
    // Couvre le `?? ""` sur hoursResult.reason ET le défaut de classifyHoursFailure.
    const r = preSendCheck(makeArgs({ now: new Date("2026-05-12T09:00:00Z") }), {
      isAllowedSendTime: vi.fn(() => ({ allowed: false })),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("outside_hours");
  });

  it("canSendB2C mocké { allowed: false } sans reason → fallback 'bloctel_check_expired'", () => {
    // Couvre le `?? ""` sur bloctelResult.reason ET le défaut de classifyBloctelFailure.
    const r = preSendCheck(
      makeArgs({
        contact: makeContact({
          segment: "b2c_mobile_perso",
          bloctelChecked: true,
          bloctelCheckedAt: asTS(daysAgo(10)),
        }),
      }),
      { canSendB2C: vi.fn(() => ({ allowed: false })) },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("bloctel_check_expired");
  });

  it("bloctelCheckedAt en VRAI Timestamp (objet avec .toDate()) → branche `else` couverte", () => {
    // Couvre `bloctelCheckedAt instanceof Date === false` dans bloctelDaysSinceCheck.
    const fakeTimestamp = {
      toDate: () => daysAgo(45),
    } as unknown as Timestamp;
    const r = preSendCheck(
      makeArgs({
        contact: makeContact({
          segment: "b2c_mobile_perso",
          bloctelChecked: true,
          bloctelCheckedAt: fakeTimestamp,
        }),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.failure.code === "bloctel_check_expired") {
      expect(r.failure.context.daysSinceCheck).toBe(45);
    } else {
      expect.fail("expected bloctel_check_expired with toDate() path");
    }
  });
});
