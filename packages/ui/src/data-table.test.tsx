import { describe, expect, it } from "vitest";
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
