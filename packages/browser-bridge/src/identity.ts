/**
 * Identity of the bundled unpacked Chrome extensions. Manifest keys keep
 * these IDs stable across machines and rebuilds.
 */
export const BUNDLED_BROWSER_EXTENSION_ID = 'igjpillacopnacpepahjfaokiopahmee';
export const BUNDLED_BG_BROWSER_EXTENSION_ID = 'ckiomamppnakpgobcemidpojdiemfdlm';
export const BUNDLED_BROWSER_EXTENSION_IDS = [
  BUNDLED_BROWSER_EXTENSION_ID,
  BUNDLED_BG_BROWSER_EXTENSION_ID,
] as const;

/**
 * Shared loopback credential for the bundled desktop/extension pair.
 * Rotate this value together with DEFAULT_BRIDGE_TOKEN in background.js.
 */
export const BUNDLED_BROWSER_EXTENSION_TOKEN =
  'd63a1a9d927e268d5b3d0ac2450836c0fa90de2e55398ccb73ae888ecf35d97b';

export const DAFABET_PRAGMATIC_ROOM_ID = 'dafabet-pragmatic';
export const DAFABET_BG_ROOM_ID = 'dafabet-bg';

export function isLiveBridgeRoomId(roomId: string): boolean {
  return roomId === DAFABET_PRAGMATIC_ROOM_ID || roomId === DAFABET_BG_ROOM_ID;
}
