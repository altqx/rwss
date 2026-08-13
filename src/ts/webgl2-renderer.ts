import type { AssSubtitleData, RenderImage, RwssPlaneData } from './types'
import { composeAssFrameCpu, limitAssImages, type RwssImageCompositionResult } from './gpu-compositor'

export class WebGL2Renderer {
  readonly type = 'webgl2' as const
  private _canvas?: HTMLCanvasElement | OffscreenCanvas
  private gl: WebGL2RenderingContext | null
  private program: WebGLProgram | null = null
  private vao: WebGLVertexArrayObject | null = null
  private buffer: WebGLBuffer | null = null
  private positionLocation = -1
  private texCoordLocation = -1
  private textureLocation: WebGLUniformLocation | null = null

  constructor(canvas?: HTMLCanvasElement | OffscreenCanvas) {
    this._canvas = canvas
    this.gl = getWebGL2Context(canvas)
  }

  get canvas(): HTMLCanvasElement | OffscreenCanvas | undefined {
    return this._canvas
  }

  get initialized(): boolean {
    return !!this.gl
  }

  async init(): Promise<void> {
    if (!this.gl) this.gl = getWebGL2Context(this._canvas)
    if (!this.gl) throw new Error('WebGL2 not supported')
  }

  async setCanvas(canvas: HTMLCanvasElement | OffscreenCanvas, width: number, height: number): Promise<void> {
    this._canvas = canvas
    this.gl = getWebGL2Context(canvas)
    if (width > 0) canvas.width = width
    if (height > 0) canvas.height = height
    if (!this.gl) throw new Error('Failed to create WebGL2 context')
    this.gl.viewport(0, 0, canvas.width, canvas.height)
  }

  updateSize(width: number, height: number): void {
    if (!this._canvas || width <= 0 || height <= 0) return
    this._canvas.width = width
    this._canvas.height = height
    this.gl?.viewport(0, 0, width, height)
  }

  render(data: AssSubtitleData): RwssImageCompositionResult
  render(images: RenderImage[], canvasWidth: number, canvasHeight: number): void
  render(dataOrImages: AssSubtitleData | RenderImage[], canvasWidth?: number, canvasHeight?: number): RwssImageCompositionResult | void {
    if (Array.isArray(dataOrImages)) {
      this.renderImages(dataOrImages, canvasWidth ?? this._canvas?.width ?? 1, canvasHeight ?? this._canvas?.height ?? 1)
      return
    }
    const data = dataOrImages
    try {
      return this.renderWithWebGL2(data)
    } catch {
      return composeAssFrameCpu(data, 'webgl2', true)
    }
  }

  renderBitmaps(images: { image: ImageBitmap; x: number; y: number }[], canvasWidth: number, canvasHeight: number): void {
    const normalized: RenderImage[] = images.map(({ image, x, y }) => ({ x, y, w: image.width, h: image.height, image }))
    this.renderImages(normalized, canvasWidth, canvasHeight)
  }

  clear(): void {
    if (!this.gl) return
    this.gl.clearColor(0, 0, 0, 0)
    this.gl.clear(this.gl.COLOR_BUFFER_BIT)
  }

  destroy(): void {
    const gl = this.gl
    if (!gl) return
    if (this.buffer) gl.deleteBuffer(this.buffer)
    if (this.vao) gl.deleteVertexArray(this.vao)
    if (this.program) gl.deleteProgram(this.program)
    this.buffer = null
    this.vao = null
    this.program = null
  }

  private renderImages(images: RenderImage[], canvasWidth: number, canvasHeight: number): void {
    if (!this.gl || !this._canvas) return
    const data: AssSubtitleData = {
      width: canvasWidth,
      height: canvasHeight,
      compositionData: limitAssImages(images)
        .filter((image) => image.w > 0 && image.h > 0 && typeof image.image !== 'number')
        .map(renderImageToPlane)
    }
    void this.renderWithWebGL2(data)
  }

  private renderWithWebGL2(data: AssSubtitleData): RwssImageCompositionResult {
    const gl = this.gl
    if (!gl || !this.canvas) return composeAssFrameCpu(data, 'webgl2', true)

    this.canvas.width = data.width
    this.canvas.height = data.height
    gl.viewport(0, 0, data.width, data.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.enable(gl.BLEND)
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

    this.ensurePipeline(gl)
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    gl.uniform1i(this.textureLocation, 0)

    const planes = limitAssImages(data.compositionData)
    for (const plane of planes) this.drawPlane(gl, data.width, data.height, plane)

    const bottomLeft = new Uint8Array(data.width * data.height * 4)
    gl.readPixels(0, 0, data.width, data.height, gl.RGBA, gl.UNSIGNED_BYTE, bottomLeft)
    const rgba = flipRows(bottomLeft, data.width, data.height)
    const coverage = alphaCoverage(rgba)
    return {
      backend: 'webgl2',
      width: data.width,
      height: data.height,
      rgba,
      compositionCount: planes.length,
      nonTransparentPixels: coverage.nonTransparentPixels,
      alphaSum: coverage.alphaSum,
      usedFallback: false
    }
  }

  private ensurePipeline(gl: WebGL2RenderingContext): void {
    if (this.program && this.vao && this.buffer) return

    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
out vec2 v_texCoord;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_texCoord = a_texCoord;
}
`)
    const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, `#version 300 es
precision mediump float;
uniform sampler2D u_texture;
in vec2 v_texCoord;
out vec4 outColor;
void main() {
  outColor = texture(u_texture, v_texCoord);
}
`)
    const program = gl.createProgram()
    if (!program) throw new Error('WebGL2 failed to create shader program')
    gl.attachShader(program, vertexShader)
    gl.attachShader(program, fragmentShader)
    gl.linkProgram(program)
    gl.deleteShader(vertexShader)
    gl.deleteShader(fragmentShader)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program) ?? 'unknown link error'
      gl.deleteProgram(program)
      throw new Error(`WebGL2 shader link failed: ${info}`)
    }

    const vao = gl.createVertexArray()
    const buffer = gl.createBuffer()
    if (!vao || !buffer) throw new Error('WebGL2 failed to allocate vertex buffers')

    this.program = program
    this.vao = vao
    this.buffer = buffer
    this.positionLocation = gl.getAttribLocation(program, 'a_position')
    this.texCoordLocation = gl.getAttribLocation(program, 'a_texCoord')
    this.textureLocation = gl.getUniformLocation(program, 'u_texture')
    if (this.positionLocation < 0 || this.texCoordLocation < 0 || !this.textureLocation) {
      throw new Error('WebGL2 shader attributes are unavailable')
    }

    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.enableVertexAttribArray(this.positionLocation)
    gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 16, 0)
    gl.enableVertexAttribArray(this.texCoordLocation)
    gl.vertexAttribPointer(this.texCoordLocation, 2, gl.FLOAT, false, 16, 8)
  }

  private drawPlane(gl: WebGL2RenderingContext, frameWidth: number, frameHeight: number, plane: RwssPlaneData): void {
    const texture = gl.createTexture()
    if (!texture) throw new Error('WebGL2 failed to allocate plane texture')
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)

    const source = tightlyPackedPlaneRgba(plane)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, plane.width, plane.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, source)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.bufferData(gl.ARRAY_BUFFER, planeVertices(plane, frameWidth, frameHeight), gl.STATIC_DRAW)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    gl.deleteTexture(texture)
  }
}

export function isWebGL2Supported(): boolean {
  if (typeof document === 'undefined') return false
  return !!document.createElement('canvas').getContext('webgl2')
}

function renderImageToPlane(image: RenderImage): RwssPlaneData {
  return {
    x: image.x,
    y: image.y,
    width: image.w,
    height: image.h,
    stride: image.w * 4,
    rgba: isImageBitmapValue(image.image) ? new Uint8Array(image.w * image.h * 4) : renderImageBytes(image.image),
    color: 0xffffffff,
    kind: 0
  }
}

function isImageBitmapValue(value: RenderImage['image']): value is ImageBitmap {
  return typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap
}

function renderImageBytes(value: RenderImage['image']): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (value instanceof Uint8Array) return value
  if (value instanceof Uint8ClampedArray) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  return new Uint8Array(0)
}

function getWebGL2Context(canvas?: HTMLCanvasElement | OffscreenCanvas): WebGL2RenderingContext | null {
  try {
    const target = canvas ?? (typeof document !== 'undefined' ? document.createElement('canvas') : undefined)
    return (target?.getContext('webgl2') as WebGL2RenderingContext | null | undefined) ?? null
  } catch {
    return null
  }
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('WebGL2 failed to create shader')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader) ?? 'unknown compile error'
    gl.deleteShader(shader)
    throw new Error(`WebGL2 shader compile failed: ${info}`)
  }
  return shader
}

function planeVertices(plane: RwssPlaneData, frameWidth: number, frameHeight: number): Float32Array {
  const left = pixelXToClip(plane.x, frameWidth)
  const right = pixelXToClip(plane.x + plane.width, frameWidth)
  const top = pixelYToClip(plane.y, frameHeight)
  const bottom = pixelYToClip(plane.y + plane.height, frameHeight)
  return new Float32Array([
    left, top, 0, 0,
    right, top, 1, 0,
    left, bottom, 0, 1,
    left, bottom, 0, 1,
    right, top, 1, 0,
    right, bottom, 1, 1
  ])
}

function pixelXToClip(x: number, width: number): number {
  return width > 0 ? x / width * 2 - 1 : -1
}

function pixelYToClip(y: number, height: number): number {
  return height > 0 ? 1 - y / height * 2 : 1
}

function tightlyPackedPlaneRgba(plane: RwssPlaneData): Uint8Array {
  const source = plane.rgba instanceof Uint8Array ? plane.rgba : new Uint8Array(plane.rgba)
  const strideBytes = plane.stride || plane.width * 4
  if (strideBytes === plane.width * 4 && source.byteLength >= plane.width * plane.height * 4) {
    return source.byteLength === plane.width * plane.height * 4 ? source : source.slice(0, plane.width * plane.height * 4)
  }

  const packed = new Uint8Array(plane.width * plane.height * 4)
  for (let y = 0; y < plane.height; y++) {
    const srcStart = y * strideBytes
    const dstStart = y * plane.width * 4
    packed.set(source.subarray(srcStart, srcStart + plane.width * 4), dstStart)
  }
  return packed
}

function flipRows(bottomLeftRgba: Uint8Array, width: number, height: number): Uint8Array {
  const flipped = new Uint8Array(bottomLeftRgba.length)
  const rowBytes = width * 4
  for (let y = 0; y < height; y++) {
    const srcStart = (height - 1 - y) * rowBytes
    const dstStart = y * rowBytes
    flipped.set(bottomLeftRgba.subarray(srcStart, srcStart + rowBytes), dstStart)
  }
  return flipped
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
