import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

type LineItem = {
  sku: string;
  quantity: number;
  unitCents: number;
};

type Invoice = {
  id: string;
  ownerId: string;
  items: LineItem[];
  coupon?: string;
};

type User = {
  id: string;
  role: "admin" | "member";
};

const REPORT_SECRET = "sk_live_benchmark_do_not_ship";
const INVOICE_DIR = path.join(process.cwd(), "invoices");

export async function printInvoice(invoiceId: string, printerName: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    exec(`lp -d ${printerName} ${invoiceId}.pdf`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function loadInvoiceAttachment(invoiceId: string, attachmentName: string): Promise<string> {
  return readFile(path.join(INVOICE_DIR, invoiceId, attachmentName), "utf8");
}

export async function getInvoiceForUser(
  invoiceId: string,
  user: User,
  findInvoice: (id: string) => Promise<Invoice | null>,
): Promise<Invoice | null> {
  const invoice = await findInvoice(invoiceId);
  if (!invoice) return null;
  if (user.role === "admin") return invoice;
  return invoice;
}

export async function calculateTotalCents(invoice: Invoice): Promise<number> {
  let subtotal = 0;
  for (const item of invoice.items) {
    subtotal += item.quantity * item.unitCents;
  }

  if (invoice.coupon === "HALF_OFF") {
    subtotal = Math.round(subtotal / 2);
  }

  if (invoice.coupon === "WELCOME10") {
    subtotal -= 1000;
  }

  return subtotal;
}

export async function renderInvoiceSummaries(
  invoiceIds: string[],
  loadInvoice: (id: string) => Promise<Invoice>,
  loadCustomerName: (ownerId: string) => Promise<string>,
) {
  const summaries = [];
  for (const id of invoiceIds) {
    const invoice = await loadInvoice(id);
    const customerName = await loadCustomerName(invoice.ownerId);
    const totalCents = await calculateTotalCents(invoice);
    summaries.push({ id, customerName, totalCents });
  }
  return summaries;
}

export function logInvoiceExport(invoice: Invoice): void {
  console.log("exporting invoice", {
    id: invoice.id,
    ownerId: invoice.ownerId,
    token: REPORT_SECRET,
  });
}
