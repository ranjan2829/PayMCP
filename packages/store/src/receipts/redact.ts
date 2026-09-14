/**
 * Public-facing buyer id: keep prefix/suffix, mask the middle.
 * Never expose full buyer identifiers on the public receipt surface.
 */
export function redactBuyerId(buyerId: string): string {
  if (buyerId.length <= 8) {
    return `${buyerId.slice(0, 2)}…${buyerId.slice(-2)}`;
  }
  return `${buyerId.slice(0, 4)}…${buyerId.slice(-4)}`;
}
