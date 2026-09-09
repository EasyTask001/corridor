"use client";

import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Button, Input, Label } from "@corridor/ui";
import { useTRPC } from "@/lib/trpc/client";

export function ProfilePanel({
  initial,
}: {
  initial: { displayName: string; phone: string; email: string };
}) {
  const trpc = useTRPC();
  const router = useRouter();
  const [saved, setSaved] = useState(false);
  const update = useMutation(
    trpc.organization.updateMe.mutationOptions({
      onSuccess: () => {
        setSaved(true);
        router.refresh();
      },
    }),
  );
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaved(false);
    const fd = new FormData(e.currentTarget);
    update.mutate({
      displayName: String(fd.get("displayName") ?? "").trim(),
      phone: String(fd.get("phone") ?? "").trim() || null,
    });
  };
  return (
    <form onSubmit={submit} className="panel max-w-md space-y-4 p-5" aria-label="Profile">
      <div>
        <Label htmlFor="email">Email</Label>
        <Input id="email" value={initial.email} readOnly className="bg-surface-sunken" />
      </div>
      <div>
        <Label htmlFor="displayName">Display name</Label>
        <Input
          id="displayName"
          name="displayName"
          defaultValue={initial.displayName}
          required
          maxLength={80}
        />
      </div>
      <div>
        <Label htmlFor="phone">Phone</Label>
        <Input
          id="phone"
          name="phone"
          type="tel"
          defaultValue={initial.phone}
          placeholder="+1 519 555 0100"
        />
        <p className="mt-1 text-xs text-fg-secondary">
          Used for SMS notifications you turn on under Notifications.
        </p>
      </div>
      {update.error && (
        <p role="alert" className="text-sm text-status-danger">
          {update.error.message}
        </p>
      )}
      {saved && (
        <p role="status" className="text-sm text-status-ok">
          Profile saved.
        </p>
      )}
      <Button type="submit" disabled={update.isPending}>
        {update.isPending ? "Saving…" : "Save profile"}
      </Button>
    </form>
  );
}
