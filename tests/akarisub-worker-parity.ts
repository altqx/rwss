import {
  AssRendererWorkerClient,
  createAssRendererWorkerClient,
  type AssRendererWorkerClientOptions,
  type WrassWorkerRequest,
  type WrassWorkerResponse
} from '../src/index'

const worker = new Worker('/wrass-worker.js', { type: 'module' })
const canvas = new OffscreenCanvas(640, 360)
const options: AssRendererWorkerClientOptions = {
  worker,
  canvas,
  wasmUrl: '/pkg/wrass_bg.wasm',
  subContent: '[Script Info]\n',
  fonts: [{ name: 'Browser Font', data: new Uint8Array(), aliases: ['sans'] }],
  fallbackFonts: ['Browser Font'],
  onEvent(event) {
    const type: string = event.type
    void type
  }
}

const client = new AssRendererWorkerClient(options)
const created = createAssRendererWorkerClient(options)
const request: WrassWorkerRequest = { id: 1, type: 'render', time: 1.25 }
const response: WrassWorkerResponse = { id: 1, type: 'rendered', time: 1.25, compositionCount: 0 }
const ready: Promise<void> = client.ready
const render: Promise<WrassWorkerResponse> = client.renderAt(1.25)
const stats = client.getStats()
client.resetStats()
client.destroy()
created.destroy()

void canvas
void request
void response
void ready
void render
void stats
