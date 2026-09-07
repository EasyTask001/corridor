import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { ReportWorkbench } from "./report-workbench";

export const metadata: Metadata = { title: "Reports" };

export default async function ReportsPage() {
  const session = await getSession();
  if (!session?.permissions.has("report.read") || !session.permissions.has("movement.read")) {
    redirect("/dashboard");
  }
  return <ReportWorkbench />;
}
