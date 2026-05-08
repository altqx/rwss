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
})
