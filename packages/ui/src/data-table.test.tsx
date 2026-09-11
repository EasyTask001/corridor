import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDataTableColumns, DataTable } from "./components/data-table";

type Driver = { id: string; name: string; unit: number };

const helper = createDataTableColumns<Driver>();
const columns = helper.columns([
  helper.accessor("name", { header: "Driver" }),
  helper.accessor("unit", { header: "Unit" }),
]);

const rows: Driver[] = [
  { id: "b", name: "Bianca Ross", unit: 3 },
  { id: "a", name: "Amrit Kaur", unit: 1 },
  { id: "c", name: "Casey Lin", unit: 2 },
];

/** Body cell text, top to bottom, for the column at `index`. */
function columnValues(index: number) {
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[index]?.textContent);
}

describe("DataTable", () => {
  it("renders a row per record with the configured columns", () => {
    render(<DataTable data={rows} columns={columns} getRowId={(row) => row.id} />);

    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Driver",
      "Unit",
    ]);
    expect(columnValues(0)).toEqual(["Bianca Ross", "Amrit Kaur", "Casey Lin"]);
  });

  it("sorts on header click and cycles back through the header button", async () => {
    const user = userEvent.setup();
    render(<DataTable data={rows} columns={columns} getRowId={(row) => row.id} enableSorting />);

    const header = screen.getByRole("button", { name: /Driver/ });
    await user.click(header);
    expect(columnValues(0)).toEqual(["Amrit Kaur", "Bianca Ross", "Casey Lin"]);

    await user.click(header);
    expect(columnValues(0)).toEqual(["Casey Lin", "Bianca Ross", "Amrit Kaur"]);
  });

  it("shows the empty state instead of rows when there is no data", () => {
    render(<DataTable data={[]} columns={columns} emptyMessage="No drivers yet." />);

    expect(screen.getByText("No drivers yet.")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(2); // header + empty-state row
  });

  it("shows the loading state ahead of the empty state", () => {
    render(<DataTable data={[]} columns={columns} isLoading emptyMessage="No drivers yet." />);

    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText("No drivers yet.")).not.toBeInTheDocument();
  });
});

describe("row activation", () => {
  it("activates a row with Enter and Space from the keyboard", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    render(<DataTable data={rows} columns={columns} getRowId={(r) => r.id} onRowClick={onRowClick} />);
    await user.tab(); // first body row is the first tabbable element
    expect(screen.getAllByRole("row")[1]).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onRowClick).toHaveBeenCalledTimes(2);
    expect(onRowClick).toHaveBeenLastCalledWith(rows[0]);
  });

  it("does not activate the row when a control inside it is used", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    const withButton = helper.columns([
      helper.accessor("name", { header: "Driver", cell: (c) => <button type="button">{c.getValue()}</button> }),
    ]);
    render(<DataTable data={rows} columns={withButton} getRowId={(r) => r.id} onRowClick={onRowClick} />);
    await user.click(screen.getByRole("button", { name: "Bianca Ross" }));
    await user.keyboard("{Enter}");
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("rows are not tabbable without onRowClick", () => {
    render(<DataTable data={rows} columns={columns} getRowId={(r) => r.id} />);
    expect(screen.getAllByRole("row")[1]).not.toHaveAttribute("tabindex");
  });
});
