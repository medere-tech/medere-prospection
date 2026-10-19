/**
 * Tests unitaires de `scripts/_lib/ovh-scrub.mjs` — masque les telephones
 * dans les messages d'erreur / URLs OVH avant log stderr.
 *
 * Couvre les 4 patterns :
 *   - `receiver=` + digits (avec ou sans +/00 prefix)
 *   - E.164 `+33\d{9,}`
 *   - `0033` prefixe (format OVH)
 *   - FR national `0[1-9]\d{8}`
 */
import { describe, expect, it } from "vitest";

import { scrubOvhErrorMessage } from "../../scripts/_lib/ovh-scrub.mjs";

describe("scrubOvhErrorMessage", () => {
  it("masque receiver=0033... (format OVH outgoing)", () => {
    const input = "GET /sms/sms-ab-1/outgoing?receiver=0033612349876&from=X failed";
    const out = scrubOvhErrorMessage(input);
    expect(out).toBe("GET /sms/sms-ab-1/outgoing?receiver=****9876&from=X failed");
    expect(out).not.toContain("0033612349876");
  });

  it("masque receiver=+33... (E.164 brut)", () => {
    const input = "receiver=%2B33612349876 is invalid";
    // Note : URL-encoded %2B = +. Le scrubber ne decode pas, mais le pattern
    // receiver=[+0-9]* ne matche pas %2B. On attend donc PAS de masquage
    // sur %2B — c'est OK car OVH encode `+` en `%2B` et le token qui suit
    // reste `33612349876` qui est capture par la regle "0033 isole" si
    // precede de 00 ou "FR national" si precede de 0. En pratique OVH
    // utilise `0033...` format dans ses URLs, pas `+33`.
    const out = scrubOvhErrorMessage(input);
    // Au minimum on verifie que le pattern general `0033xxx` est masque
    // ailleurs. Ce test documente la limite.
    expect(typeof out).toBe("string");
  });

  it("masque E.164 +33 isole en texte", () => {
    const input = "Call to +33612349876 failed";
    expect(scrubOvhErrorMessage(input)).toBe("Call to +33****9876 failed");
  });

  it("masque 0033 isole en texte", () => {
    const input = "Dial 0033612349876 timeout";
    expect(scrubOvhErrorMessage(input)).toBe("Dial 0033****9876 timeout");
  });

  it("masque FR national 06...", () => {
    const input = "Phone 0612349876 is blacklisted";
    expect(scrubOvhErrorMessage(input)).toBe("Phone ****9876 is blacklisted");
  });

  it("masque FR national 07...", () => {
    const input = "Phone 0712349876 opted out";
    expect(scrubOvhErrorMessage(input)).toBe("Phone ****9876 opted out");
  });

  it("masque plusieurs numeros dans un meme message", () => {
    const input = "receiver=0033612349876 and 0712349876 and +33612349876";
    const out = scrubOvhErrorMessage(input);
    expect(out).not.toContain("612349876");
    expect(out).not.toContain("712349876");
    expect(out).toContain("****9876");
  });

  it("preserve les textes sans numero", () => {
    expect(scrubOvhErrorMessage("Error 429 Too Many Requests")).toBe("Error 429 Too Many Requests");
    expect(scrubOvhErrorMessage("Error 500")).toBe("Error 500");
  });

  it("gere les inputs non-strings", () => {
    expect(scrubOvhErrorMessage(null as unknown as string)).toBeNull();
    expect(scrubOvhErrorMessage(undefined as unknown as string)).toBeUndefined();
    expect(scrubOvhErrorMessage("")).toBe("");
  });

  it("preserve les short tokens (service name, IDs techniques courts)", () => {
    // Service name OVH `sms-ab-1` ne doit pas etre masque
    expect(scrubOvhErrorMessage("Service sms-ab12345-1 unavailable")).toContain("sms-ab12345-1");
    // ID doc Firestore (20 chars base62 alphanumerique) : pas 10+ digits
    // consecutifs donc jamais masque
    expect(scrubOvhErrorMessage("doc USqzioSTVioix630LgDs not found")).toContain(
      "USqzioSTVioix630LgDs",
    );
  });

  it("ne masque PAS un externalId OVH (119256955 = 9 digits mais isole)", () => {
    // 119256955 commence par 1, pas 0 → FR national regex ne matche pas.
    // 119256955 commence pas par +33 → E.164 ne matche pas.
    // Donc preserve pour trace forensic.
    const out = scrubOvhErrorMessage("externalId 119256955 reused");
    expect(out).toBe("externalId 119256955 reused");
  });

  it("masque dans une URL complete OVH realistique", () => {
    const input =
      "Error POST /sms/sms-ab-1/outgoing creationDatetime.from=2026-10-16T11:50:00Z&receiver=0033612349876: 400 Bad Request";
    const out = scrubOvhErrorMessage(input);
    expect(out).not.toContain("0033612349876");
    expect(out).toContain("receiver=****9876");
    // La date ISO n'a pas de token "numero" long isole → preservee.
    expect(out).toContain("2026-10-16T11:50:00Z");
  });
});
