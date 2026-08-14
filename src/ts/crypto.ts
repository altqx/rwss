import type { EncryptedSubtitleContent } from './types'

const AKARI_PROTOCOL_VERSION_V2 = 2
const AKARI_KEY_ID_SIZE = 8
const AES_GCM_IV_SIZE = 12
const AES_GCM_TAG_SIZE = 16
const AKARI_V2_HEADER_SIZE = 1 + AKARI_KEY_ID_SIZE
const AKARI_V2_PAYLOAD_PREFIX_SIZE = AKARI_V2_HEADER_SIZE + AES_GCM_IV_SIZE

/** Raw AES-GCM key bytes accepted by the crypto helpers. */
export type RwssRawAesKey = Uint8Array | ArrayBuffer | ArrayBufferView

/** Import raw AES-GCM key bytes or pass through a CryptoKey. */
export async function importAesGcmKey(key: CryptoKey | RwssRawAesKey): Promise<CryptoKey> {
  if (isCryptoKey(key)) return key
  return crypto.subtle.importKey('raw', toArrayBuffer(key), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/** Encrypt subtitle text or bytes as IV-prefixed AES-GCM chunks. */
export async function createEncryptedSubtitleContent(content: string | Uint8Array | ArrayBuffer, key: CryptoKey | RwssRawAesKey): Promise<EncryptedSubtitleContent> {
  const contentKey = await importAesGcmKey(key)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plain = typeof content === 'string' ? new TextEncoder().encode(content) : toUint8Array(content)
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, contentKey, toArrayBuffer(plain)))
  const encrypted = new Uint8Array(iv.byteLength + ciphertext.byteLength)
  encrypted.set(iv, 0)
  encrypted.set(ciphertext, iv.byteLength)
  return { contentKey, encrypted: encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength) }
}

/** Decrypt an EncryptedSubtitleContent payload to UTF-8 text. */
export async function decryptSubtitleContent(content: EncryptedSubtitleContent): Promise<string> {
  const contentKey = await importAesGcmKey(content.contentKey)
  const chunks = content.encryptedChunks ?? (content.encrypted ? [content.encrypted] : [])
  if (chunks.length === 0) throw new Error('Encrypted subtitle content is empty')
  const parts: Uint8Array[] = []
  for (const chunk of chunks) {
    const bytes = new Uint8Array(chunk)
    const plain = await decryptSubtitleChunk(bytes, contentKey)
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

async function decryptSubtitleChunk(bytes: Uint8Array, contentKey: CryptoKey): Promise<ArrayBuffer> {
  if (isAkariV2Payload(bytes)) {
    const header = bytes.slice(0, AKARI_V2_HEADER_SIZE)
    const iv = bytes.slice(AKARI_V2_HEADER_SIZE, AKARI_V2_PAYLOAD_PREFIX_SIZE)
    const ciphertext = bytes.slice(AKARI_V2_PAYLOAD_PREFIX_SIZE)
    try {
      return await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: header, tagLength: 128 },
        contentKey,
        ciphertext
      )
    } catch (v2Error) {
      try {
        return await decryptLegacyChunk(bytes, contentKey)
      } catch {
        throw v2Error
      }
    }
  }
  return decryptLegacyChunk(bytes, contentKey)
}

function isAkariV2Payload(bytes: Uint8Array): boolean {
  return bytes.byteLength >= AKARI_V2_PAYLOAD_PREFIX_SIZE + AES_GCM_TAG_SIZE && bytes[0] === AKARI_PROTOCOL_VERSION_V2
}

async function decryptLegacyChunk(bytes: Uint8Array, contentKey: CryptoKey): Promise<ArrayBuffer> {
  if (bytes.byteLength < AES_GCM_IV_SIZE + 1) {
    throw new Error('Encrypted subtitle payload must be IV-prefixed AES-GCM data')
  }
  const iv = bytes.slice(0, AES_GCM_IV_SIZE)
  const ciphertext = bytes.slice(AES_GCM_IV_SIZE)
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, contentKey, ciphertext)
}

function isCryptoKey(key: CryptoKey | RwssRawAesKey): key is CryptoKey {
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
