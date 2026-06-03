/**
 * Déclarations TypeScript pour `@ovhcloud/node-ovh` v3.0.0 (S7a.3).
 *
 * Le package livre du JavaScript ES5 sans `.d.ts` natif → TS7016 sans
 * déclaration. On déclare ICI la surface MINIMALE utilisée par
 * `src/lib/ovh/client.ts` :
 *
 *   - `default export ovhApi(options): OvhSdkClient`
 *   - `OvhSdkClient.requestPromised(method, path, params?): Promise<unknown>`
 *
 * Toute autre méthode du SDK (`request()` legacy callback, `signRequest()`,
 * etc.) reste non-typée par design — si on en a besoin un jour, on l'ajoute
 * ici. Ça évite la tentation d'utiliser des helpers SDK non revus.
 *
 * Pourquoi `Promise<unknown>` et pas `Promise<any>` : on force le caller à
 * narrower via Zod safeParse (cf. `send-sms.ts::OvhSmsResponseSchema`) au
 * lieu de propager `any` dans tout le wrapper. Cohérent avec CLAUDE.md
 * "Pas de `any`" + "Tous les inputs externes validés via Zod".
 *
 * Conventions de nommage des champs reflètent l'API runtime du SDK (camelCase
 * pour `appKey`/`appSecret`/`consumerKey`, kebab-case pour `endpoint`).
 */

declare module "@ovhcloud/node-ovh" {
  /**
   * Endpoints OVH supportés par le SDK v3. Reflet exact de l'enum
   * `OVH_ENDPOINT` validé en S2 (`anthropicEnvSchema.OVH_ENDPOINTS`).
   */
  export type OvhEndpoint =
    | "ovh-eu"
    | "ovh-ca"
    | "ovh-us"
    | "soyoustart-eu"
    | "soyoustart-ca"
    | "kimsufi-eu"
    | "kimsufi-ca"
    | "runabove-ca";

  export interface OvhClientOptions {
    endpoint: OvhEndpoint;
    appKey: string;
    appSecret: string;
    consumerKey?: string | null;
    timeout?: number;
  }

  /**
   * Instance SDK retournée par `ovhApi(options)`. Surface minimale —
   * uniquement `requestPromised` qui est la seule méthode utilisée par
   * `src/lib/ovh/`.
   */
  export interface OvhSdkClient {
    requestPromised(httpMethod: string, path: string, params?: unknown): Promise<unknown>;
  }

  /**
   * Factory du SDK — usage : `ovhApi({ endpoint, appKey, ... })`.
   */
  export default function ovhApi(options: OvhClientOptions): OvhSdkClient;
}
