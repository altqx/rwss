import type { PerformanceStats, VideoAssSubtitleOptions, RwssFontSource, RwssRendererEvent } from './types'
import { resolveWasmLoadUrls } from './wasm'

/** Request posted to AssRendererWorkerClient. */
export type RwssWorkerRequest =
  | { id: number; type: 'init'; options: SerializableWorkerOptions; canvas?: OffscreenCanvas; wasmUrl: string; glueUrl: string }
  | { id: number; type: 'render'; time: number; force?: boolean }
  | { id: number; type: 'set-track'; content: string | Uint8Array | ArrayBuffer }
  | { id: number; type: 'stats' }
  | { id: number; type: 'reset-stats' }
  | { id: number; type: 'destroy' }

/** Response posted from the worker client runtime. */
export type RwssWorkerResponse =
  | { id: number; type: 'ready' }
  | { id: number; type: 'rendered'; time: number; compositionCount: number; renderTime?: number }
  | { id: number; type: 'stats'; stats: PerformanceStats }
  | { id: number; type: 'ok' }
  | { id: number; type: 'event'; event: RwssRendererEvent }
  | { id: number; type: 'error'; message: string; stack?: string }

/** AssRenderer options that can be posted to a worker. */
export interface SerializableWorkerOptions extends Omit<VideoAssSubtitleOptions, 'video' | 'canvas' | 'onLoading' | 'onLoaded' | 'onError' | 'onCanvasFallback' | 'onEvent' | 'fonts'> {
  fonts?: (string | Uint8Array | RwssFontSource)[]
}

/** Construction options for AssRendererWorkerClient. */
export interface AssRendererWorkerClientOptions extends SerializableWorkerOptions {
  worker?: Worker
  canvas?: OffscreenCanvas
  workerUrl?: string
  onEvent?: (event: RwssRendererEvent) => void
}

type RwssWorkerRequestWithoutId =
  | { type: 'init'; options: SerializableWorkerOptions; canvas?: OffscreenCanvas; wasmUrl: string; glueUrl: string }
  | { type: 'render'; time: number; force?: boolean }
  | { type: 'set-track'; content: string | Uint8Array | ArrayBuffer }
  | { type: 'stats' }
  | { type: 'reset-stats' }
  | { type: 'destroy' }

/** Main-thread client for the OffscreenCanvas worker protocol. */
export class AssRendererWorkerClient {
  /** Backing Worker instance. */
  readonly worker: Worker
  /** Resolves after the worker has initialized. */
  readonly ready: Promise<void>
  private nextId = 1
  private destroyed = false
  private readonly pending = new Map<number, { resolve: (value: RwssWorkerResponse) => void; reject: (error: Error) => void }>()
  private readonly onEvent?: (event: RwssRendererEvent) => void

  /** Create a worker client and send the init message. */
  constructor(options: AssRendererWorkerClientOptions) {
    this.onEvent = options.onEvent
    this.worker = options.worker ?? new Worker(options.workerUrl ?? new URL('./worker-runtime.js', import.meta.url), { type: 'module' })
    this.worker.addEventListener('message', (event: MessageEvent<RwssWorkerResponse>) => this.handleMessage(event.data))
    const { worker, canvas, workerUrl, onEvent, ...serializable } = options
    void worker
    void workerUrl
    void onEvent
    const transfers: Transferable[] = []
    if (canvas) transfers.push(canvas)
    const { wasmUrl, glueUrl } = resolveWasmLoadUrls(serializable.wasmUrl)
    this.ready = this.send({ type: 'init', options: serializable, canvas, wasmUrl, glueUrl }, transfers).then(() => undefined)
  }

  /** Ask the worker to render at a media timestamp. */
  async renderAt(time: number, force = false): Promise<RwssWorkerResponse> {
    return this.send({ type: 'render', time, force })
  }

  /** Replace the worker track from ASS text or bytes. */
  async setTrack(content: string | Uint8Array | ArrayBuffer): Promise<void> {
    await this.send({ type: 'set-track', content })
  }

  /** Fetch performance stats from the worker. */
  async getStats(): Promise<PerformanceStats> {
    const response = await this.send({ type: 'stats' })
    if (response.type !== 'stats') throw new Error(`Unexpected worker response: ${response.type}`)
    return response.stats
  }

  /** Reset worker-side performance stats. */
  async resetStats(): Promise<void> {
    await this.send({ type: 'reset-stats' })
  }

  /** Tear down the worker and reject pending requests. */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    void this.send({ type: 'destroy' }).catch(() => undefined)
    this.worker.terminate()
    for (const { reject } of this.pending.values()) reject(new Error('rwss worker client destroyed'))
    this.pending.clear()
  }

  private send(message: RwssWorkerRequestWithoutId, transfer: Transferable[] = []): Promise<RwssWorkerResponse> {
    if (this.destroyed) return Promise.reject(new Error('rwss worker client is destroyed'))
    const id = this.nextId++
    const request = { id, ...message } as RwssWorkerRequest
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage(request, transfer)
    })
  }

  private handleMessage(response: RwssWorkerResponse): void {
    if (response.type === 'event') {
      this.onEvent?.(response.event)
      return
    }
    const pending = this.pending.get(response.id)
    if (!pending) return
    this.pending.delete(response.id)
    if (response.type === 'error') pending.reject(new Error(response.message))
    else pending.resolve(response)
  }
}

/** Construct an AssRendererWorkerClient. */
export function createAssRendererWorkerClient(options: AssRendererWorkerClientOptions): AssRendererWorkerClient {
  return new AssRendererWorkerClient(options)
}
