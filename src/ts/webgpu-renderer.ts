import type { AssSubtitleData, RenderImage } from './types'
import { composeAssFrameCpu, limitAssImages, putCompositionOnCanvas, type RwssImageCompositionResult } from './gpu-compositor'

/** Construction options for WebGPURenderer. */
export interface WebGPURendererOptions {
  device?: GPUDevice
  context?: GPUCanvasContext
  format?: GPUTextureFormat
}

interface WebGPUPipelineState {
  pipeline: GPURenderPipeline
  sampler: GPUSampler
}

interface WebGPUPlaneResource {
  texture: GPUTexture
  view: GPUTextureView
  vertexBuffer: GPUBuffer
  bindGroup: GPUBindGroup
  width: number
  height: number
  geometry: readonly number[] | null
  uploadData?: Uint8Array
}

interface WebGPUPresentPlane {
  x: number
  y: number
  width: number
  height: number
  stride: number
  rgba?: Uint8Array | number[]
  bitmap?: ImageBitmap
}

/** WebGPU compositor for ASS image planes, with CPU fallback. */
export class WebGPURenderer {
  /** Backend identifier. */
  readonly type = 'webgpu' as const
  private device: GPUDevice | null
  private context: GPUCanvasContext | null
  private format: GPUTextureFormat
  private pipelineState: WebGPUPipelineState | null = null
  private planeResources: WebGPUPlaneResource[] = []
  private initPromise: Promise<boolean> | null = null
  private configuredContext: GPUCanvasContext | null = null
  private configuredDevice: GPUDevice | null = null
  private _canvas?: HTMLCanvasElement | OffscreenCanvas

  /** Bind an optional canvas and optional pre-created GPU device/context. */
  constructor(canvas?: HTMLCanvasElement | OffscreenCanvas, options: WebGPURendererOptions = {}) {
    this._canvas = canvas
    this.device = options.device ?? null
    this.context = options.context ?? getWebGPUContext(canvas)
    this.format = options.format ?? getPreferredCanvasFormat()
  }

  /** Canvas currently bound to this renderer. */
  get canvas(): HTMLCanvasElement | OffscreenCanvas | undefined {
    return this._canvas
  }

  /** Whether a GPU device has been acquired. */
  get initialized(): boolean {
    return !!this.device
  }

  /** Construct and initialize a WebGPU renderer. */
  static async create(canvas?: HTMLCanvasElement | OffscreenCanvas, options: WebGPURendererOptions = {}): Promise<WebGPURenderer> {
    const renderer = new WebGPURenderer(canvas, options)
    await renderer.init()
    return renderer
  }

  /** Acquire a GPU device if one is not already set. */
  async init(): Promise<boolean> {
    if (this.device) {
      this.configureContext()
      return true
    }
    if (this.initPromise) return this.initPromise
    this.initPromise = this.initDevice()
    return this.initPromise
  }

  /** Compose ASS planes or raw images. The sync ASS path uses CPU fallback. */
  render(data: AssSubtitleData): RwssImageCompositionResult
  render(images: RenderImage[], canvasWidth: number, canvasHeight: number): void
  render(dataOrImages: AssSubtitleData | RenderImage[], canvasWidth?: number, canvasHeight?: number): RwssImageCompositionResult | void {
    if (Array.isArray(dataOrImages)) {
      void this.present(dataOrImages, canvasWidth ?? this._canvas?.width ?? 1, canvasHeight ?? this._canvas?.height ?? 1)
      return
    }
    const data = dataOrImages
    // WebGPU readback is asynchronous (`GPUBuffer.mapAsync`), so the sync render contract remains
    // a deterministic CPU fallback. Use `await renderAsync(data)` for the real WebGPU compositor.
    const result = composeAssFrameCpu(data, 'webgpu', true)
    putCompositionOnCanvas(result, this.canvas)
    return result
  }

  /** Compose ASS planes through WebGPU, falling back to CPU on failure. */
  async renderAsync(data: AssSubtitleData): Promise<RwssImageCompositionResult> {
    try {
      if (!await this.init()) return this.render(data)
      return await this.renderWithWebGPU(data)
    } catch {
      return this.render(data)
    }
  }

  /** Present ASS planes or raw images directly to the canvas swapchain without GPU readback. */
  present(data: AssSubtitleData): Promise<boolean>
  present(images: RenderImage[], canvasWidth: number, canvasHeight: number): Promise<boolean>
  async present(dataOrImages: AssSubtitleData | RenderImage[], canvasWidth?: number, canvasHeight?: number): Promise<boolean> {
    if (!Array.isArray(dataOrImages)) {
      return this.presentPlanes(limitAssImages(dataOrImages.compositionData), dataOrImages.width, dataOrImages.height)
    }
    const planes = renderImagesToPresentPlanes(dataOrImages)
    return this.presentPlanes(planes, canvasWidth ?? this._canvas?.width ?? 1, canvasHeight ?? this._canvas?.height ?? 1)
  }

  async setCanvas(canvas: HTMLCanvasElement | OffscreenCanvas, width: number, height: number): Promise<void> {
    this._canvas = canvas
    this.context = getWebGPUContext(canvas)
    this.configuredContext = null
    this.configuredDevice = null
    if (width > 0 && canvas.width !== width) canvas.width = width
    if (height > 0 && canvas.height !== height) canvas.height = height
    await this.init()
  }

  updateSize(width: number, height: number): void {
    if (!this._canvas || width <= 0 || height <= 0) return
    if (this._canvas.width !== width) this._canvas.width = width
    if (this._canvas.height !== height) this._canvas.height = height
  }

  renderBitmaps(images: { image: ImageBitmap; x: number; y: number }[], canvasWidth: number, canvasHeight: number): void {
    const normalized: RenderImage[] = images.map(({ image, x, y }) => ({ x, y, w: image.width, h: image.height, image }))
    void this.present(normalized, canvasWidth, canvasHeight)
  }

  clear(): void {
    if (!this.device || !this.context) return
    const texture = this.context.getCurrentTexture()
    const encoder = this.device.createCommandEncoder()
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }] })
    pass.end()
    this.device.queue.submit([encoder.finish()])
  }

  /** Release GPU pipeline resources. */
  destroy(): void {
    for (const resource of this.planeResources) destroyPlaneResource(resource)
    this.planeResources.length = 0
    this.pipelineState = null
    this.device = null
    this.context = null
    this.configuredContext = null
    this.configuredDevice = null
    this.initPromise = null
  }

  private async initDevice(): Promise<boolean> {
    const gpu = getNavigatorGpu()
    if (!gpu) return false
    const adapter = await gpu.requestAdapter()
    if (!adapter) return false
    this.device = await adapter.requestDevice()
    this.context = this.context ?? getWebGPUContext(this._canvas)
    this.configureContext()
    return true
  }

  private configureContext(): void {
    if (!this.context || !this.device) return
    if (this.configuredContext === this.context && this.configuredDevice === this.device) return
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'premultiplied',
      usage: gpuTextureUsage().RENDER_ATTACHMENT | gpuTextureUsage().COPY_SRC
    })
    this.configuredContext = this.context
    this.configuredDevice = this.device
  }

  private async renderWithWebGPU(data: AssSubtitleData): Promise<RwssImageCompositionResult> {
    const device = this.device
    if (!device) return this.render(data)

    const targetTexture = device.createTexture({
      size: { width: data.width, height: data.height },
      format: this.format,
      usage: gpuTextureUsage().RENDER_ATTACHMENT | gpuTextureUsage().COPY_SRC
    })

    try {
      const encoder = device.createCommandEncoder()
      const compositionCount = this.encodePlanes(
        device,
        encoder,
        targetTexture,
        data.width,
        data.height,
        limitAssImages(data.compositionData)
      )
      const rgba = await this.readTexture(device, encoder, targetTexture, data.width, data.height)
      const coverage = alphaCoverage(rgba)
      return {
        backend: 'webgpu',
        width: data.width,
        height: data.height,
        rgba,
        compositionCount,
        nonTransparentPixels: coverage.nonTransparentPixels,
        alphaSum: coverage.alphaSum,
        usedFallback: false
      }
    } finally {
      targetTexture.destroy()
    }
  }

  private async presentPlanes(planes: readonly WebGPUPresentPlane[], width: number, height: number): Promise<boolean> {
    if (width <= 0 || height <= 0) return false
    try {
      if (!await this.init()) return false
      const device = this.device
      const context = this.context
      if (!device || !context) return false
      this.updateSize(width, height)
      const targetTexture = context.getCurrentTexture()
      const encoder = device.createCommandEncoder()
      this.encodePlanes(device, encoder, targetTexture, width, height, planes)
      device.queue.submit([encoder.finish()])
      return true
    } catch {
      return false
    }
  }

  private encodePlanes(
    device: GPUDevice,
    encoder: GPUCommandEncoder,
    targetTexture: GPUTexture,
    frameWidth: number,
    frameHeight: number,
    planes: readonly WebGPUPresentPlane[]
  ): number {
    const state = this.ensurePipeline(device)
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: targetTexture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store'
        }
      ]
    })
    pass.setPipeline(state.pipeline)
    let compositionCount = 0
    for (const plane of planes) {
      if (plane.width <= 0 || plane.height <= 0) continue
      const resource = this.ensurePlaneResource(device, state, compositionCount, plane.width, plane.height)
      this.uploadPlane(device, resource, plane)
      this.updatePlaneGeometry(device, resource, plane, frameWidth, frameHeight)
      pass.setBindGroup(0, resource.bindGroup)
      pass.setVertexBuffer(0, resource.vertexBuffer)
      pass.draw(6)
      compositionCount++
    }
    pass.end()
    return compositionCount
  }

  private ensurePlaneResource(
    device: GPUDevice,
    state: WebGPUPipelineState,
    index: number,
    width: number,
    height: number
  ): WebGPUPlaneResource {
    let resource = this.planeResources[index]
    if (!resource) {
      const vertexBuffer = device.createBuffer({ size: 6 * 4 * 4, usage: gpuBufferUsage().VERTEX | gpuBufferUsage().COPY_DST })
      const texture = createPlaneTexture(device, width, height)
      const view = texture.createView()
      resource = {
        texture,
        view,
        vertexBuffer,
        bindGroup: createPlaneBindGroup(device, state, view),
        width,
        height,
        geometry: null
      }
      this.planeResources[index] = resource
      return resource
    }
    if (resource.width !== width || resource.height !== height) {
      resource.texture.destroy()
      resource.texture = createPlaneTexture(device, width, height)
      resource.view = resource.texture.createView()
      resource.bindGroup = createPlaneBindGroup(device, state, resource.view)
      resource.width = width
      resource.height = height
      resource.uploadData = undefined
    }
    return resource
  }

  private uploadPlane(device: GPUDevice, resource: WebGPUPlaneResource, plane: WebGPUPresentPlane): void {
    if (plane.bitmap) {
      device.queue.copyExternalImageToTexture(
        { source: plane.bitmap },
        { texture: resource.texture },
        { width: plane.width, height: plane.height }
      )
      return
    }
    if (!plane.rgba) throw new Error('WebGPU plane has no pixel source')
    const upload = paddedPlaneTextureData(plane, plane.rgba, resource.uploadData)
    resource.uploadData = upload.data
    device.queue.writeTexture(
      { texture: resource.texture },
      upload.data,
      { bytesPerRow: upload.bytesPerRow, rowsPerImage: plane.height },
      { width: plane.width, height: plane.height }
    )
  }

  private updatePlaneGeometry(
    device: GPUDevice,
    resource: WebGPUPlaneResource,
    plane: WebGPUPresentPlane,
    frameWidth: number,
    frameHeight: number
  ): void {
    const geometry = [plane.x, plane.y, plane.width, plane.height, frameWidth, frameHeight]
    if (resource.geometry?.every((value, index) => value === geometry[index])) return
    device.queue.writeBuffer(resource.vertexBuffer, 0, planeVertices(plane, frameWidth, frameHeight))
    resource.geometry = geometry
  }

  private ensurePipeline(device: GPUDevice): WebGPUPipelineState {
    if (this.pipelineState) return this.pipelineState

    const shader = device.createShaderModule({ code: `
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) tex_coord: vec2f,
}

@vertex
fn vs_main(@location(0) position: vec2f, @location(1) tex_coord: vec2f) -> VertexOut {
  var out: VertexOut;
  out.position = vec4f(position, 0.0, 1.0);
  out.tex_coord = tex_coord;
  return out;
}

@group(0) @binding(0) var plane_sampler: sampler;
@group(0) @binding(1) var plane_texture: texture_2d<f32>;

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  return textureSample(plane_texture, plane_sampler, in.tex_coord);
}
` })

    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: shader,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 16,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x2' },
              { shaderLocation: 1, offset: 8, format: 'float32x2' }
            ]
          }
        ]
      },
      fragment: {
        module: shader,
        entryPoint: 'fs_main',
        targets: [
          {
            format: this.format,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
            }
          }
        ]
      },
      primitive: { topology: 'triangle-list' }
    })
    const sampler = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' })
    this.pipelineState = { pipeline, sampler }
    return this.pipelineState
  }

  private async readTexture(device: GPUDevice, encoder: GPUCommandEncoder, texture: GPUTexture, width: number, height: number): Promise<Uint8Array> {
    const bytesPerRow = alignTo(width * 4, 256)
    const output = device.createBuffer({
      size: bytesPerRow * height,
      usage: gpuBufferUsage().COPY_DST | gpuBufferUsage().MAP_READ
    })
    encoder.copyTextureToBuffer(
      { texture },
      { buffer: output, bytesPerRow, rowsPerImage: height },
      { width, height }
    )
    device.queue.submit([encoder.finish()])
    await output.mapAsync(gpuMapMode().READ)
    const mapped = new Uint8Array(output.getMappedRange())
    const rgba = unpadRows(mapped, width, height, bytesPerRow)
    output.unmap()
    output.destroy()
    return rgba
  }
}

/** Whether navigator.gpu is available. */
export function isWebGPUSupported(): boolean {
  return !!getNavigatorGpu()
}

function isImageBitmapValue(value: RenderImage['image']): value is ImageBitmap {
  return typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap
}

function renderImagesToPresentPlanes(images: RenderImage[]): WebGPUPresentPlane[] {
  const planes: WebGPUPresentPlane[] = []
  for (const image of limitAssImages(images)) {
    if (image.w <= 0 || image.h <= 0 || typeof image.image === 'number') continue
    if (isImageBitmapValue(image.image)) {
      planes.push({ x: image.x, y: image.y, width: image.w, height: image.h, stride: image.w * 4, bitmap: image.image })
      continue
    }
    const rgba = renderImageBytes(image.image)
    if (rgba.byteLength === 0) continue
    planes.push({ x: image.x, y: image.y, width: image.w, height: image.h, stride: image.w * 4, rgba })
  }
  return planes
}

function renderImageBytes(value: RenderImage['image']): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (value instanceof Uint8Array) return value
  if (value instanceof Uint8ClampedArray) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  return new Uint8Array(0)
}

function getNavigatorGpu(): GPU | null {
  return typeof navigator !== 'undefined' && 'gpu' in navigator ? (navigator.gpu as GPU) : null
}

function getWebGPUContext(canvas?: HTMLCanvasElement | OffscreenCanvas): GPUCanvasContext | null {
  try {
    return (canvas?.getContext('webgpu') as GPUCanvasContext | null | undefined) ?? null
  } catch {
    return null
  }
}

function getPreferredCanvasFormat(): GPUTextureFormat {
  const gpu = getNavigatorGpu()
  return gpu?.getPreferredCanvasFormat?.() ?? 'rgba8unorm'
}

function createPlaneTexture(device: GPUDevice, width: number, height: number): GPUTexture {
  return device.createTexture({
    size: { width, height },
    format: 'rgba8unorm',
    usage: gpuTextureUsage().TEXTURE_BINDING | gpuTextureUsage().COPY_DST
  })
}

function createPlaneBindGroup(device: GPUDevice, state: WebGPUPipelineState, view: GPUTextureView): GPUBindGroup {
  return device.createBindGroup({
    layout: state.pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: state.sampler },
      { binding: 1, resource: view }
    ]
  })
}

function destroyPlaneResource(resource: WebGPUPlaneResource): void {
  resource.texture.destroy()
  resource.vertexBuffer.destroy()
}

function planeVertices(plane: Pick<WebGPUPresentPlane, 'x' | 'y' | 'width' | 'height'>, frameWidth: number, frameHeight: number): Float32Array {
  const left = pixelXToClip(plane.x, frameWidth)
  const right = pixelXToClip(plane.x + plane.width, frameWidth)
  const top = pixelYToClip(plane.y, frameHeight)
  const bottom = pixelYToClip(plane.y + plane.height, frameHeight)
  return new Float32Array([
    left, top, 0, 0,
    right, top, 1, 0,
    left, bottom, 0, 1,
    left, bottom, 0, 1,
    right, top, 1, 0,
    right, bottom, 1, 1
  ])
}

function pixelXToClip(x: number, width: number): number {
  return width > 0 ? x / width * 2 - 1 : -1
}

function pixelYToClip(y: number, height: number): number {
  return height > 0 ? 1 - y / height * 2 : 1
}

function paddedPlaneTextureData(plane: WebGPUPresentPlane, rgba: Uint8Array | number[], reusable?: Uint8Array): { data: Uint8Array; bytesPerRow: number } {
  const source = rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba)
  const sourceStride = plane.stride || plane.width * 4
  const bytesPerRow = alignTo(plane.width * 4, 256)
  const byteLength = bytesPerRow * plane.height
  const data = reusable?.byteLength === byteLength ? reusable : new Uint8Array(byteLength)
  for (let y = 0; y < plane.height; y++) {
    const srcStart = y * sourceStride
    const dstStart = y * bytesPerRow
    data.set(source.subarray(srcStart, srcStart + plane.width * 4), dstStart)
  }
  return { data, bytesPerRow }
}

function unpadRows(source: Uint8Array, width: number, height: number, bytesPerRow: number): Uint8Array {
  const rowBytes = width * 4
  const out = new Uint8Array(rowBytes * height)
  for (let y = 0; y < height; y++) {
    out.set(source.subarray(y * bytesPerRow, y * bytesPerRow + rowBytes), y * rowBytes)
  }
  return out
}

function alphaCoverage(rgba: Uint8Array): { nonTransparentPixels: number; alphaSum: number } {
  let nonTransparentPixels = 0
  let alphaSum = 0
  for (let index = 3; index < rgba.length; index += 4) {
    const alpha = rgba[index]
    if (alpha > 0) nonTransparentPixels++
    alphaSum += alpha
  }
  return { nonTransparentPixels, alphaSum }
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment
}

type GpuBufferUsageConstants = {
  MAP_READ: number
  COPY_SRC: number
  COPY_DST: number
  INDEX: number
  VERTEX: number
  UNIFORM: number
  STORAGE: number
  INDIRECT: number
  QUERY_RESOLVE: number
}

type GpuTextureUsageConstants = {
  COPY_SRC: number
  COPY_DST: number
  TEXTURE_BINDING: number
  STORAGE_BINDING: number
  RENDER_ATTACHMENT: number
}

type GpuMapModeConstants = {
  READ: number
  WRITE: number
}

function gpuBufferUsage(): GpuBufferUsageConstants {
  const constants = globalThis as typeof globalThis & { GPUBufferUsage?: GpuBufferUsageConstants }
  return constants.GPUBufferUsage
    ?? { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 }
}

function gpuTextureUsage(): GpuTextureUsageConstants {
  const constants = globalThis as typeof globalThis & { GPUTextureUsage?: GpuTextureUsageConstants }
  return constants.GPUTextureUsage
    ?? { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 }
}

function gpuMapMode(): GpuMapModeConstants {
  const constants = globalThis as typeof globalThis & { GPUMapMode?: GpuMapModeConstants }
  return constants.GPUMapMode ?? { READ: 1, WRITE: 2 }
}
