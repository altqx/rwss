import { describe, expect, test } from 'bun:test'

import { getWasmUrl, isWasmInitialized } from '../src/ts/wasm'

describe('libbitsub-style WASM autoload defaults', () => {
  test('exposes a default wrass_bg.wasm URL before explicit initialization', () => {
    expect(isWasmInitialized()).toBe(false)
    expect(String(getWasmUrl())).toEndWith('/pkg/wrass_bg.wasm')
  })
})
