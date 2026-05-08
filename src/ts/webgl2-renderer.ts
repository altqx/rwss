export class WebGL2Renderer {
  readonly type = 'webgl2' as const
  constructor(readonly canvas?: HTMLCanvasElement | OffscreenCanvas) {}
  render(): void {
    throw new Error('wrass WebGL2 renderer is not implemented yet; canvas2d is the supported backend')
  }
  destroy(): void {}
}

export function isWebGL2Supported(): boolean {
  if (typeof document === 'undefined') return false
  return !!document.createElement('canvas').getContext('webgl2')
}
