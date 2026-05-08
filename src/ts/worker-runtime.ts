import { AssRenderer } from './renderers'
import type { WrassWorkerRequest, WrassWorkerResponse } from './worker-client'

let renderer: AssRenderer | undefined
let currentCanvas: OffscreenCanvas | undefined

self.addEventListener('message', (event: MessageEvent<WrassWorkerRequest>) => {
  void handleRequest(event.data)
})

async function handleRequest(request: WrassWorkerRequest): Promise<void> {
  try {
    switch (request.type) {
      case 'init': {
        currentCanvas = request.canvas
        if (!currentCanvas) throw new Error('wrass worker init requires an OffscreenCanvas')
        renderer = new AssRenderer({
          ...request.options,
          canvas: currentCanvas as unknown as HTMLCanvasElement,
          offscreenRender: true,
          autoLoad: false,
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
  if (!renderer) throw new Error('wrass worker renderer is not initialized')
}

function post(response: WrassWorkerResponse): void {
  self.postMessage(response)
}
