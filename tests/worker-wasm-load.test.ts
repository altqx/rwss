import { describe, expect, test } from 'bun:test'

import { AssRendererWorkerClient } from '../src/ts/worker-client'

class MockWorker {
  static initMessages: Array<{ type: string; wasmUrl?: string; glueUrl?: string }> = []
  private readonly listeners: Array<(event: MessageEvent) => void> = []

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    if (type === 'message') this.listeners.push(listener)
  }

  postMessage(message: { id: number; type: string; wasmUrl?: string; glueUrl?: string }): void {
    if (message.type === 'init') {
      MockWorker.initMessages.push({
        type: message.type,
        wasmUrl: message.wasmUrl,
        glueUrl: message.glueUrl
      })
    }
    queueMicrotask(() => {
      for (const listener of this.listeners) {
        listener({ data: { id: message.id, type: 'ready' } } as MessageEvent)
      }
    })
  }

  terminate(): void {}
}

describe('libbitsub-style worker WASM loading', () => {
  test('sends package wasm and glue URLs during worker initialization', async () => {
    MockWorker.initMessages = []
    const client = new AssRendererWorkerClient({
      worker: new MockWorker() as unknown as Worker,
      canvas: { width: 2, height: 2 } as OffscreenCanvas,
      subContent: '[Script Info]\n'
    })

    await client.ready
    const initMessage = MockWorker.initMessages.at(-1)
    expect(initMessage?.type).toBe('init')
    expect(initMessage?.wasmUrl).toContain('rwss_bg.wasm')
    expect(initMessage?.glueUrl).toContain('rwss')
    expect(initMessage?.glueUrl?.endsWith('.js')).toBe(true)
    client.destroy()
  })

  test('derives glue URL when a custom wasm URL is supplied', async () => {
    MockWorker.initMessages = []
    const client = new AssRendererWorkerClient({
      worker: new MockWorker() as unknown as Worker,
      canvas: { width: 2, height: 2 } as OffscreenCanvas,
      wasmUrl: 'https://cdn.example/rwss/rwss_bg.wasm'
    })

    await client.ready
    expect(MockWorker.initMessages.at(-1)).toEqual({
      type: 'init',
      wasmUrl: 'https://cdn.example/rwss/rwss_bg.wasm',
      glueUrl: 'https://cdn.example/rwss/rwss.js'
    })
    client.destroy()
  })
})
