import { describe, expect, test } from 'bun:test'

import { WebGPURenderer } from '../src/ts/webgpu-renderer'
import type { AssSubtitleData } from '../src/ts/types'

class FakeGPUBuffer {
  private static nextId = 1
  readonly id = FakeGPUBuffer.nextId++
  mapped = false
  destroyed = false
  constructor(readonly bytes: Uint8Array = new Uint8Array(16)) {}
  async mapAsync(): Promise<void> { this.mapped = true }
  getMappedRange(): ArrayBuffer { return this.bytes.buffer.slice(0) as ArrayBuffer }
  unmap(): void { this.mapped = false }
  destroy(): void { this.destroyed = true }
}

class FakeGPUTexture {
  destroyed = false
  readonly view = {}
  createView(): unknown { return this.view }
  destroy(): void { this.destroyed = true }
}

class FakeGPUCommandEncoder {
  readonly calls: string[] = []
  beginRenderPass(): FakeGPURenderPassEncoder { this.calls.push('beginRenderPass'); return new FakeGPURenderPassEncoder(this.calls) }
  copyTextureToBuffer(): void { this.calls.push('copyTextureToBuffer') }
  finish(): unknown { this.calls.push('finish'); return { command: true } }
}

class FakeGPURenderPassEncoder {
  constructor(private readonly calls: string[]) {}
  setPipeline(): void { this.calls.push('setPipeline') }
  setBindGroup(): void { this.calls.push('setBindGroup') }
  setVertexBuffer(): void { this.calls.push('setVertexBuffer') }
  draw(count: number): void { this.calls.push(`draw:${count}`) }
  end(): void { this.calls.push('end') }
}

class FakeGPUQueue {
  readonly writes: Array<{ kind: 'buffer' | 'texture'; width?: number; height?: number; data: number[]; bufferId?: number }> = []
  readonly externalCopies: Array<{ source: unknown; width: number; height: number }> = []
  readonly submissions: unknown[][] = []
  writeBuffer(buffer: FakeGPUBuffer, _offset: number, data: Float32Array): void {
    this.writes.push({ kind: 'buffer', bufferId: buffer.id, data: [...data].map((value) => Number(value.toFixed(3))) })
  }
  writeTexture(_dst: unknown, data: Uint8Array, _layout: unknown, size: { width: number; height: number }): void {
    this.writes.push({ kind: 'texture', width: size.width, height: size.height, data: [...data] })
  }
  copyExternalImageToTexture(source: { source: unknown }, _destination: unknown, size: { width: number; height: number }): void {
    this.externalCopies.push({ source: source.source, width: size.width, height: size.height })
  }
  submit(commands: unknown[]): void { this.submissions.push(commands) }
}

class FakeGPUCanvasContext {
  configureCalls = 0
  currentTextureCalls = 0
  configure(): void { this.configureCalls++ }
  getCurrentTexture(): FakeGPUTexture {
    this.currentTextureCalls++
    return new FakeGPUTexture()
  }
}

class FakeGPUDevice {
  readonly queue = new FakeGPUQueue()
  readonly calls: string[] = []
  readonly encoders: FakeGPUCommandEncoder[] = []
  lastEncoder: FakeGPUCommandEncoder | null = null
  createShaderModule(): unknown { this.calls.push('createShaderModule'); return {} }
  createRenderPipeline(): unknown { this.calls.push('createRenderPipeline'); return { getBindGroupLayout: () => ({}) } }
  createSampler(): unknown { this.calls.push('createSampler'); return {} }
  createTexture(): FakeGPUTexture { this.calls.push('createTexture'); return new FakeGPUTexture() }
  createBuffer(options?: { mappedAtCreation?: boolean; size?: number }): FakeGPUBuffer {
    this.calls.push(`createBuffer:${options?.size ?? 0}`)
    const bytes = new Uint8Array(options?.size ?? 16)
    if (bytes.byteLength >= 264) {
      bytes.set([255, 0, 0, 255, 0, 255, 0, 128], 0)
      bytes.set([0, 0, 255, 255, 0, 0, 0, 0], 256)
    }
    return new FakeGPUBuffer(bytes)
  }
  createBindGroup(): unknown { this.calls.push('createBindGroup'); return {} }
  createCommandEncoder(): FakeGPUCommandEncoder {
    this.calls.push('createCommandEncoder')
    this.lastEncoder = new FakeGPUCommandEncoder()
    this.encoders.push(this.lastEncoder)
    return this.lastEncoder
  }
}

const frame: AssSubtitleData = {
  width: 2,
  height: 2,
  compositionData: [
    {
      x: 0,
      y: 0,
      width: 2,
      height: 1,
      stride: 8,
      color: 0,
      kind: 0,
      rgba: new Uint8Array([
        255, 0, 0, 255,
        0, 255, 0, 128
      ])
    }
  ]
}

describe('real WebGPU compositor path', () => {
  test('uploads ASS planes as textures, draws them through WebGPU, and reads back top-left RGBA', async () => {
    const device = new FakeGPUDevice()
    const renderer = new WebGPURenderer(undefined, { device: device as unknown as GPUDevice, format: 'rgba8unorm' })

    const result = await renderer.renderAsync(frame)

    expect(result.backend).toBe('webgpu')
    expect(result.usedFallback).toBe(false)
    expect(device.calls).toContain('createShaderModule')
    expect(device.calls).toContain('createRenderPipeline')
    expect(device.calls).toContain('createTexture')
    expect(device.lastEncoder?.calls).toContain('beginRenderPass')
    expect(device.lastEncoder?.calls).toContain('draw:6')
    expect(device.lastEncoder?.calls).toContain('copyTextureToBuffer')
    expect(device.queue.submissions.length).toBe(1)
    const textureWrite = device.queue.writes.find((write) => write.kind === 'texture')
    expect(textureWrite?.width).toBe(2)
    expect(textureWrite?.height).toBe(1)
    const expectedPlaneRgba = [...new Uint8Array(frame.compositionData[0].rgba)]
    expect(textureWrite?.data.slice(0, expectedPlaneRgba.length)).toEqual(expectedPlaneRgba)
    expect([...result.rgba]).toEqual([
      255, 0, 0, 255, 0, 255, 0, 128,
      0, 0, 255, 255, 0, 0, 0, 0
    ])
    expect(result.nonTransparentPixels).toBe(3)
    expect(result.alphaSum).toBe(638)
  })

  test('presents directly without readback and preserves per-plane geometry', async () => {
    const device = new FakeGPUDevice()
    const context = new FakeGPUCanvasContext()
    let width = 2
    let height = 2
    let widthWrites = 0
    let heightWrites = 0
    const canvas = {
      get width() { return width },
      set width(value: number) { width = value; widthWrites++ },
      get height() { return height },
      set height(value: number) { height = value; heightWrites++ },
      getContext: () => context
    }
    const renderer = new WebGPURenderer(canvas as unknown as HTMLCanvasElement, {
      device: device as unknown as GPUDevice,
      context: context as unknown as GPUCanvasContext,
      format: 'rgba8unorm'
    })
    const twoPlanes: AssSubtitleData = {
      ...frame,
      compositionData: [frame.compositionData[0], { ...frame.compositionData[0], y: 1 }]
    }

    expect(await renderer.present(twoPlanes)).toBe(true)
    expect(await renderer.present(twoPlanes)).toBe(true)
    expect(await renderer.present({ ...frame, compositionData: [] })).toBe(true)
    expect(await renderer.present(twoPlanes)).toBe(true)

    expect(context.configureCalls).toBe(1)
    expect(context.currentTextureCalls).toBe(4)
    expect(widthWrites).toBe(0)
    expect(heightWrites).toBe(0)
    expect(device.calls.filter((call) => call === 'createTexture')).toHaveLength(2)
    expect(device.calls.filter((call) => call.startsWith('createBuffer:'))).toHaveLength(2)
    expect(device.calls.filter((call) => call === 'createBindGroup')).toHaveLength(2)
    expect(device.encoders.every((encoder) => !encoder.calls.includes('copyTextureToBuffer'))).toBe(true)
    expect(device.queue.submissions).toHaveLength(4)

    const geometryWrites = device.queue.writes.filter((write) => write.kind === 'buffer')
    expect(geometryWrites).toHaveLength(2)
    expect(new Set(geometryWrites.map((write) => write.bufferId)).size).toBe(2)
    expect(geometryWrites[0].data).not.toEqual(geometryWrites[1].data)

    renderer.destroy()
  })

  test('uploads ImageBitmap sources instead of replacing them with zero-filled pixels', async () => {
    const originalImageBitmap = Object.getOwnPropertyDescriptor(globalThis, 'ImageBitmap')
    class FakeImageBitmap {
      constructor(readonly width: number, readonly height: number) {}
    }
    Object.defineProperty(globalThis, 'ImageBitmap', { configurable: true, value: FakeImageBitmap })
    try {
      const device = new FakeGPUDevice()
      const context = new FakeGPUCanvasContext()
      const canvas = { width: 2, height: 1, getContext: () => context }
      const renderer = new WebGPURenderer(canvas as unknown as HTMLCanvasElement, {
        device: device as unknown as GPUDevice,
        context: context as unknown as GPUCanvasContext,
        format: 'rgba8unorm'
      })
      const bitmap = new FakeImageBitmap(2, 1) as unknown as ImageBitmap

      expect(await renderer.present([{ x: 0, y: 0, w: 2, h: 1, image: bitmap }], 2, 1)).toBe(true)
      expect(device.queue.externalCopies).toEqual([{ source: bitmap, width: 2, height: 1 }])
      expect(device.queue.writes.filter((write) => write.kind === 'texture')).toHaveLength(0)
      renderer.destroy()
    } finally {
      if (originalImageBitmap) Object.defineProperty(globalThis, 'ImageBitmap', originalImageBitmap)
      else Reflect.deleteProperty(globalThis, 'ImageBitmap')
    }
  })

  test('preserves CPU fallback when WebGPU initialization fails', async () => {
    const device = new FakeGPUDevice()
    const context = { configure: () => { throw new Error('device lost') } }
    const renderer = new WebGPURenderer(undefined, {
      device: device as unknown as GPUDevice,
      context: context as unknown as GPUCanvasContext,
      format: 'rgba8unorm'
    })

    const result = await renderer.renderAsync(frame)

    expect(result.backend).toBe('webgpu')
    expect(result.usedFallback).toBe(true)
    expect(result.compositionCount).toBe(1)
    expect(await renderer.present(frame)).toBe(false)
  })
})
