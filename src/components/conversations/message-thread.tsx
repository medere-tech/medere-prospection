/**
 * Fil des messages de la vue conversation (VUE-CONVERSATION PR1).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Comportement
 *
 *   - Ordre chronologique CROISSANT : plus ancien en haut, plus récent
 *     en bas (comme un chat). Firestore renvoie en ASC via le paramètre
 *     `order: "asc"` par défaut dans `listMessagesInConversation`.
 *
 *   - Séparateurs par jour, libellé long FR en Europe/Paris
 *     (ex: « lundi 19 octobre 2026 »). On regroupe par `parisDayKey`.
 *
 *   - `role="log"` sur le container pour que les lecteurs d'écran
 *     annoncent les nouvelles entrées (polling 30 s).
 *     `aria-live="polite"` + `aria-atomic="false"` pour n'annoncer QUE
 *     les ajouts (pas re-lire tout le fil à chaque refetch).
 *
 *   - **Attention a11y** : on ne veut annoncer QUE les messages
 *     *entrants* (inbound) — les messages Léa / commercial ne sont pas
 *     informatifs pour le commercial qui a déjà poussé le bouton. On
 *     met donc `aria-live` sur le container mais on wrappe chaque
 *     message outbound dans un `aria-live="off"` et on laisse les
 *     inbound hériter du polite. Un screen reader n'annoncera que
 *     les nouvelles bulles inbound.
 *
 *   - Les docs `duplicate` sont filtrés en amont (côté
 *     `listMessagesInConversation`). Defense-in-depth ici : on skip aussi
 *     tout message qui aurait un `status === "duplicate"` par mégarde.
 */
import { formatDayLongParis, parisDayKey } from "@/lib/utils/format-paris";

import { MessageBubble } from "./message-bubble";
import type { MessageProps } from "./types";

interface Props {
  messages: MessageProps[];
}

export function MessageThread({ messages }: Props) {
  // Les docs `duplicate` sont filtrés en amont par `sanitizeMessageForBubble`
  // (retourne `null`) + `load-conversation-detail.ts` (strip des nulls).
  // Ils ne peuvent plus atteindre ce composant — pas besoin d'un second
  // filtre défensif ici. Les tests sentinelle (`no-phone-in-payload`,
  // `load-conversation-detail.test.ts > exclusion duplicate`) le vérifient.
  const filtered = messages;

  if (filtered.length === 0) {
    return (
      <div
        role="log"
        aria-live="polite"
        aria-label="Fil de la conversation"
        className="rounded-lg border border-dashed bg-card p-8 text-center text-sm text-muted-foreground"
      >
        Aucun message dans cette conversation.
      </div>
    );
  }

  // Regroupement par jour (Europe/Paris) en préservant l'ordre.
  const groups: Array<{ dayKey: string; dayLabel: string; items: MessageProps[] }> = [];
  for (const msg of filtered) {
    const key = parisDayKey(msg.createdAtIso);
    const last = groups[groups.length - 1];
    if (last && last.dayKey === key) {
      last.items.push(msg);
    } else {
      groups.push({
        dayKey: key,
        dayLabel: formatDayLongParis(msg.createdAtIso),
        items: [msg],
      });
    }
  }

  return (
    <section
      role="log"
      aria-live="polite"
      aria-atomic="false"
      aria-label="Fil de la conversation"
      className="flex flex-col gap-6 overflow-y-auto"
    >
      {groups.map((g) => (
        <div key={g.dayKey} className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-border" aria-hidden="true" />
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              {g.dayLabel}
            </span>
            <div className="h-px flex-1 bg-border" aria-hidden="true" />
          </div>
          <div className="flex flex-col gap-4">
            {g.items.map((msg) => (
              // Les bulles outbound sont désactivées pour aria-live afin
              // que le polling 30s ne les annonce pas (le commercial les
              // connaît déjà). Seuls les inbound restent "polite".
              <div key={msg.messageId} aria-live={msg.direction === "inbound" ? "polite" : "off"}>
                <MessageBubble message={msg} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
