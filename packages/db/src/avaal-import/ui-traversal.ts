import type { AgentycClient } from "./agentyc-client";
import type {
  AvaalCategory,
  AvaalCategorySnapshot,
  AvaalFieldValue,
  AvaalUiRecord,
} from "./snapshot";

export type AvaalDetailControl = "View" | "Edit" | "Details" | "row-link" | "expand";

export interface AvaalDetailConfig {
  rootSelector: string;
  linkSelector?: string;
  control?: AvaalDetailControl;
  fieldAliases?: Record<string, string>;
  tableAliases?: Record<string, string>;
}

interface AvaalBasePageConfig {
  category: AvaalCategory;
  baseUrl: string;
  route: string;
}

export interface AvaalSingletonPageConfig extends AvaalBasePageConfig {
  kind: "singleton";
  sourceId: string;
  detail: AvaalDetailConfig;
}

export interface AvaalTablePageConfig extends AvaalBasePageConfig {
  kind: "table";
  tableSelector: string;
  rowSelector?: string;
  sourceIdColumn: string;
  detail?: AvaalDetailConfig & {
    linkSelector: string;
    control: AvaalDetailControl;
  };
  displayedTotalSelector?: string;
  pagination?: {
    nextSelector: string;
    nextLabel: string;
    activePageSelector?: string;
  };
}

export type AvaalPageConfig = AvaalSingletonPageConfig | AvaalTablePageConfig;

export interface AvaalListRow {
  sourceId: string;
  sourceUrl: string;
  detailLabel?: string;
  detailElementId?: string;
  rowText?: string;
  fields: Record<string, AvaalFieldValue>;
}

export interface AvaalListPage {
  currentUrl: string;
  pageNumber: number;
  displayedTotal: number | null;
  rows: AvaalListRow[];
  next: { visible: boolean; disabled: boolean } | null;
}

interface AvaalDetailPage {
  fields: Record<string, AvaalFieldValue>;
}

interface BrowserInteractiveElement {
  ref?: string;
  tag?: string;
  id?: string;
  text?: string;
  context?: string;
}

interface BrowserState {
  url?: string;
  interactive_elements?: BrowserInteractiveElement[];
}

const listExtractionCode = (config: AvaalTablePageConfig): string => `
(function(){
  /* corridor:list */
  const config = ${JSON.stringify(config)};
  const visible = (element) => Boolean(element && element.getClientRects().length);
  const text = (element) => (element && element.textContent || "").replace(/\\s+/g, " ").trim();
  const table = document.querySelector(config.tableSelector);
  if (!table || !visible(table)) throw new Error("Visible Avaal table was not found");
  const headers = Array.from(table.querySelectorAll("thead th")).map(text);
  const rowSelector = config.rowSelector || "tbody tr";
  const rows = Array.from(table.querySelectorAll(rowSelector)).filter(visible).map((row) => {
    const cells = Array.from(row.querySelectorAll(":scope > td"));
    const fields = {};
    cells.forEach((cell, index) => {
      const heading = headers[index] || "Column " + (index + 1);
      fields[heading] = text(cell);
    });
    const link = config.detail ? row.querySelector(config.detail.linkSelector) : null;
    if (config.detail && (!link || !visible(link))) {
      throw new Error("Visible detail control was not found for a row");
    }
    const identityControl = link || row.querySelector("input[id], a[id], button[id]");
    const sourceId = String(
      link && link.id ||
      identityControl && identityControl.id ||
      fields[config.sourceIdColumn] ||
      row.dataset.id ||
      ""
    ).trim();
    const sourceUrl = location.href.split("#")[0] + "#" + encodeURIComponent(sourceId);
    return {
      sourceId,
      sourceUrl,
      detailLabel: link ? (text(link) || text(cells.find((cell, index) => index > 0 && text(cell)))) : undefined,
      detailElementId: link ? link.id : undefined,
      rowText: text(row),
      fields,
    };
  });
  let displayedTotal = null;
  if (config.displayedTotalSelector) {
    const totalText = text(document.querySelector(config.displayedTotalSelector));
    const match = totalText.match(/(?:of|total)\\s+([\\d,]+)/i) || totalText.match(/([\\d,]+)\\s+(?:entries|records|items)/i);
    if (match) displayedTotal = Number(match[1].replace(/,/g, ""));
  }
  let pageNumber = 1;
  const activeSelector = config.pagination && config.pagination.activePageSelector;
  if (activeSelector) {
    const parsed = Number.parseInt(text(document.querySelector(activeSelector)), 10);
    if (Number.isInteger(parsed) && parsed > 0) pageNumber = parsed;
  }
  let next = null;
  if (config.pagination) {
    const control = document.querySelector(config.pagination.nextSelector);
    next = {
      visible: visible(control),
      disabled: Boolean(control && (
        control.disabled ||
        control.getAttribute("aria-disabled") === "true" ||
        control.classList.contains("disabled") ||
        control.parentElement && control.parentElement.classList.contains("disabled")
      )),
    };
  }
  return { currentUrl: location.href, pageNumber, displayedTotal, rows, next };
})()
`;

const detailExtractionCode = (config: AvaalDetailConfig): string => `
(function(){
  /* corridor:detail */
  const config = ${JSON.stringify(config)};
  const visible = (element) => Boolean(element && element.getClientRects().length);
  const clean = (value) => String(value == null ? "" : value).replace(/\\s+/g, " ").trim();
  const root = document.querySelector(config.rootSelector);
  if (!root || !visible(root)) throw new Error("Visible Avaal detail form was not found");
  const fields = {};
  const add = (label, value) => {
    const key = clean(label).replace(/\\*+$/, "");
    if (!key) return;
    const next = typeof value === "string" ? clean(value) : value;
    if (!(key in fields)) fields[key] = next;
    else if (JSON.stringify(fields[key]) !== JSON.stringify(next)) {
      fields[key] = Array.isArray(fields[key]) ? fields[key].concat([next]) : [fields[key], next];
    }
  };
  const inferredLabel = (control) => {
    const explicit = control.id && document.querySelector('label[for="' + CSS.escape(control.id) + '"]');
    if (explicit) return clean(explicit.textContent);
    const parent = control.parentElement && control.parentElement.cloneNode(true);
    if (parent) {
      for (const child of parent.querySelectorAll("input, select, textarea, script, style")) child.remove();
      const parentText = clean(parent.textContent);
      if (parentText) return parentText;
    }
    return clean(control.getAttribute("aria-label") || control.name || control.placeholder || control.id);
  };
  for (const control of root.querySelectorAll("input, select, textarea")) {
    if (!visible(control) || control.type === "hidden" || control.type === "password") continue;
    const name = config.fieldAliases && config.fieldAliases[control.id] || inferredLabel(control);
    let value = control.value;
    if (control.tagName === "SELECT") {
      value = Array.from(control.selectedOptions).map((option) => clean(option.textContent)).join(", ");
    }
    if (control.type === "checkbox" || control.type === "radio") value = control.checked;
    add(name, value);
  }
  for (const [tableIndex, table] of Array.from(root.querySelectorAll("table")).entries()) {
    if (!visible(table)) continue;
    const headers = Array.from(table.querySelectorAll("thead th")).map((cell, index) => clean(cell.textContent) || "Column " + (index + 1));
    const rows = Array.from(table.querySelectorAll("tbody tr")).filter(visible).map((row) => {
      const result = {};
      const used = {};
      Array.from(row.querySelectorAll(":scope > td")).forEach((cell, index) => {
        const base = headers[index] || "Column " + (index + 1);
        used[base] = (used[base] || 0) + 1;
        const heading = used[base] === 1 ? base : base + " (" + used[base] + ")";
        result[heading] = clean(cell.textContent);
      });
      return result;
    });
    const name = config.tableAliases && config.tableAliases[table.id] || "Table: " + (table.id || tableIndex + 1);
    add(name, rows);
  }
  for (const term of root.querySelectorAll("dt")) {
    if (visible(term) && term.nextElementSibling && term.nextElementSibling.tagName === "DD") {
      add(term.textContent, term.nextElementSibling.textContent);
    }
  }
  return { fields };
})()
`;

const sameFields = (
  left: Record<string, AvaalFieldValue>,
  right: Record<string, AvaalFieldValue>,
): boolean => JSON.stringify(left) === JSON.stringify(right);

const mergedFields = (
  list: Record<string, AvaalFieldValue>,
  detail: Record<string, AvaalFieldValue>,
): Record<string, AvaalFieldValue> => {
  const merged = { ...list, ...detail };
  for (const [key, value] of Object.entries(list)) {
    if (key in detail && JSON.stringify(value) !== JSON.stringify(detail[key])) {
      merged[`List: ${key}`] = value;
    }
  }
  return merged;
};

const visit = async (client: AgentycClient, url: string): Promise<void> => {
  await client.call("browser_navigate", { url });
  await client.call("browser_wait_for_stable_dom", { timeout_seconds: 15, quiet_ms: 500 });
};

const detailRef = (
  state: BrowserState,
  row: AvaalListRow,
  category: string,
): string | undefined => {
  if (row.detailElementId) {
    const elementId = row.detailElementId;
    const byId = (state.interactive_elements ?? []).find(
      (element) => element.tag === "a" && element.ref &&
        (element.id === elementId || element.context?.includes(elementId)),
    );
    if (byId?.ref) return byId.ref;
  }
  const candidates = (state.interactive_elements ?? []).filter(
    (element) => element.tag === "a" && element.text?.trim() === row.detailLabel,
  );
  if (candidates.length === 1 && candidates[0]!.ref) return candidates[0]!.ref;
  if (candidates.length > 1) {
    const clues = Object.values(row.fields)
      .filter((value): value is string => typeof value === "string" && value.length >= 2)
      .sort((left, right) => right.length - left.length);
    const ranked = candidates
      .map((candidate) => ({
        candidate,
        score: clues.filter((clue) => candidate.context?.includes(clue)).length,
      }))
      .sort((left, right) => right.score - left.score);
    if (ranked[0]!.score > (ranked[1]?.score ?? -1) && ranked[0]!.candidate.ref) {
      return ranked[0]!.candidate.ref;
    }
  }
  if (candidates.length > 1) {
    throw new Error(`${category}: visible detail control is ambiguous for ${row.sourceId}`);
  }
  return undefined;
};

const extractDetail = async (
  client: AgentycClient,
  config: AvaalDetailConfig,
): Promise<AvaalDetailPage> => {
  const detail = await client.call<AvaalDetailPage>("browser_evaluate", {
    code: detailExtractionCode(config),
  });
  if (!detail || typeof detail.fields !== "object" || detail.fields === null) {
    throw new Error("Avaal detail extraction returned invalid data");
  }
  return detail;
};

const traverseSingleton = async (
  client: AgentycClient,
  config: AvaalSingletonPageConfig,
  startUrl: string,
): Promise<AvaalCategorySnapshot> => {
  const detail = await extractDetail(client, config.detail);
  return {
    route: config.route,
    displayedTotal: 1,
    finalPageReached: true,
    pagesVisited: [1],
    records: [{ sourceId: config.sourceId, sourceUrl: startUrl, fields: detail.fields }],
    warnings: [],
  };
};

export const traverseCategory = async (
  client: AgentycClient,
  config: AvaalPageConfig,
): Promise<AvaalCategorySnapshot> => {
  const startUrl = new URL(config.route, config.baseUrl).href;
  await visit(client, startUrl);
  if (config.kind === "singleton") return traverseSingleton(client, config, startUrl);

  const records = new Map<string, AvaalUiRecord>();
  const visibleRows = new Map<string, Record<string, AvaalFieldValue>>();
  const pagesVisited: number[] = [];
  const warnings: string[] = [];
  let displayedTotal: number | null = null;
  let finalPageReached = false;

  for (let pageIndex = 1; pageIndex <= 10_000; pageIndex += 1) {
    const page = await client.call<AvaalListPage>("browser_evaluate", {
      code: listExtractionCode(config),
    });
    if (!page || !Array.isArray(page.rows) || !page.currentUrl) {
      throw new Error(`${config.category}: Avaal list page extraction returned invalid data`);
    }
    if (page.pageNumber !== pageIndex) {
      throw new Error(
        `${config.category}: expected visible page ${pageIndex}, received ${page.pageNumber}`,
      );
    }
    pagesVisited.push(pageIndex);
    if (page.displayedTotal !== null) {
      if (displayedTotal !== null && displayedTotal !== page.displayedTotal) {
        throw new Error(`${config.category}: displayed total changed during traversal`);
      }
      displayedTotal = page.displayedTotal;
    }

    const unseen: AvaalListRow[] = [];
    for (const row of page.rows) {
      if (!row.sourceId.trim() || !row.sourceUrl.trim()) {
        throw new Error(`${config.category}: visible row has an empty source ID or UI source URL`);
      }
      const prior = visibleRows.get(row.sourceId);
      if (prior && !sameFields(prior, row.fields)) {
        throw new Error(`${config.category}: conflicting visible fields for duplicate ${row.sourceId}`);
      }
      if (!prior) {
        visibleRows.set(row.sourceId, row.fields);
        unseen.push(row);
      } else {
        warnings.push(`Repeated visible row ${row.sourceId} was de-duplicated`);
      }
    }

    for (const row of unseen) {
      if (!config.detail) {
        records.set(row.sourceId, {
          sourceId: row.sourceId,
          sourceUrl: row.sourceUrl,
          fields: row.fields,
        });
        continue;
      }
      if (!row.detailLabel && !row.detailElementId) {
        throw new Error(`${config.category}: detail label missing for ${row.sourceId}`);
      }
      const state = await client.call<BrowserState>("browser_get_state", { mode: "full" });
      let ref = detailRef(state, row, config.category);
      if (!ref) {
        if (row.detailLabel) await client.call("browser_scroll_to_text", { text: row.detailLabel });
        const scrolledState = await client.call<BrowserState>("browser_get_state", {
          mode: "full",
        });
        ref = detailRef(scrolledState, row, config.category);
      }
      if (!ref) {
        throw new Error(`${config.category}: visible detail control unavailable for ${row.sourceId}`);
      }
      await client.call("browser_click", { ref });
      await client.call("browser_wait_for_stable_dom", { timeout_seconds: 15, quiet_ms: 500 });
      const detail = await extractDetail(client, config.detail);
      records.set(row.sourceId, {
        sourceId: row.sourceId,
        sourceUrl: row.sourceUrl,
        fields: mergedFields(row.fields, detail.fields),
      });
    }

    if (!config.pagination) {
      finalPageReached = true;
      break;
    }
    if (!page.next?.visible) {
      throw new Error(`${config.category}: a visible disabled Next control was not observed`);
    }
    if (page.next.disabled) {
      finalPageReached = true;
      break;
    }
    await client.call("browser_click", { label: config.pagination.nextLabel });
    await client.call("browser_wait_for_stable_dom", { timeout_seconds: 15, quiet_ms: 500 });
  }

  if (!finalPageReached) {
    throw new Error(`${config.category}: final pagination page was not reached`);
  }
  if (displayedTotal !== null && displayedTotal !== records.size) {
    throw new Error(
      `${config.category}: displayed total ${displayedTotal} differs from ${records.size} unique records`,
    );
  }

  return {
    route: config.route,
    displayedTotal,
    finalPageReached: true,
    pagesVisited,
    records: [...records.values()],
    warnings,
  };
};
