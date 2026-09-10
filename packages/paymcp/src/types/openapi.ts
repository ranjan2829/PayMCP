export interface OpenApiParameter {
  readonly name: string;
  readonly in: "query" | "header" | "path" | "cookie";
  readonly required?: boolean;
  readonly description?: string;
  readonly schema?: OpenApiSchema;
}

export interface OpenApiSchema {
  readonly type?: string;
  readonly format?: string;
  readonly properties?: Readonly<Record<string, OpenApiSchema>>;
  readonly required?: readonly string[];
  readonly items?: OpenApiSchema;
  readonly description?: string;
  readonly enum?: readonly (string | number | boolean)[];
  readonly default?: string | number | boolean | null;
}

export interface OpenApiRequestBody {
  readonly required?: boolean;
  readonly description?: string;
  readonly content?: Readonly<
    Record<string, { readonly schema?: OpenApiSchema }>
  >;
}

export interface OpenApiOperation {
  readonly operationId?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly parameters?: readonly OpenApiParameter[];
  readonly requestBody?: OpenApiRequestBody;
  readonly "x-paymcp"?: {
    readonly amount: string;
    readonly description?: string;
    readonly paid?: boolean;
  };
}

export type HttpMethod =
  | "get"
  | "post"
  | "put"
  | "patch"
  | "delete"
  | "head"
  | "options";

export interface OpenApiPathItem {
  readonly summary?: string;
  readonly description?: string;
  readonly get?: OpenApiOperation;
  readonly post?: OpenApiOperation;
  readonly put?: OpenApiOperation;
  readonly patch?: OpenApiOperation;
  readonly delete?: OpenApiOperation;
  readonly head?: OpenApiOperation;
  readonly options?: OpenApiOperation;
}

export interface OpenApiDocument {
  readonly openapi: string;
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly description?: string;
  };
  readonly servers?: readonly { readonly url: string; readonly description?: string }[];
  readonly paths: Readonly<Record<string, OpenApiPathItem>>;
}

export interface CompiledOperation {
  readonly operationId: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly summary: string;
  readonly description: string;
  readonly parameters: readonly OpenApiParameter[];
  readonly requestBody: OpenApiRequestBody | undefined;
  readonly amount: string | undefined;
  readonly paid: boolean;
}
