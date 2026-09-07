import { describe, expect, it } from "vitest";
import {
  createSsoProvider,
  deleteSsoProvider,
  isMockProviderId,
  MOCK_SSO_PROVIDER_PREFIX,
  readSsoEnv,
  reportsSamlDisabled,
  ssoMode,
  SsoProviderError,
  updateSsoProvider,
  type SsoEnv,
} from "./sso";

const INPUT = { metadataUrl: "https://idp.acme.com/metadata", domains: ["acme.com"] };

/** A `fetch` that records its calls and replays canned responses. */
function stubFetch(...responses: { status: number; body: unknown }[]) {
  const calls: { url: string; method: string; body: unknown; headers: Record<string, string> }[] =
    [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const next = responses.shift() ?? { status: 500, body: { msg: "no canned response" } };
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const configured = (fetchImpl: typeof fetch): SsoEnv => ({
  url: "https://auth.test",
  serviceRoleKey: "service-role-key",
  fetchImpl,
});

describe("ssoMode / readSsoEnv", () => {
  it("is mock until both the URL and the service-role key are configured", () => {
    expect(ssoMode({})).toBe("mock");
    expect(ssoMode({ url: "https://auth.test" })).toBe("mock");
    expect(ssoMode({ serviceRoleKey: "k" })).toBe("mock");
    expect(ssoMode({ url: "https://auth.test", serviceRoleKey: "k" })).toBe("saml");
  });

  it("prefers SUPABASE_URL over the public one", () => {
    expect(
      readSsoEnv({
        SUPABASE_URL: "https://internal.test",
        NEXT_PUBLIC_SUPABASE_URL: "https://public.test",
        SUPABASE_SERVICE_ROLE_KEY: "k",
      } as NodeJS.ProcessEnv),
    ).toEqual({ url: "https://internal.test", serviceRoleKey: "k" });
  });
});

describe("mock mode", () => {
  it("issues a mock-sso- provider id when nothing is configured", async () => {
    const provider = await createSsoProvider(INPUT, {});
    expect(provider.mode).toBe("mock");
    expect(provider.id.startsWith(MOCK_SSO_PROVIDER_PREFIX)).toBe(true);
    expect(isMockProviderId(provider.id)).toBe(true);
    expect(provider.domains).toEqual(["acme.com"]);
    expect(provider.entityId).toBeNull();
  });

  it("gives each configuration its own id", async () => {
    const a = await createSsoProvider(INPUT, {});
    const b = await createSsoProvider(INPUT, {});
    expect(a.id).not.toBe(b.id);
  });

  it("falls back to mock when the instance reports SAML disabled", async () => {
    const { impl, calls } = stubFetch({
      status: 404,
      body: { code: 404, error_code: "saml_provider_disabled", msg: "SAML 2.0 is disabled" },
    });
    const provider = await createSsoProvider(INPUT, configured(impl));
    expect(provider.mode).toBe("mock");
    expect(isMockProviderId(provider.id)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("never calls the API again for a mock id", async () => {
    const { impl, calls } = stubFetch();
    const env = configured(impl);
    const updated = await updateSsoProvider("mock-sso-abc", INPUT, env);
    expect(updated).toMatchObject({ id: "mock-sso-abc", mode: "mock", domains: ["acme.com"] });
    expect(await deleteSsoProvider("mock-sso-abc", env)).toEqual({ mode: "mock" });
    expect(calls).toEqual([]);
  });

  it("degrades to mock for update/delete when nothing is configured", async () => {
    expect(await updateSsoProvider("real-uuid", INPUT, {})).toMatchObject({ mode: "mock" });
    expect(await deleteSsoProvider("real-uuid", {})).toEqual({ mode: "mock" });
  });
});

describe("reportsSamlDisabled", () => {
  it("matches only SAML-is-off answers", () => {
    expect(reportsSamlDisabled({ msg: "SAML 2.0 is disabled" })).toBe(true);
    expect(reportsSamlDisabled({ error_code: "saml_disabled" })).toBe(true);
    expect(reportsSamlDisabled({ msg: "SAML is not enabled on this instance" })).toBe(true);
    // a real failure the operator has to see
    expect(reportsSamlDisabled({ msg: "SAML Metadata URL is invalid" })).toBe(false);
    expect(reportsSamlDisabled({ msg: "Provider is disabled" })).toBe(false);
    expect(reportsSamlDisabled(null)).toBe(false);
  });
});

describe("saml mode", () => {
  it("POSTs the metadata and domains and maps the response", async () => {
    const { impl, calls } = stubFetch({
      status: 201,
      body: {
        id: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
        saml: { entity_id: "https://idp.acme.com/saml" },
        domains: [{ domain: "acme.com" }, { domain: "acme.co.uk" }],
      },
    });
    const provider = await createSsoProvider(INPUT, configured(impl));

    expect(provider).toEqual({
      id: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
      domains: ["acme.com", "acme.co.uk"],
      entityId: "https://idp.acme.com/saml",
      mode: "saml",
    });
    expect(calls[0]!.url).toBe("https://auth.test/auth/v1/admin/sso/providers");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({
      type: "saml",
      metadata_url: "https://idp.acme.com/metadata",
      domains: ["acme.com"],
    });
    expect(calls[0]!.headers.Authorization).toBe("Bearer service-role-key");
  });

  it("sends metadata_xml when that is what was supplied", async () => {
    const { impl, calls } = stubFetch({ status: 201, body: { id: "p1" } });
    await createSsoProvider(
      { metadataXml: "<EntityDescriptor/>", domains: ["acme.com"] },
      configured(impl),
    );
    expect(calls[0]!.body).toEqual({
      type: "saml",
      metadata_xml: "<EntityDescriptor/>",
      domains: ["acme.com"],
    });
  });

  it("PUTs an update to the provider's own path", async () => {
    const { impl, calls } = stubFetch({ status: 200, body: { id: "p1" } });
    await updateSsoProvider("p1", INPUT, configured(impl));
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe("https://auth.test/auth/v1/admin/sso/providers/p1");
  });

  it("surfaces a real rejection instead of pretending it worked", async () => {
    const { impl } = stubFetch({ status: 422, body: { msg: "SAML Metadata URL is invalid" } });
    await expect(createSsoProvider(INPUT, configured(impl))).rejects.toBeInstanceOf(
      SsoProviderError,
    );
    const { impl: impl2 } = stubFetch({
      status: 422,
      body: { msg: "SAML Metadata URL is invalid" },
    });
    await expect(createSsoProvider(INPUT, configured(impl2))).rejects.toMatchObject({
      status: 422,
      message: "SAML Metadata URL is invalid",
    });
  });

  it("treats a delete of an already-gone provider as done", async () => {
    const { impl } = stubFetch({ status: 404, body: { msg: "SSO provider not found" } });
    expect(await deleteSsoProvider("p1", configured(impl))).toEqual({ mode: "saml" });
  });

  it("trims a trailing slash off the configured URL", async () => {
    const { impl, calls } = stubFetch({ status: 201, body: { id: "p1" } });
    await createSsoProvider(INPUT, {
      url: "https://auth.test/",
      serviceRoleKey: "k",
      fetchImpl: impl,
    });
    expect(calls[0]!.url).toBe("https://auth.test/auth/v1/admin/sso/providers");
  });
});
