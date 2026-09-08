import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@corridor/ui";
import { getSession } from "@/lib/session";
import { CrossingReport } from "./crossing-report";
import { ReportWorkbench } from "./report-workbench";

export const metadata: Metadata = { title: "Reports" };

export default async function ReportsPage() {
  const session = await getSession();
  if (!session?.permissions.has("report.read") || !session.permissions.has("movement.read")) {
    redirect("/dashboard");
  }
  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
        <p className="text-sm text-ink-500">
          The crossing log with the columns you need, or a question about volume, cargo and
          customs outcomes.
        </p>
      </header>
      <Tabs defaultValue="crossings">
        <TabsList>
          <TabsTrigger value="crossings">Crossing report</TabsTrigger>
          <TabsTrigger value="question">Ask a question</TabsTrigger>
        </TabsList>
        <TabsContent value="crossings">
          <CrossingReport />
        </TabsContent>
        <TabsContent value="question">
          <ReportWorkbench />
        </TabsContent>
      </Tabs>
    </div>
  );
}
