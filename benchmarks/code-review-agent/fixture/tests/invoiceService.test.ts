import { describe, expect, it } from "vitest";
import { calculateTotalCents } from "../src/invoiceService";

describe("calculateTotalCents", () => {
  it("adds item totals", async () => {
    await expect(
      calculateTotalCents({
        id: "inv_1",
        ownerId: "user_1",
        items: [{ sku: "paint", quantity: 2, unitCents: 5000 }],
      }),
    ).resolves.toBe(10000);
  });
});
