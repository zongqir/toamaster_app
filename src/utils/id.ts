const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const HEX_ALPHABET = '0123456789abcdef'
let idSequence = 0

function secureRandomInt(max: number): number {
  if (max <= 0) return 0

  const cryptoObj = (globalThis as {crypto?: Crypto}).crypto
  if (cryptoObj?.getRandomValues) {
    const buffer = new Uint32Array(1)
    cryptoObj.getRandomValues(buffer)
    return buffer[0] % max
  }

  return Math.floor(Math.random() * max)
}

function randomString(length: number): string {
  let result = ''
  for (let i = 0; i < length; i++) {
    result += ID_ALPHABET[secureRandomInt(ID_ALPHABET.length)]
  }
  return result
}

function nextSequence(): string {
  idSequence = (idSequence + 1) % 1679616 // 36^4
  return idSequence.toString(36).padStart(4, '0')
}

function fillRandomBytes(buffer: Uint8Array) {
  const cryptoObj = (globalThis as {crypto?: Crypto}).crypto
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(buffer)
    return
  }

  for (let i = 0; i < buffer.length; i++) {
    buffer[i] = secureRandomInt(256)
  }
}

function byteToHex(byte: number): string {
  return `${HEX_ALPHABET[(byte >> 4) & 0x0f]}${HEX_ALPHABET[byte & 0x0f]}`
}

export function generateId(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}_${nextSequence()}_${randomString(12)}`
}

export function generateUuid(): string {
  const cryptoObj = (globalThis as {crypto?: Crypto & {randomUUID?: () => string}}).crypto
  if (cryptoObj?.randomUUID) {
    return cryptoObj.randomUUID()
  }

  const bytes = new Uint8Array(16)
  fillRandomBytes(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex = Array.from(bytes, byteToHex)
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
}

export function isUuid(value: string | null | undefined): boolean {
  if (!value) return false
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}
