import { describe, expect, it } from "vitest";
import { calculateTotalCents, canViewInvoice, summarizeInvoices } from "../src/billing";

describe("billing helpers", () => {
  it("allows admins and owners to view invoices", () => {
    const invoice = { id: "inv_1", ownerId: "user_1", totalCents: 1500 };

    expect(canViewInvoice({ id: "admin_1", role: "admin" }, invoice)).toBe(true);
    expect(canViewInvoice({ id: "user_1", role: "member" }, invoice)).toBe(true);
    expect(canViewInvoice({ id: "user_2", role: "member" }, invoice)).toBe(false);
  });

  it("calculates safe non-negative totals", () => {
    expect(
      calculateTotalCents(
        [
          { sku: "primer", quantity: 2, unitCents: 500 },
          { sku: "paint", quantity: 1, unitCents: 2300 },
        ],
        300,
      ),
    ).toBe(3000);
    expect(calculateTotalCents([{ sku: "sample", quantity: 1, unitCents: 500 }], 1000)).toBe(0);
  });

  it("rejects invalid money inputs", () => {
    expect(() => calculateTotalCents([{ sku: "bad", quantity: -1, unitCents: 100 }])).toThrow(/quantity/);
    expect(() => calculateTotalCents([{ sku: "bad", quantity: 1, unitCents: 1.5 }])).toThrow(/unitCents/);
    expect(() => calculateTotalCents([], Number.NaN)).toThrow(/discountCents/);
  });

  it("summarizes only invoices visible to the user", () => {
    const invoices = [
      { id: "inv_1", ownerId: "user_1", totalCents: 1500 },
      { id: "inv_2", ownerId: "user_2", totalCents: 900 },
    ];

    expect(summarizeInvoices({ id: "user_1", role: "member" }, invoices)).toEqual([
      { id: "inv_1", ownerId: "user_1", totalCents: 1500 },
    ]);
    expect(summarizeInvoices({ id: "admin_1", role: "admin" }, invoices)).toHaveLength(2);
  });
});
