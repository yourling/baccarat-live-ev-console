export function createHash(_algorithm: string) {
  return {
    update(_data?: unknown) {
      return this;
    },
    digest(_encoding?: string) {
      return '';
    },
  };
}

export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}
