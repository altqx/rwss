import type { AssSubtitleData } from './types'
import { composeAssFrameCpu, putCompositionOnCanvas, type WrassImageCompositionResult } from './gpu-compositor'

export class WebGPURenderer {
  readonly type = 'webgpu' as const
  private readonly hasAdapter: boolean

  constructor(readonly canvas?: HTMLCanvasElement | OffscreenCanvas) {
    this.hasAdapter = isWebGPUSupported()
  }

  render(data: AssSubtitleData): WrassImageCompositionResult {
    // Keep the AkariSub-compatible composition API usable before/asynchronously to full GPU
    // device setup.  A future WebGPU pipeline can replace the internals while preserving this
    // result shape and fallback behavior.
    const result = composeAssFrameCpu(data, 'webgpu', !this.hasAdapter)
    putCompositionOnCanvas(result, this.canvas)
    return result
  }

  destroy(): void {}
}

export function isWebGPUSupported(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator
}
