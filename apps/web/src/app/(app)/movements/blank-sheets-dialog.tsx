"use client";

/** Pre-numbered blank driver sheets for a trip range, as a PDF batch. */
import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button, Input, Label, NativeSelect } from "@corridor/ui";
import { useTRPC } from "@/lib/trpc/client";

export function BlankSheetsDialog() {
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<{ url: string; pages: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generate = useMutation(
    trpc.pdf.blankDriverSheets.mutationOptions({
      onSuccess: (doc, vars) => {
        setError(null);
        setResult({ url: doc.signedUrl, pages: vars.toTrip - vars.fromTrip + 1 });
      },
      onError: (e) => setError(e.message),
    }),
  );

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Blank driver sheets
      </Button>
      {open && (
        <div className="fixed inset-0 z-40 flex items-start justify-center bg-ink-950/40 pt-24" onClick={() => setOpen(false)}>
          <form
            role="dialog"
            aria-label="Blank driver sheets"
            className="panel w-full max-w-md space-y-4 p-6"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e: FormEvent<HTMLFormElement>) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              generate.mutate({
                regime: (fd.get("regime") as "ACE" | "ACI") ?? "ACE",
                prefix: String(fd.get("prefix") ?? "TRIP-"),
                fromTrip: Number(fd.get("fromTrip")),
                toTrip: Number(fd.get("toTrip")),
                driverName: String(fd.get("driverName") ?? "").trim() || null,
                coDriverName: String(fd.get("coDriverName") ?? "").trim() || null,
              });
            }}
          >
            <div>
              <h2 className="text-lg font-semibold">Blank driver sheets</h2>
              <p className="text-sm text-ink-500">One pre-numbered page per trip, up to 50 at a time.</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="bs-regime">Regime</Label>
                <NativeSelect id="bs-regime" name="regime" defaultValue="ACE">
                  <option value="ACE">ACE (US-bound)</option>
                  <option value="ACI">ACI (Canada-bound)</option>
                </NativeSelect>
              </div>
              <div>
                <Label htmlFor="bs-prefix">Trip prefix</Label>
                <Input id="bs-prefix" name="prefix" defaultValue="TRIP-" className="font-mono" />
              </div>
              <div>
                <Label htmlFor="bs-from">From trip #</Label>
                <Input id="bs-from" name="fromTrip" type="number" min={0} required defaultValue={1001} className="font-mono" />
              </div>
              <div>
                <Label htmlFor="bs-to">To trip #</Label>
                <Input id="bs-to" name="toTrip" type="number" min={0} required defaultValue={1005} className="font-mono" />
              </div>
              <div>
                <Label htmlFor="bs-driver">Driver (optional)</Label>
                <Input id="bs-driver" name="driverName" />
              </div>
              <div>
                <Label htmlFor="bs-codriver">Co-driver (optional)</Label>
                <Input id="bs-codriver" name="coDriverName" />
              </div>
            </div>
            {error && <p className="text-sm text-danger-500">{error}</p>}
            {result && (
              <p className="text-sm text-ok-500">
                {result.pages} sheet{result.pages === 1 ? "" : "s"} ready:{" "}
                <a href={result.url} target="_blank" rel="noopener" className="underline">
                  open PDF
                </a>
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Close
              </Button>
              <Button type="submit" disabled={generate.isPending}>
                {generate.isPending ? "Rendering…" : "Generate PDF"}
              </Button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
