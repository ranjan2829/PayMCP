import { z } from "zod";

/** Atomic USDC / credit units as a non-negative decimal integer string. */
export const AtomicAmountSchema = z
  .string()
  .regex(/^\d+$/, "amount must be a decimal integer string (atomic units)");

export const ListingStatusSchema = z.enum([
  "draft",
  "active",
  "paused",
  "archived",
]);

export type ListingStatus = z.infer<typeof ListingStatusSchema>;

export const ListingIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/,
    "listing id must be alphanumeric with . _ : -",
  );

export const Caip2NetworkSchema = z
  .string()
  .regex(
    /^[a-z0-9]+:[a-zA-Z0-9]+$/,
    "network must be CAIP-2 (e.g. eip155:84532)",
  );

/** Either a fetchable OpenAPI URL or an inline OpenAPI 3.x document. */
export const OpenApiSourceSchema = z
  .object({
    openapiUrl: z.string().url().optional(),
    openapi: z.record(z.unknown()).optional(),
  })
  .refine(
    (v) =>
      (v.openapiUrl !== undefined && v.openapiUrl.length > 0) ||
      v.openapi !== undefined,
    { message: "provide openapiUrl or inline openapi" },
  );

export const CreateListingInputSchema = z
  .object({
    id: ListingIdSchema.optional(),
    name: z.string().min(1).max(256),
    description: z.string().max(4000).default(""),
    openapiUrl: z.string().url().optional(),
    openapi: z.record(z.unknown()).optional(),
    /** Default price in atomic units when listing has a single price. */
    price: AtomicAmountSchema,
    sellerId: z.string().min(1).max(128),
    payTo: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, "payTo must be an EVM address"),
    network: Caip2NetworkSchema,
    status: ListingStatusSchema.default("active"),
    /**
     * Upstream invoke base URL (where the store proxies paid calls).
     * For external x402 targets this is the live API origin.
     */
    upstreamBaseUrl: z.string().url().optional(),
    /**
     * Default HTTP path + method for invoke when the buyer does not override.
     */
    defaultPath: z.string().min(1).default("/"),
    defaultMethod: z
      .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
      .default("POST"),
    /**
     * When true, listing is documented as an external x402 target
     * (buyers may pay on-chain via @x402/fetch instead of store balance).
     */
    externalX402: z.boolean().default(false),
    /** Optional tags for catalog filtering. */
    tags: z.array(z.string().min(1).max(64)).max(32).default([]),
  })
  .refine(
    (v) =>
      (v.openapiUrl !== undefined && v.openapiUrl.length > 0) ||
      v.openapi !== undefined,
    { message: "provide openapiUrl or inline openapi", path: ["openapiUrl"] },
  );

export type CreateListingInput = z.input<typeof CreateListingInputSchema>;
export type CreateListingParsed = z.output<typeof CreateListingInputSchema>;

export const UpdateListingInputSchema = z
  .object({
    name: z.string().min(1).max(256).optional(),
    description: z.string().max(4000).optional(),
    openapiUrl: z.string().url().optional(),
    openapi: z.record(z.unknown()).optional(),
    price: AtomicAmountSchema.optional(),
    payTo: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .optional(),
    network: Caip2NetworkSchema.optional(),
    status: ListingStatusSchema.optional(),
    upstreamBaseUrl: z.string().url().optional(),
    defaultPath: z.string().min(1).optional(),
    defaultMethod: z
      .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
      .optional(),
    externalX402: z.boolean().optional(),
    tags: z.array(z.string().min(1).max(64)).max(32).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "at least one field required",
  });

export type UpdateListingInput = z.input<typeof UpdateListingInputSchema>;

export const ListingSchema = z.object({
  id: ListingIdSchema,
  name: z.string().min(1),
  description: z.string(),
  openapiUrl: z.string().url().nullable(),
  /** Serialized inline OpenAPI JSON when no URL (or cached snapshot). */
  openapiJson: z.string().nullable(),
  price: AtomicAmountSchema,
  sellerId: z.string().min(1),
  payTo: z.string(),
  network: Caip2NetworkSchema,
  status: ListingStatusSchema,
  upstreamBaseUrl: z.string().url().nullable(),
  defaultPath: z.string(),
  defaultMethod: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  externalX402: z.boolean(),
  tags: z.array(z.string()),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type Listing = z.infer<typeof ListingSchema>;

export const CatalogQuerySchema = z.object({
  status: ListingStatusSchema.optional(),
  sellerId: z.string().min(1).optional(),
  tag: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type CatalogQuery = z.input<typeof CatalogQuerySchema>;
