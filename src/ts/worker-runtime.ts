import { AssRenderer } from './renderers'
import { initWasm } from './wasm'
import type { RwssWorkerRequest, RwssWorkerResponse } from './worker-client'

let renderer: AssRenderer | undefined
let currentCanvas: OffscreenCanvas | undefined

self.addEventListener('message', (event: MessageEvent<RwssWorkerRequest>) => {
  void handleRequest(event.data)
})

async function handleRequest(request: RwssWorkerRequest): Promise<void> {
  try {
    switch (request.type) {
      case 'init': {
        currentCanvas = request.canvas
        if (!currentCanvas) throw new Error('rwss worker init requires an OffscreenCanvas')
        await initWasm(request.wasmUrl, request.glueUrl)
        renderer = new AssRenderer({
          ...request.options,
          canvas: currentCanvas as unknown as HTMLCanvasElement,
          offscreenRender: true,
          autoLoad: false,
          wasmUrl: undefined,
          onEvent: (rendererEvent) => post({ id: request.id, type: 'event', event: rendererEvent })
        })
        await renderer.load()
        post({ id: request.id, type: 'ready' })
        break
      }
      case 'render': {
        assertRenderer()
        const start = performance.now()
        renderer!.setCurrentTime(undefined, request.time, undefined)
        post({ id: request.id, type: 'rendered', time: request.time, compositionCount: 0, renderTime: performance.now() - start })
        break
      }
      case 'set-track':
        assertRenderer()
        renderer!.setTrack(request.content)
        post({ id: request.id, type: 'ok' })
        break
      case 'stats':
        assertRenderer()
        post({ id: request.id, type: 'stats', stats: await renderer!.getStats() })
        break
      case 'reset-stats':
        assertRenderer()
        await renderer!.resetStats()
        post({ id: request.id, type: 'ok' })
        break
      case 'destroy':
        renderer?.destroy()
        renderer = undefined
        post({ id: request.id, type: 'ok' })
        break
    }
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error))
    post({ id: request.id, type: 'error', message: normalized.message, stack: normalized.stack })
  }
}

function assertRenderer(): void {
  if (!renderer) throw new Error('rwss worker renderer is not initialized')
}

function post(response: RwssWorkerResponse): void {
  self.postMessage(response)
}
