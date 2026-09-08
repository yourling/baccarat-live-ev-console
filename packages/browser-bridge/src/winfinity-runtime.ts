export const WINFINITY_STREAM_ID_PATTERN = /^[a-z0-9]+-bac\d+$/i;
export const WINFINITY_FALLBACK_TABLE_ID_PATTERN = /^wnf-[a-f0-9]{24}$/i;
export const WINFINITY_VENDOR_TABLE_ID_PATTERN = /^[a-f0-9]{24}$/i;

export function publicWinfinityTableId(input: {
  readonly streamId?: string;
  readonly vendorTableId?: string;
}): string | undefined {
  const streamId = input.streamId?.trim().toLowerCase();
  if (streamId && WINFINITY_STREAM_ID_PATTERN.test(streamId)) return streamId;
  const vendor = input.vendorTableId?.trim().toLowerCase();
  if (vendor && WINFINITY_VENDOR_TABLE_ID_PATTERN.test(vendor)) return `wnf-${vendor}`;
  return undefined;
}

export function normalizeWinfinityTableId(tableId: string): string | undefined {
  const trimmed = tableId.trim().toLowerCase();
  if (WINFINITY_STREAM_ID_PATTERN.test(trimmed)) return trimmed;
  if (WINFINITY_FALLBACK_TABLE_ID_PATTERN.test(trimmed)) return trimmed;
  return undefined;
}

export class WinfinityRuntimeParser {
  private readonly lockedByVendor = new Map<string, string>();

  registerAlias(vendorTableId: string, streamId: string): void {
    const vendor = vendorTableId.trim().toLowerCase();
    if (!WINFINITY_VENDOR_TABLE_ID_PATTERN.test(vendor)) return;
    if (this.lockedByVendor.has(vendor)) return;
    const publicId = publicWinfinityTableId({ streamId, vendorTableId: vendor });
    if (publicId === undefined) return;
    this.lockedByVendor.set(vendor, publicId);
  }

  resolveTableId(vendorTableId: string): string | undefined {
    const vendor = vendorTableId.trim().toLowerCase();
    if (!WINFINITY_VENDOR_TABLE_ID_PATTERN.test(vendor)) return undefined;
    const locked = this.lockedByVendor.get(vendor);
    if (locked !== undefined) return locked;
    const publicId = publicWinfinityTableId({ vendorTableId: vendor });
    if (publicId === undefined) return undefined;
    this.lockedByVendor.set(vendor, publicId);
    return publicId;
  }
}
