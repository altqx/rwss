import { describe, expect, test } from 'bun:test'

import { WebGPURenderer } from '../src/ts/webgpu-renderer'
import type { AssSubtitleData } from '../src/ts/types'

class FakeGPUBuffer {
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
  readonly writes: Array<{ kind: 'buffer' | 'texture'; width?: number; height?: number; data: number[] }> = []
  readonly submissions: unknown[][] = []
  writeBuffer(_buffer: unknown, _offset: number, data: Float32Array): void {
    this.writes.push({ kind: 'buffer', data: [...data].map((value) => Number(value.toFixed(3))) })
  }
  writeTexture(_dst: unknown, data: Uint8Array, _layout: unknown, size: { width: number; height: number }): void {
    this.writes.push({ kind: 'texture', width: size.width, height: size.height, data: [...data] })
  }
  submit(commands: unknown[]): void { this.submissions.push(commands) }
}

class FakeGPUDevice {
  readonly queue = new FakeGPUQueue()
  readonly calls: string[] = []
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
})
