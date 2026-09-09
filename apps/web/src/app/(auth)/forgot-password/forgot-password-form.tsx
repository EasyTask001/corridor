"use client";

import { useActionState } from "react";
import { Button, Input, Label } from "@corridor/ui";
import { forgotPassword } from "../actions";

export function ForgotPasswordForm() {
  const [state, action, pending] = useActionState(forgotPassword, null);
  return (
    <form action={action} className="space-y-4" aria-label="Request a password reset">
      <div>
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </div>
      {state?.error && <p className="text-sm text-status-danger">{state.error}</p>}
      {state?.message && (
        <p role="status" className="rounded-md bg-ok-500/10 px-3 py-2 text-sm text-status-ok">
          {state.message}
        </p>
      )}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Sending…" : "Send reset link"}
      </Button>
    </form>
  );
}
