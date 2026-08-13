import {
  AssRendererWorkerClient,
  createAssRendererWorkerClient,
  type AssRendererWorkerClientOptions,
  type RwssWorkerRequest,
  type RwssWorkerResponse
} from '../src/index'

const worker = new Worker('/rwss-worker.js', { type: 'module' })
const canvas = new OffscreenCanvas(640, 360)
const options: AssRendererWorkerClientOptions = {
  worker,
  canvas,
  wasmUrl: '/pkg/rwss_bg.wasm',
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
const request: RwssWorkerRequest = { id: 1, type: 'render', time: 1.25 }
const response: RwssWorkerResponse = { id: 1, type: 'rendered', time: 1.25, compositionCount: 0 }
const ready: Promise<void> = client.ready
const render: Promise<RwssWorkerResponse> = client.renderAt(1.25)
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
