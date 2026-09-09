"use client";

import { useActionState } from "react";
import { Button, Input, Label } from "@corridor/ui";
import { resetPassword } from "../actions";

export function ResetPasswordForm({ stay = false }: { stay?: boolean }) {
  const [state, action, pending] = useActionState(resetPassword, null);
  return (
    <form action={action} className="space-y-4" aria-label="Set a new password">
      {stay && <input type="hidden" name="stay" value="on" />}
      <div>
        <Label htmlFor="password">New password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
        />
      </div>
      <div>
        <Label htmlFor="confirm">Confirm new password</Label>
        <Input
          id="confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
        />
      </div>
      {state?.error && <p className="text-sm text-status-danger">{state.error}</p>}
      {state?.message && (
        <p role="status" className="rounded-md bg-ok-500/10 px-3 py-2 text-sm text-status-ok">
          {state.message}
        </p>
      )}
      <Button type="submit" disabled={pending} className={stay ? "" : "w-full"}>
        {pending ? "Saving…" : stay ? "Change password" : "Set password"}
      </Button>
    </form>
  );
}
