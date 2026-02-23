const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
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

export function generateId(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}_${nextSequence()}_${randomString(12)}`
}
