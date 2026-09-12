import { z } from "zod";
import { AtomicAmountSchema } from "../listings/schemas.js";

export const BuyerIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/,
    "buyer id must be alphanumeric with . _ : -",
  );

export const TopUpInputSchema = z.object({
  buyerId: BuyerIdSchema,
  amount: AtomicAmountSchema.refine((v) => BigInt(v) > 0n, {
    message: "top-up amount must be > 0",
  }),
  /** Optional note for audit (dev faucet, stripe, etc.). */
  note: z.string().max(512).optional(),
});

export type TopUpInput = z.input<typeof TopUpInputSchema>;

export const BalanceSchema = z.object({
  buyerId: z.string(),
  balance: AtomicAmountSchema,
  updatedAt: z.string().min(1),
});

export type Balance = z.infer<typeof BalanceSchema>;

export const SpendLogEntrySchema = z.object({
  id: z.string().min(1),
  buyerId: z.string().min(1),
  listingId: z.string().min(1),
  amount: AtomicAmountSchema,
  idempotencyKey: z.string().min(1),
  requestId: z.string().nullable(),
  status: z.enum(["pending", "settled", "failed", "replayed"]),
  upstreamStatus: z.number().int().nullable(),
  errorReason: z.string().nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type SpendLogEntry = z.infer<typeof SpendLogEntrySchema>;

export const SpendLogQuerySchema = z.object({
  buyerId: BuyerIdSchema.optional(),
  listingId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type SpendLogQuery = z.input<typeof SpendLogQuerySchema>;
