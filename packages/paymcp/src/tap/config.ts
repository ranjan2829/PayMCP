import { ConfigValidationError } from "../types/config.js";

/** Env var NAMES for TAP — values come from the operator environment only. */
export const TAP_ENV_KEYS = {
  required: "PAYMCP_TAP_REQUIRED",
  jwksUrl: "PAYMCP_TAP_JWKS_URL",
  maxWindowSeconds: "PAYMCP_TAP_MAX_WINDOW_SECONDS",
  /** Optional path to a local JWKS JSON file for offline / pinned keys (no secrets). */
  jwksPath: "PAYMCP_TAP_JWKS_PATH",
} as const;

export interface TapEnvConfig {
  /** When true, requests without a valid TAP signature fail closed. */
  readonly required: boolean;
  /** Visa/agent JWKS URL (e.g. https://mcp.visa.com/.well-known/jwks). */
  readonly jwksUrl?: string;
  readonly jwksPath?: string;
  readonly maxWindowSeconds?: number;
}

/**
 * Load TAP config from env. Does not require JWKS when TAP is off.
 * When required=true, at least one of jwksUrl / jwksPath must be set (or a custom lookup injected).
 */
export function loadTapConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TapEnvConfig {
  const required = isTruthy(env[TAP_ENV_KEYS.required]);
  const jwksUrl = optional(env, TAP_ENV_KEYS.jwksUrl);
  const jwksPath = optional(env, TAP_ENV_KEYS.jwksPath);
  const maxRaw = optional(env, TAP_ENV_KEYS.maxWindowSeconds);
  let maxWindowSeconds: number | undefined;
  if (maxRaw !== undefined) {
    const n = Number.parseInt(maxRaw, 10);
    if (!Number.isFinite(n) || n <= 0 || n > 3600) {
      throw new ConfigValidationError([
        `${TAP_ENV_KEYS.maxWindowSeconds} must be a positive integer ≤ 3600`,
      ]);
    }
    maxWindowSeconds = n;
  }

  if (required && jwksUrl === undefined && jwksPath === undefined) {
    throw new ConfigValidationError([
      `${TAP_ENV_KEYS.required}=1 needs ${TAP_ENV_KEYS.jwksUrl} or ${TAP_ENV_KEYS.jwksPath}`,
    ]);
  }

  if (jwksUrl !== undefined) {
    try {
      const u = new URL(jwksUrl);
      if (u.protocol !== "https:" && u.protocol !== "http:") {
        throw new Error("protocol");
      }
    } catch {
      throw new ConfigValidationError([
        `${TAP_ENV_KEYS.jwksUrl} must be a valid http(s) URL`,
      ]);
    }
  }

  return {
    required,
    ...(jwksUrl !== undefined ? { jwksUrl } : {}),
    ...(jwksPath !== undefined ? { jwksPath } : {}),
    ...(maxWindowSeconds !== undefined ? { maxWindowSeconds } : {}),
  };
}

function optional(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key];
  if (v === undefined || v.trim() === "") return undefined;
  return v.trim();
}

function isTruthy(v: string | undefined): boolean {
  if (v === undefined) return false;
  const t = v.trim().toLowerCase();
  return t === "1" || t === "true" || t === "yes" || t === "on";
}
