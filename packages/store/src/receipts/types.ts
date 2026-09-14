import { z } from "zod";
import { AtomicAmountSchema } from "../listings/schemas.js";

export const PublicReceiptSchema = z.object({
  spendId: z.string().min(1),
  amount: AtomicAmountSchema,
  asset: z.string().min(1),
  network: z.string().min(1),
  networkLabel: z.string().min(1),
  listing: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
  }),
  buyer: z.string().min(1),
  settleStatus: z.enum(["pending", "settled", "failed", "replayed"]),
  payoutStatus: z.enum(["pending", "paid", "failed", "none"]),
  payoutTx: z.string().nullable(),
  explorerUrl: z.string().url().nullable(),
  createdAt: z.string().min(1),
  settledAt: z.string().nullable(),
  receiptUrl: z.string().url().optional(),
});

export type PublicReceipt = z.infer<typeof PublicReceiptSchema>;

export const PublicReceiptListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type PublicReceiptListQuery = z.input<typeof PublicReceiptListQuerySchema>;
