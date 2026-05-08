export class WebGPURenderer {
  readonly type = 'webgpu' as const
  constructor(readonly canvas?: HTMLCanvasElement | OffscreenCanvas) {}
  render(): void {
    throw new Error('wrass WebGPU renderer is not implemented yet; canvas2d is the supported backend')
  }
  destroy(): void {}
}

export function isWebGPUSupported(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator
}
