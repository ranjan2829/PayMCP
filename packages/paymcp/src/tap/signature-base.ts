import type { TapSignatureInput } from "./types.js";

/**
 * Build RFC 9421 signature base for TAP-required covered components.
 * Aligns with Visa sample: @authority, @path, then "@signature-params".
 */
export function buildTapSignatureBase(args: {
  readonly authority: string;
  readonly path: string;
  readonly input: TapSignatureInput;
}): string {
  const { authority, path, input } = args;
  const lines: string[] = [];
  for (const component of input.coveredComponents) {
    if (component === "@authority") {
      lines.push(`@authority: ${authority}`);
    } else if (component === "@path") {
      lines.push(`@path: ${path}`);
    } else {
      // Unsupported covered component — fail closed at verify time by throwing here.
      throw new Error(`unsupported covered component: ${component}`);
    }
  }
  // @signature-params uses the inner params (covered list + attributes), not the label.
  lines.push(`"@signature-params": ${input.paramsInner}`);
  return lines.join("\n");
}
