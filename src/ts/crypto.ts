import type { EncryptedSubtitleContent } from './types'

export type WrassRawAesKey = Uint8Array | ArrayBuffer | ArrayBufferView

export async function importAesGcmKey(key: CryptoKey | WrassRawAesKey): Promise<CryptoKey> {
  if (isCryptoKey(key)) return key
  return crypto.subtle.importKey('raw', toArrayBuffer(key), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function createEncryptedSubtitleContent(content: string | Uint8Array | ArrayBuffer, key: CryptoKey | WrassRawAesKey): Promise<EncryptedSubtitleContent> {
  const contentKey = await importAesGcmKey(key)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plain = typeof content === 'string' ? new TextEncoder().encode(content) : toUint8Array(content)
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, contentKey, toArrayBuffer(plain)))
  const encrypted = new Uint8Array(iv.byteLength + ciphertext.byteLength)
  encrypted.set(iv, 0)
  encrypted.set(ciphertext, iv.byteLength)
  return { contentKey, encrypted: encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength) }
}

export async function decryptSubtitleContent(content: EncryptedSubtitleContent): Promise<string> {
  const contentKey = await importAesGcmKey(content.contentKey)
  const chunks = content.encryptedChunks ?? (content.encrypted ? [content.encrypted] : [])
  if (chunks.length === 0) throw new Error('Encrypted subtitle content is empty')
  const parts: Uint8Array[] = []
  for (const chunk of chunks) {
    const bytes = new Uint8Array(chunk)
    if (bytes.byteLength < 13) throw new Error('Encrypted subtitle payload must be IV-prefixed AES-GCM data')
    const iv = bytes.slice(0, 12)
    const ciphertext = bytes.slice(12)
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, contentKey, ciphertext)
    parts.push(new Uint8Array(plain))
  }
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const joined = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.byteLength
  }
  return new TextDecoder().decode(joined)
}

function isCryptoKey(key: CryptoKey | WrassRawAesKey): key is CryptoKey {
  return typeof CryptoKey !== 'undefined' && key instanceof CryptoKey
}

function toArrayBuffer(data: Uint8Array | ArrayBuffer | ArrayBufferView): ArrayBuffer {
  const bytes = toUint8Array(data)
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function toUint8Array(data: Uint8Array | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}
