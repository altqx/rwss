import type { AssSubtitleData, WrassPlaneData } from './types'

export type WrassImageCompositionBackend = 'webgpu' | 'webgl2' | 'canvas2d'

export interface WrassImageCompositionResult {
  backend: WrassImageCompositionBackend
  width: number
  height: number
  rgba: Uint8Array
  compositionCount: number
  nonTransparentPixels: number
  alphaSum: number
  usedFallback: boolean
}

export interface WrassImageCompositorOptions {
  canvas?: HTMLCanvasElement | OffscreenCanvas
  backend: WrassImageCompositionBackend
  preferGpu?: boolean
}

export function composeAssFrameCpu(data: AssSubtitleData, backend: WrassImageCompositionBackend, usedFallback = true): WrassImageCompositionResult {
  const rgba = new Uint8Array(data.width * data.height * 4)
  for (const plane of data.compositionData) blendPlane(rgba, data.width, data.height, plane)
  const coverage = alphaCoverage(rgba)
  return {
    backend,
    width: data.width,
    height: data.height,
    rgba,
    compositionCount: data.compositionData.length,
    nonTransparentPixels: coverage.nonTransparentPixels,
    alphaSum: coverage.alphaSum,
    usedFallback
  }
}

export function putCompositionOnCanvas(result: WrassImageCompositionResult, canvas?: HTMLCanvasElement | OffscreenCanvas): void {
  if (!canvas || typeof ImageData === 'undefined') return
  canvas.width = result.width
  canvas.height = result.height
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  if (!ctx) return
  ctx.putImageData(new ImageData(new Uint8ClampedArray(result.rgba), result.width, result.height), 0, 0)
}

function blendPlane(target: Uint8Array, targetWidth: number, targetHeight: number, plane: WrassPlaneData): void {
  const source = plane.rgba instanceof Uint8Array ? plane.rgba : new Uint8Array(plane.rgba)
  const stridePixels = Math.max(plane.width, Math.floor((plane.stride || plane.width * 4) / 4))
  for (let py = 0; py < plane.height; py++) {
    const dstY = plane.y + py
    if (dstY < 0 || dstY >= targetHeight) continue
    for (let px = 0; px < plane.width; px++) {
      const dstX = plane.x + px
      if (dstX < 0 || dstX >= targetWidth) continue
      const src = (py * stridePixels + px) * 4
      const dst = (dstY * targetWidth + dstX) * 4
      const srcAlpha = source[src + 3] / 255
      if (srcAlpha <= 0) continue
      const dstAlpha = target[dst + 3] / 255
      const outAlpha = srcAlpha + dstAlpha * (1 - srcAlpha)
      target[dst] = Math.round(((source[src] / 255) * srcAlpha + (target[dst] / 255) * dstAlpha * (1 - srcAlpha)) / outAlpha * 255)
      target[dst + 1] = Math.round(((source[src + 1] / 255) * srcAlpha + (target[dst + 1] / 255) * dstAlpha * (1 - srcAlpha)) / outAlpha * 255)
      target[dst + 2] = Math.round(((source[src + 2] / 255) * srcAlpha + (target[dst + 2] / 255) * dstAlpha * (1 - srcAlpha)) / outAlpha * 255)
      target[dst + 3] = Math.round(outAlpha * 255)
    }
  }
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
