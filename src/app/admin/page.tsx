/**
 * `/admin` → redirect vers `/admin/contacts` (page principale MVP S10.1).
 *
 * Quand on aura une vraie page "Vue d'ensemble KPI" (S11+), on remplacera
 * ce redirect par un dashboard.
 */
import { redirect } from "next/navigation";

export default function AdminIndexPage() {
  redirect("/admin/contacts");
}
