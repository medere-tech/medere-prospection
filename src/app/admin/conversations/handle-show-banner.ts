/**
 * Handler du clic « Afficher » du bandeau "Nouvelles conversations"
 * (PR2b-2 P3 — extrait pour testabilité).
 *
 * Dette fermée : "handleShowBannerClick oublie `watch.acknowledge()`"
 * → ce handler est maintenant une fonction pure testable, et le test
 * de mutation (`acknowledge` manquant) le fait tomber immédiatement.
 */

export interface HandleShowBannerDeps {
  /** nuqs setter du cursor de pagination. */
  readonly setCursor: (v: string | null) => void;
  /** Incrémente le refreshKey → relance les useEffect de fetch. */
  readonly setRefreshKey: (updater: (k: number) => number) => void;
  /** Setter du state du bandeau. */
  readonly setBanner: (next: { visible: boolean; delta: number | null }) => void;
  /** Reset du compteur de référence (baseline) côté caller. */
  readonly resetBaseline: () => void;
  /** `useListVersionWatch.acknowledge` — remet la baseline interne du
   *  hook sur la version courante. Sans ça, `hasUpdate` reste à `true`
   *  et le bandeau réapparaît immédiatement au prochain tick. */
  readonly acknowledge: () => void;
}

export function handleShowBanner(deps: HandleShowBannerDeps): void {
  deps.setCursor(null);
  deps.setRefreshKey((k) => k + 1);
  deps.setBanner({ visible: false, delta: null });
  deps.resetBaseline();
  deps.acknowledge();
}
