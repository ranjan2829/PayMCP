/**
 * Block-explorer URLs for known Base networks (CAIP-2).
 * Returns null when the network is unknown or tx is missing.
 */

const EXPLORERS: Readonly<Record<string, string>> = {
  "eip155:84532": "https://sepolia.basescan.org/tx",
  "eip155:8453": "https://basescan.org/tx",
};

export function explorerTxUrl(
  network: string,
  txHash: string | null | undefined,
): string | null {
  if (txHash === null || txHash === undefined || txHash.length === 0) {
    return null;
  }
  // Only link real 0x tx hashes (recording fixtures may use non-hex labels).
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return null;
  }
  const base = EXPLORERS[network];
  if (base === undefined) {
    return null;
  }
  return `${base}/${txHash}`;
}

export function networkLabel(network: string): string {
  if (network === "eip155:84532") {
    return "Base Sepolia";
  }
  if (network === "eip155:8453") {
    return "Base";
  }
  return network;
}
