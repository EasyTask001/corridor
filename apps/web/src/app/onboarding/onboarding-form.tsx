"use client";

import { useActionState } from "react";
import { createOrganization, type OnboardingState } from "./actions";

export function OnboardingForm() {
  const [state, action, pending] = useActionState<OnboardingState, FormData>(
    createOrganization,
    null,
  );
  return (
    <form action={action} className="space-y-4">
      <div>
        <label htmlFor="name" className="label">
          Carrier name
        </label>
        <input id="name" name="name" required maxLength={120} className="input" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="scacCode" className="label">
            SCAC (US)
          </label>
          <input id="scacCode" name="scacCode" placeholder="PFTR" className="input uppercase" />
        </div>
        <div>
          <label htmlFor="canadianCarrierCode" className="label">
            CBSA carrier code
          </label>
          <input
            id="canadianCarrierCode"
            name="canadianCarrierCode"
            placeholder="PFT1"
            className="input uppercase"
          />
        </div>
        <div>
          <label htmlFor="usDotNumber" className="label">
            USDOT #
          </label>
          <input id="usDotNumber" name="usDotNumber" inputMode="numeric" className="input" />
        </div>
        <div>
          <label htmlFor="mcNumber" className="label">
            MC #
          </label>
          <input id="mcNumber" name="mcNumber" className="input" />
        </div>
      </div>
      {state?.error && (
        <p role="alert" className="text-sm text-status-danger">
          {state.error}
        </p>
      )}
      <button type="submit" disabled={pending} className="btn-primary w-full">
        {pending ? "Creating…" : "Create carrier"}
      </button>
    </form>
  );
}
