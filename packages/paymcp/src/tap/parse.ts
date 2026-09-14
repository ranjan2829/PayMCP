import {
  TAP_TAGS,
  TapVerificationError,
  type TapSignature,
  type TapSignatureInput,
  type TapTag,
} from "./types.js";

/**
 * Parse RFC 9421 Signature-Input dictionary (subset used by TAP).
 * Example:
 *   sig2=("@authority" "@path");created=…;expires=…;keyid="…";alg="Ed25519";nonce="…";tag="agent-payer-auth"
 */
export function parseSignatureInputHeader(header: string): TapSignatureInput[] {
  const trimmed = header.trim();
  if (trimmed.length === 0) {
    throw new TapVerificationError("missing_signature_input", "Signature-Input is empty");
  }
  const entries: TapSignatureInput[] = [];
  for (const part of splitDictionaryMembers(trimmed)) {
    entries.push(parseOneSignatureInput(part));
  }
  if (entries.length === 0) {
    throw new TapVerificationError("missing_signature_input", "Signature-Input has no entries");
  }
  return entries;
}

export function parseSignatureHeader(header: string): TapSignature[] {
  const trimmed = header.trim();
  if (trimmed.length === 0) {
    throw new TapVerificationError("missing_signature", "Signature is empty");
  }
  const out: TapSignature[] = [];
  for (const part of splitDictionaryMembers(trimmed)) {
    const eq = part.indexOf("=");
    if (eq <= 0) {
      throw new TapVerificationError("invalid_signature", `bad Signature member: ${part}`);
    }
    const label = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    const m = /^:([A-Za-z0-9+/=]+):$/.exec(value);
    if (m === null || m[1] === undefined) {
      throw new TapVerificationError(
        "invalid_signature",
        `Signature value must be sf-binary :base64: for ${label}`,
      );
    }
    out.push({ label, signatureBase64: m[1] });
  }
  if (out.length === 0) {
    throw new TapVerificationError("missing_signature", "Signature has no entries");
  }
  return out;
}

function parseOneSignatureInput(raw: string): TapSignatureInput {
  const eq = raw.indexOf("=");
  if (eq <= 0) {
    throw new TapVerificationError("invalid_signature_input", `bad Signature-Input: ${raw}`);
  }
  const label = raw.slice(0, eq).trim();
  const rest = raw.slice(eq + 1).trim();
  const listMatch = /^\(([^)]*)\)(.*)$/.exec(rest);
  if (listMatch === null || listMatch[1] === undefined || listMatch[2] === undefined) {
    throw new TapVerificationError(
      "invalid_signature_input",
      `Signature-Input ${label} missing covered-components list`,
    );
  }
  const coveredComponents = [...listMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  if (coveredComponents.length === 0) {
    throw new TapVerificationError(
      "invalid_signature_input",
      `Signature-Input ${label} has empty covered components`,
    );
  }
  const paramsInner = rest; // includes (…);params — used in @signature-params
  const attrs = parseAttributes(listMatch[2]);

  const created = requireIntAttr(attrs, "created", label);
  const expires = requireIntAttr(attrs, "expires", label);
  const keyid = requireStringAttr(attrs, ["keyid", "keyId"], label);
  const alg = requireStringAttr(attrs, ["alg"], label);
  const nonce = requireStringAttr(attrs, ["nonce"], label);
  const tagRaw = requireStringAttr(attrs, ["tag"], label);
  if (!isTapTag(tagRaw)) {
    throw new TapVerificationError(
      "invalid_tag",
      `tag must be agent-browser-auth or agent-payer-auth (got ${tagRaw})`,
    );
  }

  return {
    label,
    coveredComponents,
    created,
    expires,
    keyid,
    alg,
    nonce,
    tag: tagRaw,
    paramsInner,
  };
}

function isTapTag(v: string): v is TapTag {
  return (TAP_TAGS as readonly string[]).includes(v);
}

function parseAttributes(suffix: string): Map<string, string | number | boolean> {
  const map = new Map<string, string | number | boolean>();
  // ;key=value or ;key="value"
  const re = /;([a-zA-Z0-9_-]+)(?:=([^;]*))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(suffix)) !== null) {
    const key = m[1]!;
    const rawVal = m[2];
    if (rawVal === undefined) {
      map.set(key, true);
      continue;
    }
    const v = rawVal.trim();
    if (v.startsWith('"') && v.endsWith('"')) {
      map.set(key, v.slice(1, -1));
    } else if (/^-?\d+$/.test(v)) {
      map.set(key, Number.parseInt(v, 10));
    } else {
      map.set(key, v);
    }
  }
  return map;
}

function requireIntAttr(
  attrs: Map<string, string | number | boolean>,
  key: string,
  label: string,
): number {
  const v = attrs.get(key);
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new TapVerificationError(
      "missing_field",
      `Signature-Input ${label} missing integer ${key}`,
    );
  }
  return v;
}

function requireStringAttr(
  attrs: Map<string, string | number | boolean>,
  keys: readonly string[],
  label: string,
): string {
  for (const key of keys) {
    const v = attrs.get(key);
    if (typeof v === "string" && v.length > 0) {
      return v;
    }
  }
  throw new TapVerificationError(
    "missing_field",
    `Signature-Input ${label} missing ${keys.join("/")}`,
  );
}

/** Split sf-dictionary top-level members on commas not inside quotes/parens. */
function splitDictionaryMembers(input: string): string[] {
  const parts: string[] = [];
  let depthParen = 0;
  let inQuote = false;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === '"' && input[i - 1] !== "\\") {
      inQuote = !inQuote;
    } else if (!inQuote) {
      if (ch === "(") depthParen += 1;
      else if (ch === ")") depthParen -= 1;
      else if (ch === "," && depthParen === 0) {
        const slice = input.slice(start, i).trim();
        if (slice.length > 0) parts.push(slice);
        start = i + 1;
      }
    }
  }
  const last = input.slice(start).trim();
  if (last.length > 0) parts.push(last);
  return parts;
}
