import type { AssSubtitleData } from './types'
import { composeAssFrameCpu, putCompositionOnCanvas, type WrassImageCompositionResult } from './gpu-compositor'

export class WebGL2Renderer {
  readonly type = 'webgl2' as const
  private readonly gl: WebGL2RenderingContext | null

  constructor(readonly canvas?: HTMLCanvasElement | OffscreenCanvas) {
    this.gl = getWebGL2Context(canvas)
  }

  render(data: AssSubtitleData): WrassImageCompositionResult {
    // The public contract mirrors AkariSub's image-composition backend: callers can choose
    // WebGL2 and still receive a composited frame even on browsers/runtimes where WebGL2 is
    // unavailable.  The CPU path preserves the exact plane blend semantics and is used until
    // a real shader pipeline is attached to `this.gl`.
    const result = composeAssFrameCpu(data, 'webgl2', this.gl === null)
    putCompositionOnCanvas(result, this.canvas)
    return result
  }

  destroy(): void {}
}

export function isWebGL2Supported(): boolean {
  if (typeof document === 'undefined') return false
  return !!document.createElement('canvas').getContext('webgl2')
}

function getWebGL2Context(canvas?: HTMLCanvasElement | OffscreenCanvas): WebGL2RenderingContext | null {
  try {
    const target = canvas ?? (typeof document !== 'undefined' ? document.createElement('canvas') : undefined)
    return (target?.getContext('webgl2') as WebGL2RenderingContext | null | undefined) ?? null
  } catch {
    return null
  }
}
