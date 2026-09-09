"use client";

/** Pre-numbered blank driver sheets for a trip range, as a PDF batch. */
import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  NativeSelect,
} from "@corridor/ui";
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
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary">Blank driver sheets</Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <form
          className="space-y-4"
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
          <DialogHeader>
            <DialogTitle>Blank driver sheets</DialogTitle>
            <DialogDescription>
              One pre-numbered page per trip, up to 50 at a time.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
              <Input
                id="bs-from"
                name="fromTrip"
                type="number"
                min={0}
                required
                defaultValue={1001}
                className="font-mono"
              />
            </div>
            <div>
              <Label htmlFor="bs-to">To trip #</Label>
              <Input
                id="bs-to"
                name="toTrip"
                type="number"
                min={0}
                required
                defaultValue={1005}
                className="font-mono"
              />
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
          {error && <p className="text-sm text-status-danger">{error}</p>}
          {result && (
            <p className="text-sm text-status-ok">
              {result.pages} sheet{result.pages === 1 ? "" : "s"} ready:{" "}
              <a href={result.url} target="_blank" rel="noopener" className="underline">
                open PDF
              </a>
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button type="submit" disabled={generate.isPending}>
              {generate.isPending ? "Rendering…" : "Generate PDF"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
