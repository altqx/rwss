import { describe, expect, test } from 'bun:test'

import { WebGL2Renderer } from '../src/ts/webgl2-renderer'
import type { AssSubtitleData } from '../src/ts/types'

const GL = {
  VERTEX_SHADER: 0x8B31,
  FRAGMENT_SHADER: 0x8B30,
  COMPILE_STATUS: 0x8B81,
  LINK_STATUS: 0x8B82,
  ARRAY_BUFFER: 0x8892,
  STATIC_DRAW: 0x88E4,
  DYNAMIC_DRAW: 0x88E8,
  FLOAT: 0x1406,
  TEXTURE_2D: 0x0DE1,
  TEXTURE0: 0x84C0,
  RGBA: 0x1908,
  UNSIGNED_BYTE: 0x1401,
  TRIANGLES: 0x0004,
  COLOR_BUFFER_BIT: 0x4000,
  BLEND: 0x0BE2,
  SRC_ALPHA: 0x0302,
  ONE_MINUS_SRC_ALPHA: 0x0303,
  ONE: 1,
  CLAMP_TO_EDGE: 0x812F,
  NEAREST: 0x2600,
  TEXTURE_WRAP_S: 0x2802,
  TEXTURE_WRAP_T: 0x2803,
  TEXTURE_MIN_FILTER: 0x2801,
  TEXTURE_MAG_FILTER: 0x2800,
  UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241
}

class FakeWebGL2RenderingContext {
  readonly calls: string[] = []
  readonly uploadedTextures: Array<{ width: number; height: number; data: number[] }> = []
  readonly drawnVertexData: number[][] = []
  canvas = { width: 0, height: 0 }

  readonly VERTEX_SHADER = GL.VERTEX_SHADER
  readonly FRAGMENT_SHADER = GL.FRAGMENT_SHADER
  readonly COMPILE_STATUS = GL.COMPILE_STATUS
  readonly LINK_STATUS = GL.LINK_STATUS
  readonly ARRAY_BUFFER = GL.ARRAY_BUFFER
  readonly STATIC_DRAW = GL.STATIC_DRAW
  readonly DYNAMIC_DRAW = GL.DYNAMIC_DRAW
  readonly FLOAT = GL.FLOAT
  readonly TEXTURE_2D = GL.TEXTURE_2D
  readonly TEXTURE0 = GL.TEXTURE0
  readonly RGBA = GL.RGBA
  readonly UNSIGNED_BYTE = GL.UNSIGNED_BYTE
  readonly TRIANGLES = GL.TRIANGLES
  readonly COLOR_BUFFER_BIT = GL.COLOR_BUFFER_BIT
  readonly BLEND = GL.BLEND
  readonly SRC_ALPHA = GL.SRC_ALPHA
  readonly ONE_MINUS_SRC_ALPHA = GL.ONE_MINUS_SRC_ALPHA
  readonly ONE = GL.ONE
  readonly CLAMP_TO_EDGE = GL.CLAMP_TO_EDGE
  readonly NEAREST = GL.NEAREST
  readonly TEXTURE_WRAP_S = GL.TEXTURE_WRAP_S
  readonly TEXTURE_WRAP_T = GL.TEXTURE_WRAP_T
  readonly TEXTURE_MIN_FILTER = GL.TEXTURE_MIN_FILTER
  readonly TEXTURE_MAG_FILTER = GL.TEXTURE_MAG_FILTER
  readonly UNPACK_PREMULTIPLY_ALPHA_WEBGL = GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL

  private currentArrayBuffer: { data?: Float32Array } | null = null

  createShader(type: number) { this.calls.push(`createShader:${type}`); return { type } }
  shaderSource() { this.calls.push('shaderSource') }
  compileShader() { this.calls.push('compileShader') }
  getShaderParameter() { return true }
  getShaderInfoLog() { return '' }
  createProgram() { this.calls.push('createProgram'); return {} }
  attachShader() { this.calls.push('attachShader') }
  linkProgram() { this.calls.push('linkProgram') }
  getProgramParameter() { return true }
  getProgramInfoLog() { return '' }
  deleteShader() { this.calls.push('deleteShader') }
  useProgram() { this.calls.push('useProgram') }
  getAttribLocation(_program: unknown, name: string) { return name === 'a_position' ? 0 : 1 }
  getUniformLocation(_program: unknown, name: string) { return { name } }
  createVertexArray() { this.calls.push('createVertexArray'); return {} }
  bindVertexArray() { this.calls.push('bindVertexArray') }
  createBuffer() { this.calls.push('createBuffer'); return {} }
  bindBuffer(_target: number, buffer: { data?: Float32Array } | null) { this.currentArrayBuffer = buffer; this.calls.push('bindBuffer') }
  bufferData(_target: number, data: Float32Array | number) {
    this.calls.push('bufferData')
    if (this.currentArrayBuffer && data instanceof Float32Array) this.currentArrayBuffer.data = data
  }
  bufferSubData(_target: number, _offset: number, data: Float32Array) {
    this.calls.push('bufferSubData')
    if (this.currentArrayBuffer) this.currentArrayBuffer.data = data
    this.drawnVertexData.push([...data])
  }
  enableVertexAttribArray(index: number) { this.calls.push(`enableVertexAttribArray:${index}`) }
  vertexAttribPointer(index: number) { this.calls.push(`vertexAttribPointer:${index}`) }
  viewport(_x: number, _y: number, w: number, h: number) { this.calls.push(`viewport:${w}x${h}`) }
  clearColor() { this.calls.push('clearColor') }
  clear() { this.calls.push('clear') }
  enable(cap: number) { this.calls.push(`enable:${cap}`) }
  blendFuncSeparate() { this.calls.push('blendFuncSeparate') }
  activeTexture() { this.calls.push('activeTexture') }
  createTexture() { this.calls.push('createTexture'); return {} }
  bindTexture() { this.calls.push('bindTexture') }
  texParameteri() { this.calls.push('texParameteri') }
  pixelStorei() { this.calls.push('pixelStorei') }
  texImage2D(_target: number, _level: number, _internal: number, width: number, height: number, _border: number, _format: number, _type: number, data: Uint8Array) {
    this.calls.push(`texImage2D:${width}x${height}`)
    this.uploadedTextures.push({ width, height, data: [...data] })
  }
  uniform1i() { this.calls.push('uniform1i') }
  drawArrays(_mode: number, _first: number, count: number) { this.calls.push(`drawArrays:${count}`) }
  readPixels(_x: number, _y: number, width: number, height: number, _format: number, _type: number, pixels: Uint8Array) {
    this.calls.push(`readPixels:${width}x${height}`)
    // WebGL readPixels is bottom-left origin; renderer must flip this to top-left.
    pixels.set([
      0, 0, 255, 255, 0, 0, 0, 0,
      255, 0, 0, 255, 0, 255, 0, 128
    ])
  }
  deleteTexture() { this.calls.push('deleteTexture') }
  deleteBuffer() { this.calls.push('deleteBuffer') }
  deleteVertexArray() { this.calls.push('deleteVertexArray') }
  deleteProgram() { this.calls.push('deleteProgram') }
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

describe('real WebGL2 compositor path', () => {
  test('uploads ASS planes as textures, draws them through WebGL2, and reads back top-left RGBA', () => {
    const gl = new FakeWebGL2RenderingContext()
    const canvas = {
      width: 0,
      height: 0,
      getContext: (kind: string) => kind === 'webgl2' ? gl : null
    }
    const renderer = new WebGL2Renderer(canvas as unknown as HTMLCanvasElement)

    const result = renderer.render(frame)

    expect(result.backend).toBe('webgl2')
    expect(result.usedFallback).toBe(false)
    expect(canvas.width).toBe(2)
    expect(canvas.height).toBe(2)
    expect(gl.calls).toContain('createShader:35633')
    expect(gl.calls).toContain('createShader:35632')
    expect(gl.calls).toContain('texImage2D:2x1')
    expect(gl.calls).toContain('drawArrays:6')
    expect(gl.calls).toContain('readPixels:2x2')
    expect(gl.uploadedTextures[0].data).toEqual([...frame.compositionData[0].rgba])
    expect(gl.drawnVertexData[0]).toEqual([
      -1, 1, 0, 0,
      1, 1, 1, 0,
      -1, 0, 0, 1,
      -1, 0, 0, 1,
      1, 1, 1, 0,
      1, 0, 1, 1
    ])
    expect([...result.rgba]).toEqual([
      255, 0, 0, 255, 0, 255, 0, 128,
      0, 0, 255, 255, 0, 0, 0, 0
    ])
    expect(result.nonTransparentPixels).toBe(3)
    expect(result.alphaSum).toBe(638)
  })

  test('presents directly without readback and reuses its texture and vertex resources', () => {
    const gl = new FakeWebGL2RenderingContext()
    const canvas = {
      width: 2,
      height: 2,
      getContext: (kind: string) => kind === 'webgl2' ? gl : null
    }
    const renderer = new WebGL2Renderer(canvas as unknown as HTMLCanvasElement)
    const twoPlanes: AssSubtitleData = {
      ...frame,
      compositionData: [frame.compositionData[0], { ...frame.compositionData[0], y: 1 }]
    }

    renderer.present(twoPlanes)
    renderer.present(twoPlanes)

    expect(gl.calls.filter((call) => call === 'createTexture')).toHaveLength(1)
    expect(gl.calls.filter((call) => call === 'createBuffer')).toHaveLength(1)
    expect(gl.calls.filter((call) => call === 'bufferSubData')).toHaveLength(4)
    expect(gl.calls.filter((call) => call.startsWith('readPixels:'))).toHaveLength(0)
    expect(gl.calls).not.toContain('deleteTexture')
    expect(gl.drawnVertexData).toHaveLength(4)

    renderer.destroy()
    expect(gl.calls.filter((call) => call === 'deleteTexture')).toHaveLength(1)
  })

  test('does not reset unchanged canvas dimensions', () => {
    const gl = new FakeWebGL2RenderingContext()
    let width = 2
    let height = 2
    let widthWrites = 0
    let heightWrites = 0
    const canvas = {
      get width() { return width },
      set width(value: number) { width = value; widthWrites++ },
      get height() { return height },
      set height(value: number) { height = value; heightWrites++ },
      getContext: (kind: string) => kind === 'webgl2' ? gl : null
    }
    const renderer = new WebGL2Renderer(canvas as unknown as HTMLCanvasElement)

    renderer.present(frame)
    renderer.updateSize(2, 2)

    expect(widthWrites).toBe(0)
    expect(heightWrites).toBe(0)
  })
})
