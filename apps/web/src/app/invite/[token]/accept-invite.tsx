"use client";

import { useActionState } from "react";
import { acceptInvitation, type InviteState } from "./actions";

export function AcceptInvite({ token }: { token: string }) {
  const [state, action, pending] = useActionState<InviteState, FormData>(acceptInvitation, null);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      {state?.error && <p className="text-sm text-danger-500">{state.error}</p>}
      <button type="submit" disabled={pending} className="btn-primary w-full">
        {pending ? "Joining…" : "Accept invitation"}
      </button>
    </form>
  );
}
