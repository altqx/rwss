import {
  WebGPURenderer,
  WebGL2Renderer,
  type VideoAssSubtitleOptions,
  type WorkerInboundMessage,
  type WorkerOutboundMessage,
  type WorkerInitMessage,
  type HbGpuShaderMessage,
  type HbGpuRenderMessage,
  type RenderImage
} from '../src/index'

const canvas = document.createElement('canvas')
const options: VideoAssSubtitleOptions = {
  canvas,
  blendMode: 'hb-gpu',
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

const shaderMessage: HbGpuShaderMessage = {
  target: 'hbGpuShaders',
  wgsl: { vertex: '', fragment: '', drawFragment: '', paintFragment: '' },
  glsl: { vertex: '', fragment: '', drawFragment: '', paintFragment: '' }
}
const renderMessage: HbGpuRenderMessage = {
  target: 'renderHbGpu',
  glyphData: new ArrayBuffer(0),
  atlasData: new ArrayBuffer(0),
  times: {},
  width: 1,
  height: 1,
  colorSpace: null
}
const initMessage: WorkerInitMessage = {
  target: 'init',
  wasmUrl: '/akarisub-worker.wasm',
  asyncRender: true,
  fullTrackWarmup: false,
  onDemandRender: true,
  initialTime: 0,
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
  useLocalFonts: false,
  hasBitmapBug: false
}
const inbound: WorkerInboundMessage = { target: 'getColorSpace' }
const outbound: WorkerOutboundMessage = shaderMessage
void renderMessage
void initMessage
void inbound
void outbound

const webgpu = new WebGPURenderer()
await webgpu.init()
await webgpu.setCanvas(canvas, 1, 1)
webgpu.updateSize(2, 2)
webgpu.render([image], 2, 2)
webgpu.renderBitmaps([], 2, 2)
webgpu.setHbGpuShaders(shaderMessage)
webgpu.renderHbGpuBlobs(new ArrayBuffer(0), new ArrayBuffer(0), 2, 2)
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
webgl2.setHbGpuShaders(shaderMessage)
webgl2.renderHbGpuBlobs(new ArrayBuffer(0), new ArrayBuffer(0), 2, 2)
webgl2.clear()
const webgl2Initialized: boolean = webgl2.initialized
webgl2.destroy()
void webgl2Initialized
