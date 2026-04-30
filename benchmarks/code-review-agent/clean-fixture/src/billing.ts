export type User = {
  id: string;
  role: "admin" | "member";
};

export type Invoice = {
  id: string;
  ownerId: string;
  totalCents: number;
};

export type LineItem = {
  sku: string;
  quantity: number;
  unitCents: number;
};

export type InvoiceSummary = {
  id: string;
  ownerId: string;
  totalCents: number;
};

function assertSafeCents(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
}

export function canViewInvoice(user: User, invoice: Invoice): boolean {
  return user.role === "admin" || invoice.ownerId === user.id;
}

export function calculateTotalCents(items: LineItem[], discountCents = 0): number {
  assertSafeCents(discountCents, "discountCents");

  let total = 0;
  for (const item of items) {
    assertSafeCents(item.quantity, "quantity");
    assertSafeCents(item.unitCents, "unitCents");
    const lineTotal = item.quantity * item.unitCents;
    assertSafeCents(lineTotal, "lineTotal");
    total += lineTotal;
    assertSafeCents(total, "total");
  }

  return Math.max(0, total - discountCents);
}

export function summarizeInvoices(user: User, invoices: Invoice[]): InvoiceSummary[] {
  return invoices
    .filter((invoice) => canViewInvoice(user, invoice))
    .map((invoice) => ({
      id: invoice.id,
      ownerId: invoice.ownerId,
      totalCents: invoice.totalCents,
    }));
}
