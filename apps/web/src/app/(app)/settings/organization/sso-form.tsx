"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useMutation } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@corridor/api";
import type { SubscriptionPlan } from "@corridor/domain";
import { Alert, Badge, Button, Input, Label, Textarea } from "@corridor/ui";
import { useTRPC } from "@/lib/trpc/client";

type SsoState = inferRouterOutputs<AppRouter>["organization"]["sso"]["get"];
type SsoConfig = NonNullable<SsoState["config"]>;

/** `acme.com, sub.acme.com` / one per line — both are what people paste. */
function parseDomains(value: string): string[] {
  return value
    .split(/[\s,;]+/)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

function StatusBadge({ config }: { config: SsoConfig | null }) {
  if (!config) return <Badge variant="muted">Not configured</Badge>;
  return config.mode === "mock" ? (
    <Badge variant="warn">Mock provider</Badge>
  ) : (
    <Badge variant="ok">Active</Badge>
  );
}

/**
 * Single sign-on (SAML) for the organization.
 *
 * Rendered only for someone holding `organization.manage`; the API refuses the
 * read otherwise. Below Enterprise it is an upsell card rather than a hidden
 * feature, because "why can't I find SSO?" is the more expensive support
 * question.
 */
export function SsoForm({ plan, initial }: { plan: SubscriptionPlan; initial: SsoState | null }) {
  const trpc = useTRPC();
  const [config, setConfig] = useState<SsoConfig | null>(initial?.config ?? null);
  const [metadataUrl, setMetadataUrl] = useState("");
  const [metadataXml, setMetadataXml] = useState("");
  const [domains, setDomains] = useState((initial?.config?.domains ?? []).join(", "));
  const [enforced, setEnforced] = useState(initial?.config?.enforced ?? false);
  const [saved, setSaved] = useState<string | null>(null);

  const configure = useMutation(
    trpc.organization.sso.configure.mutationOptions({
      onSuccess: (row) => {
        setConfig(row);
        setDomains(row.domains.join(", "));
        setEnforced(row.enforced);
        setMetadataXml("");
        setSaved("Single sign-on saved.");
      },
    }),
  );
  const remove = useMutation(
    trpc.organization.sso.remove.mutationOptions({
      onSuccess: () => {
        setConfig(null);
        setDomains("");
        setEnforced(false);
        setMetadataUrl("");
        setMetadataXml("");
        setSaved("Single sign-on removed.");
      },
    }),
  );

  const removeButton = (
    <Button
      type="button"
      variant="danger"
      disabled={remove.isPending}
      onClick={() => {
        setSaved(null);
        remove.mutate();
      }}
    >
      {remove.isPending ? "Removing…" : "Remove SSO"}
    </Button>
  );

  if (plan !== "enterprise") {
    return (
      <section className="panel space-y-3 p-6">
        <header className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">Single sign-on (SAML)</h2>
          <Badge variant="solid">Enterprise</Badge>
        </header>
        <p className="text-sm text-fg-secondary">
          Let your team sign in with your identity provider (Okta, Entra ID, Google Workspace) and
          switch off passwords for your domains. Configuring it needs the Enterprise plan.
        </p>
        {/*
          A configuration left over from an Enterprise subscription keeps
          working — including `enforced`, which refuses password sign-in. So the
          card still shows it and still offers removal on a lower plan; only
          `configure` is gated on the plan.
        */}
        {config && (
          <>
            <Alert variant="warn">
              Single sign-on is still active for {config.domains.join(", ")} from a previous
              Enterprise subscription.
              {config.enforced
                ? " Password sign-in is refused for those domains until you remove it."
                : ""}
            </Alert>
            {remove.error && <p className="text-sm text-status-danger">{remove.error.message}</p>}
            {saved && <p className="text-sm text-status-ok">{saved}</p>}
            {removeButton}
          </>
        )}
        <Link href="/settings/billing" className="text-sm font-medium text-fg-primary underline">
          Compare plans
        </Link>
      </section>
    );
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaved(null);
    const url = metadataUrl.trim();
    const xml = metadataXml.trim();
    configure.mutate({
      ...(url ? { metadataUrl: url } : {}),
      ...(xml ? { metadataXml: xml } : {}),
      domains: parseDomains(domains),
      enforced,
    });
  };

  return (
    <section className="panel space-y-4 p-6">
      <header className="flex items-center gap-3">
        <h2 className="text-lg font-semibold">Single sign-on (SAML)</h2>
        <StatusBadge config={config} />
      </header>
      <p className="text-sm text-fg-secondary">
        Register your identity provider&apos;s metadata and the email domains it owns. Corridor
        never sees the SAML assertion — your IdP posts it straight to Supabase Auth.
      </p>

      {initial?.instanceMode === "mock" && (
        <Alert variant="warn">
          This deployment has no SAML-capable Auth instance configured, so a saved configuration is
          recorded as a mock provider and no real redirect happens.
        </Alert>
      )}

      {config && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-fg-secondary">Provider</dt>
          <dd className="font-mono text-xs">{config.providerId}</dd>
          <dt className="text-fg-secondary">Domains</dt>
          <dd>{config.domains.join(", ")}</dd>
          <dt className="text-fg-secondary">Password sign-in</dt>
          <dd>
            {config.enforced
              ? "Refused for these domains — sign-in and sign-up both require SSO"
              : "Still allowed alongside SSO"}
          </dd>
        </dl>
      )}

      <form className="space-y-4" onSubmit={submit}>
        <div>
          <Label htmlFor="sso-metadata-url">Metadata URL</Label>
          <Input
            id="sso-metadata-url"
            value={metadataUrl}
            placeholder="https://idp.example.com/app/metadata"
            onChange={(event) => setMetadataUrl(event.target.value)}
          />
          <p className="mt-1 text-xs text-fg-secondary">
            Or paste the metadata XML below — one or the other, not both.
          </p>
        </div>

        <div>
          <Label htmlFor="sso-metadata-xml">Metadata XML</Label>
          <Textarea
            id="sso-metadata-xml"
            rows={4}
            value={metadataXml}
            placeholder="<EntityDescriptor …>"
            className="font-mono text-xs"
            onChange={(event) => setMetadataXml(event.target.value)}
          />
        </div>

        <div>
          <Label htmlFor="sso-domains">Email domains</Label>
          <Input
            id="sso-domains"
            value={domains}
            placeholder="acme.com, acme.co.uk"
            onChange={(event) => setDomains(event.target.value)}
          />
        </div>

        <label className="flex items-center gap-2 text-sm" htmlFor="sso-enforced">
          <input
            id="sso-enforced"
            type="checkbox"
            checked={enforced}
            onChange={(event) => setEnforced(event.target.checked)}
            className="size-4 rounded border-border-default"
          />
          Require SSO — refuse password sign-in and sign-up for these domains
        </label>
        <p className="-mt-2 text-xs text-fg-secondary">
          Enforcement applies to new sign-ins; people already signed in keep their session until it
          expires.
        </p>

        {configure.error && <p className="text-sm text-status-danger">{configure.error.message}</p>}
        {remove.error && <p className="text-sm text-status-danger">{remove.error.message}</p>}
        {saved && <p className="text-sm text-status-ok">{saved}</p>}

        <div className="flex gap-3">
          <Button type="submit" disabled={configure.isPending}>
            {configure.isPending ? "Saving…" : config ? "Update SSO" : "Enable SSO"}
          </Button>
          {config && removeButton}
        </div>
      </form>
    </section>
  );
}
