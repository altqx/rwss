import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { AssParser } from '../src/ts/parsers'
import type { AssMetadata, AssRenderedFrameData } from '../src/ts/types'
import { imageDataFromBytes, toCanvas } from '../src/ts/wasm'

const metadata: AssMetadata = {
  format: 'ass',
  cueCount: 0,
  styleCount: 0,
  attachmentCount: 0,
  playResX: 1,
  playResY: 1,
  layoutResX: 1,
  layoutResY: 1,
  wrapStyle: 0,
  scaledBorderAndShadow: true,
  language: ''
}

const originalImageData = Object.getOwnPropertyDescriptor(globalThis, 'ImageData')

class TestImageData {
  readonly data: Uint8ClampedArray
  readonly width: number
  readonly height: number

  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data
    this.width = width
    this.height = height
  }
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'ImageData', { configurable: true, value: TestImageData })
})

afterAll(() => {
  if (originalImageData) Object.defineProperty(globalThis, 'ImageData', originalImageData)
  else Reflect.deleteProperty(globalThis, 'ImageData')
})

describe('WASM frame boundaries', () => {
  test('uses one flattened WASM call for a screen frame', () => {
    let rawCalls = 0
    let frameCalls = 0
    const bytes = new Uint8Array([1, 2, 3, 4])
    const parser = createParser({
      renderAtTimestamp: () => {
        rawCalls++
        throw new Error('raw render should not run')
      },
      renderFrameDataAtTimestamp: () => {
        frameCalls++
        return wasmFrame(bytes, 1)
      }
    })

    const frame = parser.renderFrameDataAtTimestamp(1)

    expect(rawCalls).toBe(0)
    expect(frameCalls).toBe(1)
    expect(frame?.imageData.data[0]).toBe(1)
  })

  test('returns undefined from the flattened composition count without a raw render', () => {
    let rawCalls = 0
    let frameCalls = 0
    const parser = createParser({
      renderAtIndex: () => {
        rawCalls++
        throw new Error('raw render should not run')
      },
      renderFrameDataAtIndex: () => {
        frameCalls++
        return wasmFrame(new Uint8Array([0, 0, 0, 0]), 0)
      }
    })

    expect(parser.renderFrameDataAtIndex(0)).toBeUndefined()
    expect(rawCalls).toBe(0)
    expect(frameCalls).toBe(1)
  })

  test('uses the direct cropped WASM export and its compact dimensions', () => {
    let rawCalls = 0
    let boundsCalls = 0
    const parser = createParser({
      renderAtTimestamp: () => {
        rawCalls++
        throw new Error('raw render should not run')
      },
      renderFrameBoundsDataAtTimestamp: () => {
        boundsCalls++
        return wasmFrame(new Uint8Array(2 * 3 * 4), 1, {
          imageWidth: 2,
          imageHeight: 3,
          bounds: { x: 4, y: 5, width: 2, height: 3 },
          offsetX: 4,
          offsetY: 5,
          screenWidth: 16,
          screenHeight: 9,
          crop: 'bounds'
        })
      }
    })

    const frame = parser.renderFrameDataAtTimestamp(1, { crop: 'bounds' })

    expect(rawCalls).toBe(0)
    expect(boundsCalls).toBe(1)
    expect(frame?.imageData.width).toBe(2)
    expect(frame?.imageData.height).toBe(3)
    expect(frame?.offsetX).toBe(4)
    expect(frame?.offsetY).toBe(5)
  })

  test('views Uint8Array pixels without copying them', () => {
    const storage = new Uint8Array([99, 1, 2, 3, 4, 88])
    const bytes = storage.subarray(1, 5)
    const image = imageDataFromBytes(bytes, 1, 1)

    expect(image.data.buffer).toBe(bytes.buffer)
    expect(image.data.byteOffset).toBe(bytes.byteOffset)
    bytes[0] = 42
    expect(image.data[0]).toBe(42)
  })

  test('does not reset matching canvas dimensions', () => {
    let width = 2
    let height = 3
    let widthWrites = 0
    let heightWrites = 0
    let paints = 0
    const canvas = {
      get width() { return width },
      set width(value: number) { widthWrites++; width = value },
      get height() { return height },
      set height(value: number) { heightWrites++; height = value },
      getContext: () => ({ putImageData: () => { paints++ } })
    } as unknown as HTMLCanvasElement
    const frame = { imageData: imageDataFromBytes(new Uint8Array(24), 2, 3) } as AssRenderedFrameData

    expect(toCanvas(frame, canvas)).toBe(canvas)
    expect(widthWrites).toBe(0)
    expect(heightWrites).toBe(0)
    expect(paints).toBe(1)
  })
})

type FakeWasmParser = {
  metadata: () => AssMetadata
  timestamps: () => number[]
  renderAtIndex: (index: number) => unknown
  renderAtTimestamp: (time: number) => unknown
  renderFrameDataAtIndex: (index: number) => unknown
  renderFrameDataAtTimestamp: (time: number) => unknown
  renderFrameBoundsDataAtIndex: (index: number) => unknown
  renderFrameBoundsDataAtTimestamp: (time: number) => unknown
  getEvents: () => unknown[]
  getStyles: () => unknown[]
  clearCache: () => void
  dispose: () => void
}

function createParser(overrides: Partial<FakeWasmParser>): AssParser {
  const fake: FakeWasmParser = {
    metadata: () => metadata,
    timestamps: () => [],
    renderAtIndex: () => ({ width: 1, height: 1, compositionData: [] }),
    renderAtTimestamp: () => ({ width: 1, height: 1, compositionData: [] }),
    renderFrameDataAtIndex: () => wasmFrame(new Uint8Array(4), 0),
    renderFrameDataAtTimestamp: () => wasmFrame(new Uint8Array(4), 0),
    renderFrameBoundsDataAtIndex: () => wasmFrame(new Uint8Array(0), 0),
    renderFrameBoundsDataAtTimestamp: () => wasmFrame(new Uint8Array(0), 0),
    getEvents: () => [],
    getStyles: () => [],
    clearCache: () => {},
    dispose: () => {},
    ...overrides
  }
  const Constructor = AssParser as unknown as new (parser: FakeWasmParser) => AssParser
  return new Constructor(fake)
}

function wasmFrame(
  imageData: Uint8Array,
  compositionCount: number,
  overrides: Partial<{
    imageWidth: number
    imageHeight: number
    bounds: { x: number; y: number; width: number; height: number } | null
    offsetX: number
    offsetY: number
    screenWidth: number
    screenHeight: number
    crop: 'screen' | 'bounds'
  }> = {}
) {
  return {
    imageData,
    imageWidth: 1,
    imageHeight: 1,
    bounds: null,
    offsetX: 0,
    offsetY: 0,
    screenWidth: 1,
    screenHeight: 1,
    crop: 'screen' as const,
    compositionCount,
    ...overrides
  }
}
