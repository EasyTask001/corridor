"use client";

import { useActionState } from "react";
import { signUp } from "../actions";

export function SignupForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(signUp, null);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="next" value={next} />
      <div>
        <label htmlFor="displayName" className="label">
          Your name
        </label>
        <input id="displayName" name="displayName" autoComplete="name" required className="input" />
      </div>
      <div>
        <label htmlFor="email" className="label">
          Work email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className="input"
        />
      </div>
      <div>
        <label htmlFor="password" className="label">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          className="input"
        />
      </div>
      {state?.error && <p className="text-sm text-status-danger">{state.error}</p>}
      {state?.message && <p className="text-sm text-status-ok">{state.message}</p>}
      <button type="submit" disabled={pending} className="btn-primary w-full">
        {pending ? "Creating…" : "Create account"}
      </button>
    </form>
  );
}
