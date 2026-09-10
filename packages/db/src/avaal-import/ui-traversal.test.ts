import { describe, expect, it } from "vitest";

import type { AgentycClient } from "./agentyc-client";
import type { AvaalFieldValue } from "./snapshot";
import { traverseCategory, type AvaalListPage } from "./ui-traversal";

interface FakeOptions {
  pages: AvaalListPage[];
  details: Record<string, Record<string, AvaalFieldValue>>;
  omittedFromState?: string[];
}

class FakeClient implements AgentycClient {
  readonly navigated: string[] = [];
  readonly detailedIds: string[] = [];
  readonly scrolledLabels: string[] = [];
  private pageIndex = 0;
  private currentDetailId = "";

  constructor(private readonly options: FakeOptions) {}

  async call<T>(tool: string, args: Record<string, unknown>): Promise<T> {
    if (tool === "browser_navigate") {
      this.navigated.push(String(args.url));
      this.pageIndex = 0;
      return {} as T;
    }
    if (tool === "browser_wait_for_stable_dom") return {} as T;
    if (tool === "browser_click") {
      if (args.label === "→") this.pageIndex += 1;
      else if (typeof args.label === "string") {
        const row = this.options.pages[this.pageIndex]!.rows.find(
          (candidate) => candidate.detailLabel === args.label,
        );
        if (
          row &&
          this.options.omittedFromState?.includes(row.sourceId) &&
          !this.scrolledLabels.includes(args.label)
        ) {
          throw new Error("Element did not match any supported target");
        }
        this.currentDetailId = row?.sourceId ?? "";
      }
      if (typeof args.ref === "string") this.currentDetailId = args.ref.replace("ref-", "");
      return {} as T;
    }
    if (tool === "browser_scroll_to_text") {
      this.scrolledLabels.push(String(args.text));
      return {} as T;
    }
    if (tool === "browser_wait_for_network_idle" || tool === "browser_wait") return {} as T;
    if (tool === "browser_get_state") {
      return {
        interactive_elements: this.options.pages[this.pageIndex]!.rows
          .filter(
            (row) =>
              !this.options.omittedFromState?.includes(row.sourceId) ||
              this.scrolledLabels.includes(row.detailLabel ?? ""),
          )
          .map((row) => ({
            ref: `ref-${row.sourceId}`,
            tag: "a",
            text: row.detailLabel,
            context: Object.values(row.fields).join(" "),
          })),
      } as T;
    }
    if (tool === "browser_evaluate") {
      const code = String(args.code);
      if (code.includes("corridor:list")) return this.options.pages[this.pageIndex] as T;
      if (code.includes("paginate_button")) {
        this.pageIndex = Math.min(this.pageIndex + 1, this.options.pages.length - 1);
        return true as T;
      }
      this.detailedIds.push(this.currentDetailId);
      return { fields: this.options.details[this.currentDetailId] ?? {} } as T;
    }
    throw new Error(`Unexpected fake tool ${tool}`);
  }

  async close(): Promise<void> {}
}

const config = {
  category: "drivers" as const,
  kind: "table" as const,
  baseUrl: "https://avaal.example",
  route: "/Masters/Driver/Driver",
  tableSelector: "#drivers",
  sourceIdColumn: "Driver ID",
  detail: {
    linkSelector: "a[id^='aDRVId']",
    rootSelector: "#divDriverForm",
    control: "Edit" as const,
  },
  displayedTotalSelector: ".dataTables_info",
  pagination: { nextSelector: ".paginate_button.next", nextLabel: "→" },
};

const row = (sourceId: string, status: string) => ({
  sourceId,
  sourceUrl: `https://avaal.example/Masters/Driver/Driver#${sourceId}`,
  detailLabel: sourceId,
  detailElementId: `aDRVId-${sourceId}`,
  fields: { "Driver ID": sourceId, Status: status },
});

const twoPages = (): AvaalListPage[] => [
  {
    currentUrl: "https://avaal.example/Masters/Driver/Driver?page=1",
    pageNumber: 1,
    displayedTotal: 3,
    rows: [row("d1", "Active"), row("d2", "Active")],
    next: { visible: true, disabled: false },
  },
  {
    currentUrl: "https://avaal.example/Masters/Driver/Driver?page=2",
    pageNumber: 2,
    displayedTotal: 3,
    rows: [row("d2", "Active"), row("d3", "Inactive")],
    next: { visible: true, disabled: true },
  },
];

describe("Avaal UI category traversal", () => {
  it("visits each unique detail once across pagination and requires disabled Next", async () => {
    const client = new FakeClient({
      pages: twoPages(),
      details: {
        d1: { Name: "Driver One" },
        d2: { Name: "Driver Two" },
        d3: { Name: "Driver Three" },
      },
      omittedFromState: ["d2"],
    });

    const snapshot = await traverseCategory(client, config);

    expect(client.detailedIds).toEqual(["d1", "d2", "d3"]);
    expect(client.scrolledLabels).toContain("d2");
    expect(snapshot).toMatchObject({
      displayedTotal: 3,
      finalPageReached: true,
      pagesVisited: [1, 2],
    });
    expect("records" in snapshot && snapshot.records).toHaveLength(3);
  });

  it("rejects duplicate IDs whose visible list fields conflict", async () => {
    const pages = twoPages();
    pages[1]!.rows[0] = row("d2", "Inactive");
    const client = new FakeClient({ pages, details: { d1: {}, d2: {} } });

    await expect(traverseCategory(client, config)).rejects.toThrow(/conflicting.*d2/i);
  });

  it("does not claim completion until a visible disabled Next is observed", async () => {
    const pages = twoPages();
    pages[1]!.next = { visible: false, disabled: false };
    const client = new FakeClient({ pages, details: { d1: {}, d2: {}, d3: {} } });

    await expect(traverseCategory(client, config)).rejects.toThrow(/disabled.*Next/i);
  });
});
