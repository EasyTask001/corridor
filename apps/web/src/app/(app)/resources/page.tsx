import type { Metadata } from "next";
import { ResourcesPanel } from "./resources-panel";

export const metadata: Metadata = { title: "Resources" };

/** External authoritative links plus clearly labelled experimental demo widgets. */
const LINKS: Array<{ group: string; items: Array<{ label: string; href: string; note: string }> }> =
  [
    {
      group: "Border wait times",
      items: [
        {
          label: "CBP border wait times",
          href: "https://bwt.cbp.gov/",
          note: "US-bound lanes, updated hourly by CBP",
        },
        {
          label: "CBSA border wait times",
          href: "https://www.cbsa-asfc.gc.ca/bwt-taf/menu-eng.html",
          note: "Canada-bound lanes",
        },
      ],
    },
    {
      group: "Postal code lookup",
      items: [
        {
          label: "USPS ZIP Code lookup",
          href: "https://tools.usps.com/zip-code-lookup.htm",
          note: "Find a ZIP by address",
        },
        {
          label: "Canada Post postal code lookup",
          href: "https://www.canadapost-postescanada.ca/info/mc/personal/postalcode/fpc.jsf",
          note: "Find a postal code by address",
        },
      ],
    },
    {
      group: "Tariff and brokers",
      items: [
        {
          label: "HTS search (USITC)",
          href: "https://hts.usitc.gov/",
          note: "US Harmonized Tariff Schedule",
        },
        {
          label: "CBSA customs brokers",
          href: "https://www.cbsa-asfc.gc.ca/services/cb-cd/cb-cd-eng.html",
          note: "Licensed brokers in Canada",
        },
        {
          label: "US customs brokers by port",
          href: "https://www.cbp.gov/contact/find-broker-by-port",
          note: "CBP list of licensed brokers per port",
        },
      ],
    },
  ];

export default function ResourcesPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Resources</h1>
        <p className="text-sm text-fg-secondary">
          The outside references a dispatcher needs mid-shift. Links open in a new tab.
        </p>
      </header>
      <ResourcesPanel />
      <div className="grid gap-4 lg:grid-cols-3">
        {LINKS.map((g) => (
          <section key={g.group} className="panel p-5" aria-label={g.group}>
            <h2 className="font-medium">{g.group}</h2>
            <ul className="mt-3 space-y-3 text-sm">
              {g.items.map((i) => (
                <li key={i.href}>
                  <a
                    href={i.href}
                    target="_blank"
                    rel="noopener"
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {i.label}
                  </a>
                  <p className="text-xs text-fg-secondary">{i.note}</p>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
