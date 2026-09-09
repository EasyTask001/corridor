"use client";

/**
 * The "Travel documents" tab of the driver registry drawer — the passport /
 * FAST / NEXUS / visa rows CBP and CBSA want on the crew list.
 *
 * Deliberately form-less: it renders inside the registry drawer's own <form>,
 * so every control here is a button, never a nested submit.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DRIVER_DOCUMENT_LABELS,
  DRIVER_DOCUMENT_TYPES,
  type DriverDocumentType,
} from "@corridor/domain";
import { Button, Input, Label, NativeSelect } from "@corridor/ui";
import { useTRPC } from "@/lib/trpc/client";
import { ExpiryChip } from "./registry-page";

type Draft = {
  id?: string;
  documentType: DriverDocumentType;
  documentNumber: string;
  issuingCountry: string;
  issuingState: string;
  issuedOn: string;
  expiresOn: string;
  isPrimary: boolean;
};

const emptyDraft: Draft = {
  documentType: "passport",
  documentNumber: "",
  issuingCountry: "",
  issuingState: "",
  issuedOn: "",
  expiresOn: "",
  isPrimary: false,
};

export function DriverDocumentsPanel({
  driverId,
  canWrite,
}: {
  driverId: string;
  canWrite: boolean;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const listOpts = trpc.party.drivers.documents.list.queryOptions({ driverId });
  const { data, isLoading } = useQuery(listOpts);

  const settle = {
    onSuccess: () => {
      setDraft(null);
      setError(null);
      qc.invalidateQueries({ queryKey: listOpts.queryKey });
      qc.invalidateQueries({ queryKey: trpc.alerts.list.queryKey() });
      qc.invalidateQueries({ queryKey: trpc.alerts.summary.queryKey() });
    },
    onError: (e: { message: string }) => setError(e.message),
  };
  const upsert = useMutation(trpc.party.drivers.documents.upsert.mutationOptions(settle));
  const remove = useMutation(trpc.party.drivers.documents.remove.mutationOptions(settle));

  const save = () => {
    if (!draft) return;
    upsert.mutate({
      driverId,
      id: draft.id,
      documentType: draft.documentType,
      documentNumber: draft.documentNumber,
      issuingCountry: draft.issuingCountry || null,
      issuingState: draft.issuingState || null,
      issuedOn: draft.issuedOn || null,
      expiresOn: draft.expiresOn || null,
      isPrimary: draft.isPrimary,
    });
  };

  return (
    <div className="space-y-4">
      <table className="w-full text-sm">
        <thead className="bg-surface-sunken text-left text-xs uppercase tracking-wide text-fg-secondary">
          <tr>
            <th className="px-2 py-2 font-medium">Document</th>
            <th className="px-2 py-2 font-medium">Number</th>
            <th className="px-2 py-2 font-medium">Expires</th>
            <th />
          </tr>
        </thead>
        <tbody className="divide-y divide-border-default">
          {isLoading && (
            <tr>
              <td colSpan={4} className="px-2 py-4 text-fg-secondary">
                Loading…
              </td>
            </tr>
          )}
          {data?.length === 0 && (
            <tr>
              <td colSpan={4} className="px-2 py-4 text-fg-secondary">
                No travel documents on file.
              </td>
            </tr>
          )}
          {data?.map((d) => (
            <tr key={d.id}>
              <td className="px-2 py-2">
                {DRIVER_DOCUMENT_LABELS[d.documentType]}
                {d.isPrimary && <span className="ml-1 text-xs text-fg-secondary">· primary</span>}
              </td>
              <td className="px-2 py-2 font-mono text-xs">{d.documentNumber}</td>
              <td className="px-2 py-2">
                <ExpiryChip value={d.expiresOn} />
              </td>
              <td className="px-2 py-2 text-right whitespace-nowrap">
                {canWrite && (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="mr-3 px-0 py-0"
                      onClick={() =>
                        setDraft({
                          id: d.id,
                          documentType: d.documentType,
                          documentNumber: d.documentNumber,
                          issuingCountry: d.issuingCountry ?? "",
                          issuingState: d.issuingState ?? "",
                          issuedOn: d.issuedOn ?? "",
                          expiresOn: d.expiresOn ?? "",
                          isPrimary: d.isPrimary,
                        })
                      }
                    >
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="px-0 py-0 text-status-danger hover:text-status-danger hover:underline"
                      onClick={() => remove.mutate({ driverId, id: d.id })}
                    >
                      Remove
                    </Button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {canWrite &&
        (draft ? (
          <div className="grid grid-cols-1 gap-3 rounded-lg border border-border-default p-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="doc-type">Document type</Label>
              <NativeSelect
                id="doc-type"
                value={draft.documentType}
                onChange={(e) =>
                  setDraft({ ...draft, documentType: e.target.value as DriverDocumentType })
                }
              >
                {DRIVER_DOCUMENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {DRIVER_DOCUMENT_LABELS[t]}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div>
              <Label htmlFor="doc-number">Document number</Label>
              <Input
                id="doc-number"
                className="font-mono"
                value={draft.documentNumber}
                onChange={(e) => setDraft({ ...draft, documentNumber: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="doc-country">Issuing country</Label>
              <Input
                id="doc-country"
                className="uppercase"
                placeholder="CA"
                value={draft.issuingCountry}
                onChange={(e) =>
                  setDraft({ ...draft, issuingCountry: e.target.value.toUpperCase() })
                }
              />
            </div>
            <div>
              <Label htmlFor="doc-state">Issuing province/state</Label>
              <Input
                id="doc-state"
                value={draft.issuingState}
                onChange={(e) => setDraft({ ...draft, issuingState: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="doc-issued">Issued on</Label>
              <Input
                id="doc-issued"
                type="date"
                value={draft.issuedOn}
                onChange={(e) => setDraft({ ...draft, issuedOn: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="doc-expires">Expires on</Label>
              <Input
                id="doc-expires"
                type="date"
                value={draft.expiresOn}
                onChange={(e) => setDraft({ ...draft, expiresOn: e.target.value })}
              />
            </div>
            <label className="col-span-2 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.isPrimary}
                onChange={(e) => setDraft({ ...draft, isPrimary: e.target.checked })}
              />
              Primary travel document
            </label>
            <div className="col-span-2 flex items-center justify-between gap-3">
              <p className="text-sm text-status-danger">{error}</p>
              <div className="flex gap-2">
                <Button type="button" variant="secondary" onClick={() => setDraft(null)}>
                  Cancel
                </Button>
                <Button type="button" onClick={save} disabled={upsert.isPending}>
                  {upsert.isPending ? "Saving…" : "Save document"}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <Button type="button" variant="secondary" onClick={() => setDraft({ ...emptyDraft })}>
            Add document
          </Button>
        ))}
    </div>
  );
}
