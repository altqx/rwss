import { describe, expect, test } from 'bun:test'

import { getWasmGlueUrl, getWasmUrl, isWasmInitialized, resolveWasmLoadUrls } from '../src/ts/wasm'

describe('libbitsub-style WASM autoload defaults', () => {
  test('exposes default rwss wasm and glue URLs before explicit initialization', () => {
    expect(isWasmInitialized()).toBe(false)
    expect(getWasmUrl()).toEndWith('/pkg/rwss_bg.wasm')
    expect(getWasmGlueUrl()).toEndWith('/pkg/rwss.js')
  })

  test('derives worker glue URL from a custom wasm URL', () => {
    expect(resolveWasmLoadUrls('https://cdn.example/rwss/rwss_bg.wasm')).toEqual({
      wasmUrl: 'https://cdn.example/rwss/rwss_bg.wasm',
      glueUrl: 'https://cdn.example/rwss/rwss.js'
    })
    expect(resolveWasmLoadUrls('/pkg/rwss_bg.wasm')).toEqual({
      wasmUrl: '/pkg/rwss_bg.wasm',
      glueUrl: '/pkg/rwss.js'
    })
  })
})
