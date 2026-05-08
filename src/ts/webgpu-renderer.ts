import type { AssSubtitleData, WrassPlaneData } from './types'
import { composeAssFrameCpu, putCompositionOnCanvas, type WrassImageCompositionResult } from './gpu-compositor'

export interface WebGPURendererOptions {
  device?: GPUDevice
  context?: GPUCanvasContext
  format?: GPUTextureFormat
}

interface WebGPUPipelineState {
  pipeline: GPURenderPipeline
  sampler: GPUSampler
  vertexBuffer: GPUBuffer
}

export class WebGPURenderer {
  readonly type = 'webgpu' as const
  private device: GPUDevice | null
  private context: GPUCanvasContext | null
  private format: GPUTextureFormat
  private pipelineState: WebGPUPipelineState | null = null
  private initPromise: Promise<boolean> | null = null

  constructor(readonly canvas?: HTMLCanvasElement | OffscreenCanvas, options: WebGPURendererOptions = {}) {
    this.device = options.device ?? null
    this.context = options.context ?? getWebGPUContext(canvas)
    this.format = options.format ?? getPreferredCanvasFormat()
  }

  static async create(canvas?: HTMLCanvasElement | OffscreenCanvas, options: WebGPURendererOptions = {}): Promise<WebGPURenderer> {
    const renderer = new WebGPURenderer(canvas, options)
    await renderer.init()
    return renderer
  }

  async init(): Promise<boolean> {
    if (this.device) {
      this.configureContext()
      return true
    }
    if (this.initPromise) return this.initPromise
    this.initPromise = this.initDevice()
    return this.initPromise
  }

  render(data: AssSubtitleData): WrassImageCompositionResult {
    // WebGPU readback is asynchronous (`GPUBuffer.mapAsync`), so the sync render contract remains
    // a deterministic CPU fallback. Use `await renderAsync(data)` for the real WebGPU compositor.
    const result = composeAssFrameCpu(data, 'webgpu', true)
    putCompositionOnCanvas(result, this.canvas)
    return result
  }

  async renderAsync(data: AssSubtitleData): Promise<WrassImageCompositionResult> {
    if (!await this.init()) return this.render(data)

    try {
      return await this.renderWithWebGPU(data)
    } catch {
      return this.render(data)
    }
  }

  destroy(): void {
    this.pipelineState?.vertexBuffer.destroy()
    this.pipelineState = null
    this.device = null
    this.context = null
  }

  private async initDevice(): Promise<boolean> {
    const gpu = getNavigatorGpu()
    if (!gpu) return false
    const adapter = await gpu.requestAdapter()
    if (!adapter) return false
    this.device = await adapter.requestDevice()
    this.context = this.context ?? getWebGPUContext(this.canvas)
    this.configureContext()
    return true
  }

  private configureContext(): void {
    if (!this.context || !this.device) return
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'premultiplied',
      usage: gpuTextureUsage().RENDER_ATTACHMENT | gpuTextureUsage().COPY_SRC
    })
  }

  private async renderWithWebGPU(data: AssSubtitleData): Promise<WrassImageCompositionResult> {
    const device = this.device
    if (!device) return this.render(data)

    const targetTexture = device.createTexture({
      size: { width: data.width, height: data.height },
      format: this.format,
      usage: gpuTextureUsage().RENDER_ATTACHMENT | gpuTextureUsage().COPY_SRC
    })

    const encoder = device.createCommandEncoder()
    data.compositionData.forEach((plane, index) => {
      this.drawPlane(device, encoder, targetTexture, data.width, data.height, plane, index === 0)
    })

    const rgba = await this.readTexture(device, encoder, targetTexture, data.width, data.height)
    targetTexture.destroy()

    const coverage = alphaCoverage(rgba)
    return {
      backend: 'webgpu',
      width: data.width,
      height: data.height,
      rgba,
      compositionCount: data.compositionData.length,
      nonTransparentPixels: coverage.nonTransparentPixels,
      alphaSum: coverage.alphaSum,
      usedFallback: false
    }
  }

  private drawPlane(device: GPUDevice, encoder: GPUCommandEncoder, targetTexture: GPUTexture, frameWidth: number, frameHeight: number, plane: WrassPlaneData, clear: boolean): void {
    const state = this.ensurePipeline(device)
    const texture = device.createTexture({
      size: { width: plane.width, height: plane.height },
      format: 'rgba8unorm',
      usage: gpuTextureUsage().TEXTURE_BINDING | gpuTextureUsage().COPY_DST
    })
    const upload = paddedPlaneTextureData(plane)
    device.queue.writeTexture(
      { texture },
      upload.data,
      { bytesPerRow: upload.bytesPerRow, rowsPerImage: plane.height },
      { width: plane.width, height: plane.height }
    )

    device.queue.writeBuffer(state.vertexBuffer, 0, planeVertices(plane, frameWidth, frameHeight))
    const bindGroup = device.createBindGroup({
      layout: state.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: state.sampler },
        { binding: 1, resource: texture.createView() }
      ]
    })

    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: targetTexture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: clear ? 'clear' : 'load',
          storeOp: 'store'
        }
      ]
    })
    pass.setPipeline(state.pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.setVertexBuffer(0, state.vertexBuffer)
    pass.draw(6)
    pass.end()
    texture.destroy()
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
    const vertexBuffer = device.createBuffer({ size: 6 * 4 * 4, usage: gpuBufferUsage().VERTEX | gpuBufferUsage().COPY_DST })
    this.pipelineState = { pipeline, sampler, vertexBuffer }
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

export function isWebGPUSupported(): boolean {
  return !!getNavigatorGpu()
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

function planeVertices(plane: WrassPlaneData, frameWidth: number, frameHeight: number): Float32Array {
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

function paddedPlaneTextureData(plane: WrassPlaneData): { data: Uint8Array; bytesPerRow: number } {
  const source = plane.rgba instanceof Uint8Array ? plane.rgba : new Uint8Array(plane.rgba)
  const sourceStride = plane.stride || plane.width * 4
  const bytesPerRow = alignTo(plane.width * 4, 256)
  const data = new Uint8Array(bytesPerRow * plane.height)
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
