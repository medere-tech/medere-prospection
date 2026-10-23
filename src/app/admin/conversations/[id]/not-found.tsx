/**
 * 404 propre pour `/admin/conversations/[id]` quand la conversation n'existe
 * pas ou n'appartient pas à un contact (VUE-CONVERSATION PR1).
 */
import { SearchX } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function ConversationNotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-5 py-16 text-center">
      <SearchX className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">Conversation introuvable</h1>
        <p className="text-sm text-muted-foreground">
          Cette conversation n&apos;existe pas ou a été supprimée. Vérifiez le lien ou revenez à la
          liste des contacts.
        </p>
      </div>
      <Link href="/admin/contacts">
        <Button variant="outline">Retour au tableau de bord</Button>
      </Link>
    </div>
  );
}
