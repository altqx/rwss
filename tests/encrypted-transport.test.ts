import { describe, expect, test } from 'bun:test'

import { createEncryptedSubtitleContent, decryptSubtitleContent } from '../src/ts/crypto'

const SAMPLE = '[Script Info]\nTitle: encrypted\n'

describe('AkariSub-compatible encrypted subtitle transport', () => {
  test('packs AES-GCM chunks as IV-prefixed payloads and decrypts them back to subtitle text', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, false, ['encrypt', 'decrypt'])
    const encrypted = await createEncryptedSubtitleContent(SAMPLE, key)

    expect(encrypted.encrypted).toBeInstanceOf(ArrayBuffer)
    expect(encrypted.encrypted!.byteLength).toBeGreaterThan(SAMPLE.length + 12)
    await expect(decryptSubtitleContent(encrypted)).resolves.toBe(SAMPLE)
  })

  test('accepts raw AES-GCM key bytes for akari-crypto style handoff', async () => {
    const rawKey = crypto.getRandomValues(new Uint8Array(16))
    const encrypted = await createEncryptedSubtitleContent(SAMPLE, rawKey)

    await expect(decryptSubtitleContent(encrypted)).resolves.toBe(SAMPLE)
  })

  test('decrypts Akari v2 payloads with authenticated version and key-id headers', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const encrypted = await createAkariV2Payload(SAMPLE, key)

    await expect(decryptSubtitleContent({ contentKey: key, encrypted })).resolves.toBe(SAMPLE)
  })

  test('decrypts chunked Akari v2 payloads', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const encryptedChunks = await Promise.all([
      createAkariV2Payload('[Script Info]\n', key, 1),
      createAkariV2Payload('Title: chunked\n', key, 2)
    ])

    await expect(decryptSubtitleContent({ contentKey: key, encryptedChunks })).resolves.toBe(
      '[Script Info]\nTitle: chunked\n'
    )
  })
})

async function createAkariV2Payload(content: string, key: CryptoKey, keyIdSeed = 0): Promise<ArrayBuffer> {
  const header = new Uint8Array(9)
  header[0] = 2
  for (let index = 1; index < header.length; index++) header[index] = keyIdSeed + index
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: header, tagLength: 128 },
      key,
      new TextEncoder().encode(content)
    )
  )
  const payload = new Uint8Array(header.byteLength + nonce.byteLength + ciphertext.byteLength)
  payload.set(header)
  payload.set(nonce, header.byteLength)
  payload.set(ciphertext, header.byteLength + nonce.byteLength)
  return payload.buffer
}
