import { describe, expect, test } from 'bun:test'

import { WebGL2Renderer } from '../src/ts/webgl2-renderer'
import { WebGPURenderer } from '../src/ts/webgpu-renderer'
import { AssRenderer } from '../src/ts/renderers'
import type { AssRenderedFrameData, AssSubtitleData } from '../src/ts/types'

const frame: AssSubtitleData = {
  width: 4,
  height: 3,
  compositionData: [
    {
      x: 1,
      y: 1,
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

describe('AkariSub-compatible GPU renderer composition surfaces', () => {
  test('WebGL2 renderer composites ASS planes without throwing when a GPU context is unavailable', () => {
    const renderer = new WebGL2Renderer()
    const result = renderer.render(frame)

    expect(result.backend).toBe('webgl2')
    expect(result.usedFallback).toBe(true)
    expect(result.width).toBe(4)
    expect(result.height).toBe(3)
    expect([...result.rgba.slice((1 * 4 + 1) * 4, (1 * 4 + 3) * 4)]).toEqual([
      255, 0, 0, 255,
      0, 255, 0, 128
    ])
  })

  test('WebGPU renderer exposes the same image composition contract as WebGL2', () => {
    const renderer = new WebGPURenderer()
    const result = renderer.render(frame)

    expect(result.backend).toBe('webgpu')
    expect(result.usedFallback).toBe(true)
    expect(result.compositionCount).toBe(1)
    expect(result.nonTransparentPixels).toBe(2)
    expect(result.alphaSum).toBe(383)
  })
})

describe('modern browser scheduling', () => {
  test('video render loop uses requestVideoFrameCallback instead of timer throttling', () => {
    let callback: VideoFrameRequestCallback | undefined
    let cancelled = 0
    const video = {
      currentTime: 0,
      videoWidth: 16,
      videoHeight: 9,
      getBoundingClientRect: () => ({ width: 16, height: 9 }),
      requestVideoFrameCallback: (cb: VideoFrameRequestCallback) => {
        callback = cb
        return 42
      },
      cancelVideoFrameCallback: (handle: number) => {
        cancelled = handle
      }
    } as unknown as HTMLVideoElement
    const canvas = {
      width: 16,
      height: 9,
      getContext: () => ({ clearRect() {}, drawImage() {} })
    } as unknown as HTMLCanvasElement

    const renderer = new AssRenderer({ video, canvas, subContent: '[Script Info]\n', autoLoad: false })
    renderer.start()
    expect(callback).toBeFunction()
    renderer.stop()
    expect(cancelled).toBe(42)
    renderer.destroy()
  })

  test('custom canvases stay on the main-thread Canvas2D path by default', () => {
    const canvas = {
      width: 16,
      height: 9,
      getContext: () => ({ clearRect() {}, drawImage() {} }),
      style: {}
    } as unknown as HTMLCanvasElement
    const renderer = new AssRenderer({ canvas, subContent: '[Script Info]\n', autoLoad: false })
    expect(renderer.rendererType).toBe('canvas2d')
    expect(renderer.isUsingGPURenderer).toBe(false)
    renderer.destroy()
  })

  test('places compact bounds frames at their ASS screen offset', () => {
    const operations: unknown[][] = []
    const canvas = {
      width: 16,
      height: 9,
      getContext: () => ({
        clearRect: (...args: unknown[]) => operations.push(['clear', ...args]),
        putImageData: (...args: unknown[]) => operations.push(['put', ...args]),
        drawImage: (...args: unknown[]) => operations.push(['draw', ...args])
      }),
      style: {}
    } as unknown as HTMLCanvasElement
    const renderer = new AssRenderer({ canvas, subContent: '[Script Info]\n', autoLoad: false })
    const imageData = { width: 2, height: 3, data: new Uint8ClampedArray(24) } as ImageData
    const compactFrame: AssRenderedFrameData = {
      imageData,
      bounds: { x: 4, y: 5, width: 2, height: 3 },
      offsetX: 4,
      offsetY: 5,
      screenWidth: 16,
      screenHeight: 9,
      crop: 'bounds',
      compositionCount: 1
    }

    const presentFrame = (renderer as unknown as {
      presentFrame: (frame: AssRenderedFrameData, planes: undefined, time: number) => boolean
    }).presentFrame.bind(renderer)

    expect(presentFrame(compactFrame, undefined, 0)).toBe(true)
    expect(operations[0]).toEqual(['clear', 0, 0, 16, 9])
    expect(operations[1]).toEqual(['put', imageData, 4, 5])
    expect(operations.some(([kind]) => kind === 'draw')).toBe(false)
    renderer.destroy()
  })
})
