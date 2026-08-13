import {
  WebGPURenderer,
  WebGL2Renderer,
  type VideoAssSubtitleOptions,
  type WorkerInboundMessage,
  type WorkerOutboundMessage,
  type WorkerInitMessage,
  type RenderImage
} from '../src/index'

const canvas = document.createElement('canvas')
const options: VideoAssSubtitleOptions = {
  canvas,
  workerUrl: '/akarisub-worker.js',
  wasmUrl: '/akarisub-worker.wasm',
  renderAhead: 0.008,
  fullTrackWarmup: true
}
void options

const image: RenderImage = {
  x: 0,
  y: 0,
  w: 1,
  h: 1,
  image: new Uint8Array([255, 255, 255, 255])
}

const initMessage: WorkerInitMessage = {
  target: 'init',
  wasmUrl: '/akarisub-worker.wasm',
  asyncRender: true,
  fullTrackWarmup: false,
  blockingFullTrackWarmup: false,
  fullTrackWarmupStep: 1,
  adaptiveBlendLayouts: false,
  rawAssImageGpu: false,
  onDemandRender: true,
  initialTime: 0,
  initialIsPaused: true,
  initialPlaybackRate: 1,
  initialTimeSnapshotAtMs: 0,
  width: 1,
  height: 1,
  blendMode: 'wasm',
  subContent: null,
  encryptedSubContent: null,
  fonts: [],
  availableFonts: {},
  fallbackFonts: ['sans'],
  debug: false,
  targetFps: 24,
  renderAhead: 0,
  adaptiveTiming: true,
  frameTimelineMode: false,
  useLocalFonts: false,
  useFontconfigProvider: true,
  hasBitmapBug: false
}
const inbound: WorkerInboundMessage = { target: 'prepare', time: 1, prepareId: 1, renderEpoch: 1, force: true }
const outbound: WorkerOutboundMessage = { target: 'ready' }
void initMessage
void inbound
void outbound

const webgpu = new WebGPURenderer()
await webgpu.init()
await webgpu.setCanvas(canvas, 1, 1)
webgpu.updateSize(2, 2)
webgpu.render([image], 2, 2)
webgpu.renderBitmaps([], 2, 2)
webgpu.clear()
const webgpuInitialized: boolean = webgpu.initialized
webgpu.destroy()
void webgpuInitialized

const webgl2 = new WebGL2Renderer()
await webgl2.init()
await webgl2.setCanvas(canvas, 1, 1)
webgl2.updateSize(2, 2)
webgl2.render([image], 2, 2)
webgl2.renderBitmaps([], 2, 2)
webgl2.clear()
const webgl2Initialized: boolean = webgl2.initialized
webgl2.destroy()
void webgl2Initialized
