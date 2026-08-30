/** Strict, non-throwing parser for the verified mstrom binary frame format. */

export type MstromProtobufField =
  | { readonly fieldNumber: number; readonly wireType: 0; readonly value: bigint }
  | { readonly fieldNumber: number; readonly wireType: 1 | 2 | 5; readonly value: Uint8Array };
export interface MstromFrameHeader { readonly type: number; readonly x16: number; readonly totalLength: number; readonly seq: number }
export interface MstromMarket { readonly marketId: number; readonly bettorCount: number; readonly amount: number }
export interface MstromType3Status {
  readonly countdown: number | undefined;
  readonly phase: number | undefined;
  readonly counterA: number | undefined;
  readonly counterC: number | undefined;
  readonly totalAmount: number | undefined;
  readonly rawHeader: Uint8Array;
  readonly statusLength: number;
  readonly markets: readonly MstromMarket[];
}
interface MstromFrameBase extends MstromFrameHeader { readonly tableId: string; readonly payload: Uint8Array }
export interface MstromType2Frame extends MstromFrameBase {
  readonly kind: 'type2'; readonly type: 2; readonly gameType: string | undefined; readonly roundId: string | undefined;
  /** CommonProto.GameSnapshot.gmstatus. Kept as phase for compatibility. */
  readonly gameStatus: number | undefined; readonly phase: number | undefined;
  readonly bankerScore: number | undefined; readonly playerScore: number | undefined;
  readonly resultCode: number | undefined; readonly resultPayload: Uint8Array | undefined;
  readonly roadCounter: number | undefined; readonly roadData: Uint8Array | undefined;
  readonly fields: readonly MstromProtobufField[];
}
export interface MstromType3Frame extends MstromFrameBase { readonly kind: 'type3'; readonly type: 3; readonly gameType: string | undefined; readonly status: MstromType3Status }
export type MstromFrame = MstromType2Frame | MstromType3Frame;
export type MstromParseErrorCode = 'invalid-input' | 'truncated-header' | 'invalid-total-length' | 'length-mismatch' | 'unsupported-frame-type' | 'table-id-not-found' | 'malformed-protobuf' | 'unsupported-wire-type';
export interface MstromParseError { readonly code: MstromParseErrorCode; readonly message: string; readonly offset: number | undefined }
export interface MstromParseSuccess { readonly ok: true; readonly kind: 'success'; readonly frame: MstromFrame }
export interface MstromParseFailure { readonly ok: false; readonly kind: 'error'; readonly error: MstromParseError }
export type MstromParseResult = MstromParseSuccess | MstromParseFailure;

interface TableLocation { readonly tableId: string; readonly start: number; readonly end: number }
interface InternalSuccess<T> { readonly ok: true; readonly value: T }
interface InternalFailure { readonly ok: false; readonly error: MstromParseError }
type InternalResult<T> = InternalSuccess<T> | InternalFailure;
interface Varint { readonly value: bigint; readonly next: number }
interface ParsedField { readonly field: MstromProtobufField; readonly next: number }
const GAME_TYPES = ['BAC', 'LBAC', 'ROU', 'DT', 'BJ', 'ZJH', 'SG', 'LBA', 'SHB', 'NN'] as const;
const MAX_FIELD_NUMBER = 0x1fffffff;

function success<T>(value: T): InternalSuccess<T> { return { ok: true, value }; }
function failure(code: MstromParseErrorCode, message: string, offset?: number): InternalFailure { return { ok: false, error: { code, message, offset } }; }
function isDigit(value: number | undefined): boolean { return value !== undefined && value >= 48 && value <= 57; }
function isUpper(value: number | undefined): boolean { return value !== undefined && value >= 65 && value <= 90; }
function ascii(bytes: Uint8Array): string { let text = ''; for (const byte of bytes) text += String.fromCharCode(byte); return text; }
function knownGameType(value: string): boolean { for (const candidate of GAME_TYPES) if (candidate === value) return true; return false; }
function safeNumber(value: bigint): number | undefined { const number = Number(value); return Number.isSafeInteger(number) ? number : undefined; }
function readU16(bytes: Uint8Array, offset: number): number { return (bytes[offset] << 8) | bytes[offset + 1]; }
function readDouble(bytes: Uint8Array, offset: number): number { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(offset, false); }

export function findTableKey(bytes: Uint8Array): TableLocation | null {
  const lastStart = Math.min(20, bytes.length - 3);
  for (let start = 12; start <= lastStart; start += 1) {
    const prefix = bytes[start];
    if (!isUpper(prefix)) continue;
    let end = start + 1;
    while (end < bytes.length && end - start <= 4 && isDigit(bytes[end])) end += 1;
    const digits = end - start - 1;
    if (digits >= 2 && digits <= 4 && !isDigit(bytes[end])) return { tableId: ascii(bytes.slice(start, end)), start, end };
  }
  return null;
}
export const findTableId = findTableKey;

function readVarint(bytes: Uint8Array, offset: number): InternalResult<Varint> {
  let value = 0n; let shift = 0n; let position = offset;
  for (let index = 0; index < 10; index += 1) {
    const byte = bytes[position];
    if (byte === undefined) return failure('malformed-protobuf', 'truncated protobuf varint', position);
    if (index === 9 && byte > 1) return failure('malformed-protobuf', 'protobuf varint exceeds 64 bits', position);
    value |= BigInt(byte & 0x7f) << shift; position += 1;
    if ((byte & 0x80) === 0) return success({ value, next: position });
    shift += 7n;
  }
  return failure('malformed-protobuf', 'protobuf varint exceeds 64 bits', position);
}

function readField(bytes: Uint8Array, offset: number): InternalResult<ParsedField> {
  const tag = readVarint(bytes, offset);
  if (!tag.ok) return tag;
  const fieldNumber = Number(tag.value.value >> 3n); const wireType = Number(tag.value.value & 7n);
  if (fieldNumber < 1 || fieldNumber > MAX_FIELD_NUMBER) return failure('malformed-protobuf', 'invalid protobuf field number', offset);
  let position = tag.value.next;
  if (wireType === 0) {
    const value = readVarint(bytes, position);
    if (!value.ok) return value;
    return success({ field: { fieldNumber, wireType: 0, value: value.value.value }, next: value.value.next });
  }
  if (wireType === 1 || wireType === 5) {
    const width = wireType === 1 ? 8 : 4;
    if (position + width > bytes.length) return failure('malformed-protobuf', 'truncated fixed protobuf field', position);
    return success({ field: { fieldNumber, wireType, value: bytes.slice(position, position + width) }, next: position + width });
  }
  if (wireType === 2) {
    const length = readVarint(bytes, position);
    if (!length.ok) return length;
    position = length.value.next;
    if (length.value.value > BigInt(bytes.length - position)) return failure('malformed-protobuf', 'truncated length-delimited protobuf field', position);
    const size = Number(length.value.value);
    return success({ field: { fieldNumber, wireType: 2, value: bytes.slice(position, position + size) }, next: position + size });
  }
  return failure('unsupported-wire-type', `unsupported protobuf wire type ${wireType}`, offset);
}

function parseType2(bytes: Uint8Array, header: MstromFrameHeader, location: TableLocation): InternalResult<MstromType2Frame> {
  const payload = bytes.slice(location.end); const fields: MstromProtobufField[] = []; let offset = 0;
  while (offset < payload.length) {
    const parsed = readField(payload, offset);
    if (!parsed.ok) return parsed;
    fields.push(parsed.value.field); offset = parsed.value.next;
  }
  let gameType: string | undefined; let roundId: string | undefined; let gameStatus: number | undefined;
  let bankerScore: number | undefined; let playerScore: number | undefined; let resultCode: number | undefined; let resultPayload: Uint8Array | undefined;
  let roadCounter: number | undefined; let roadData: Uint8Array | undefined;
  for (const field of fields) {
    switch (field.wireType) {
      case 0: {
        const value = safeNumber(field.value);
        if (field.fieldNumber === 2 && header.x16 === 0x1008) roadCounter = value;
        if (field.fieldNumber === 3) gameStatus = value;
        if (field.fieldNumber === 4) bankerScore = value;
        if (field.fieldNumber === 5) playerScore = value;
        break;
      }
      case 1: case 5: break;
      case 2: {
        const text = ascii(field.value);
        if ((field.fieldNumber === 1 || field.fieldNumber === 4) && gameType === undefined && knownGameType(text)) gameType = text;
        if (field.fieldNumber === 2 && roundId === undefined && /^G[A-Z]\d{2,4}/.test(text)) roundId = text;
        if (field.fieldNumber === 3 && header.x16 === 0x1008) roadData = field.value.slice();
        if (field.fieldNumber === 10 && field.value.length > 0) { resultPayload = field.value.slice(); resultCode = field.value[0]; }
        break;
      }
      default: return failure('malformed-protobuf', 'internal wire type mismatch');
    }
  }
  return success({ ...header, kind: 'type2', type: 2, tableId: location.tableId, payload, gameType, roundId, gameStatus, phase: gameStatus, bankerScore, playerScore, resultCode, resultPayload, roadCounter, roadData, fields });
}

function parseType3Status(bytes: Uint8Array): MstromType3Status {
  let countdown: number | undefined; let phase: number | undefined;
  let counterA: number | undefined; let counterC: number | undefined;
  if (bytes.length >= 7) {
    counterA = readU16(bytes, 1);
    counterC = readU16(bytes, 5);
    if (bytes[3] === 0 && bytes[5] === 0 && bytes[2] === bytes[6]) {
      countdown = bytes[2];
      phase = bytes[4];
    }
  }
  const totalAmount = bytes.length >= 19 ? readDouble(bytes, 11) : undefined;
  const rawHeader = bytes.slice(0, Math.min(20, bytes.length));
  const markets: MstromMarket[] = []; const count = bytes[19];
  if (count !== undefined && bytes.length >= 20 && count <= 32 && 20 + count * 12 <= bytes.length) {
    for (let index = 0; index < count; index += 1) {
      const offset = 20 + index * 12; const amount = readDouble(bytes, offset + 4);
      if (!Number.isFinite(amount)) return { countdown, phase, counterA, counterC, totalAmount, rawHeader, statusLength: bytes.length, markets: [] };
      markets.push({ marketId: readU16(bytes, offset), bettorCount: readU16(bytes, offset + 2), amount });
    }
  }
  return { countdown, phase, counterA, counterC, totalAmount, rawHeader, statusLength: bytes.length, markets };
}

function parseType3(bytes: Uint8Array, header: MstromFrameHeader, location: TableLocation): InternalResult<MstromType3Frame> {
  const payload = bytes.slice(location.end); let gameEnd = 0;
  while (gameEnd < payload.length && isUpper(payload[gameEnd])) gameEnd += 1;
  const gameType = gameEnd >= 2 ? ascii(payload.slice(0, gameEnd)) : undefined;
  return success({ ...header, kind: 'type3', type: 3, tableId: location.tableId, payload, gameType, status: parseType3Status(payload.slice(gameEnd)) });
}

export function parseMstromFrame(input: Uint8Array): MstromParseResult {
  if (!(input instanceof Uint8Array)) return { ok: false, kind: 'error', error: { code: 'invalid-input', message: 'input must be Uint8Array', offset: undefined } };
  if (input.length < 12) return { ok: false, kind: 'error', error: { code: 'truncated-header', message: 'frame header requires 12 bytes', offset: input.length } };
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const header: MstromFrameHeader = { type: view.getUint16(0, false), x16: view.getUint16(2, false), totalLength: view.getUint32(4, false), seq: view.getUint32(8, false) };
  if (header.totalLength === 0) return { ok: false, kind: 'error', error: { code: 'invalid-total-length', message: 'frame totalLength must be non-zero', offset: 4 } };
  if (header.totalLength !== input.length) return { ok: false, kind: 'error', error: { code: 'length-mismatch', message: `totalLength ${header.totalLength} does not match input length ${input.length}`, offset: 4 } };
  if (header.type !== 2 && header.type !== 3) return { ok: false, kind: 'error', error: { code: 'unsupported-frame-type', message: `unsupported mstrom frame type ${header.type}`, offset: 0 } };
  const location = findTableKey(input);
  if (!location) return { ok: false, kind: 'error', error: { code: 'table-id-not-found', message: 'table id not found at offsets 12..20', offset: 12 } };
  const parsed = header.type === 2 ? parseType2(input, header, location) : parseType3(input, header, location);
  if (!parsed.ok) return { ok: false, kind: 'error', error: parsed.error };
  return { ok: true, kind: 'success', frame: parsed.value };
}

export const parseFrame = parseMstromFrame;
