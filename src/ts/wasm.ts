import type {
  AssFrameRenderOptions,
  AssRenderedFrameData,
  AssSubtitleData,
  RwssFrameCropMode,
  RwssPlaneData,
  RwssFontSource,
  RwssRegisteredFont,
  RwssResolvedFont,
  RwssFontLoadOptions,
  RwssAvailableFontLoadOptions
} from './types'

type WasmModule = typeof import('../../pkg/rwss')

export const DEFAULT_FALLBACK_FONTS = ['liberation sans']
export const DEFAULT_AVAILABLE_FONTS: Record<string, string | Uint8Array | ArrayBuffer | ArrayBufferView> = {
  'liberation sans': new URL('../default.woff2', import.meta.url).toString()
}

let wasmModule: WasmModule | null = null
let wasmInitPromise: Promise<WasmModule> | null = null
let wasmUrl: string | URL | Request = getDefaultWasmUrl()

export async function initWasm(input?: string | URL | Request): Promise<WasmModule> {
  if (wasmModule) return wasmModule
  if (wasmInitPromise) return wasmInitPromise

  const selectedWasmUrl = input ?? getDefaultWasmUrl()
  wasmUrl = selectedWasmUrl
  wasmInitPromise = (async () => {
    try {
      const mod = await import('../../pkg/rwss')
      const init = (mod as unknown as { default?: (input?: { module_or_path: string | URL | Request } | string | URL | Request) => Promise<unknown> }).default
      if (init) await (input === undefined ? init() : init({ module_or_path: selectedWasmUrl }))
      wasmModule = mod
      return mod
    } catch (error) {
      wasmInitPromise = null
      throw error
    }
  })()
  return wasmInitPromise
}

export function isWasmInitialized(): boolean {
  return wasmModule !== null
}

export function getWasm(): WasmModule {
  if (!wasmModule) {
    throw new Error('rwss WASM is not initialized. Call initWasm() first.')
  }
  return wasmModule
}

export function getWasmUrl(): string | URL | Request {
  return wasmUrl
}

function getDefaultWasmUrl(): string {
  try {
    return new URL('../../pkg/rwss_bg.wasm', import.meta.url).href
  } catch {
    if (typeof window !== 'undefined') {
      return new URL('/rwss/rwss_bg.wasm', window.location.origin).href
    }
    return '/rwss/rwss_bg.wasm'
  }
}

if (typeof window !== 'undefined') {
  setTimeout(() => {
    initWasm().catch((error) => console.warn('[rwss] WASM pre-init failed:', error))
  }, 100)
}

export async function registerFont(font: RwssFontSource | string, data?: Uint8Array | ArrayBuffer | ArrayBufferView, options?: RwssFontLoadOptions): Promise<string | undefined> {
  await initWasm(wasmUrl)
  if (typeof font === 'string') {
    const bytes = data ? toUint8Array(data) : await fetchFontBytes(font, options?.timeoutMs)
    if (!bytes) return undefined
    return registerFontBytes(inferFontNameFromUrl(font, options?.name), bytes, { ...options, aliases: dedupeAliases([...(options?.aliases ?? []), inferFontNameFromUrl(font)]) })
  }
  return registerFontData(font.data, { ...font, ...options, aliases: dedupeAliases([...(font.aliases ?? []), ...(options?.aliases ?? [])]) })
}

export async function registerAvailableFonts(fonts?: Record<string, string | Uint8Array | ArrayBuffer | ArrayBufferView>, options: RwssAvailableFontLoadOptions = {}): Promise<string[]> {
  if (!fonts) return []
  await initWasm(wasmUrl)
  if (options.fallbackFonts) setFallbackFonts(options.fallbackFonts)
  const registered: string[] = []
  for (const [name, value] of Object.entries(fonts)) {
    const cleanName = normalizeFontFamily(name)
    const aliases = dedupeAliases([name, cleanName])
    if (typeof value === 'string') {
      const bytes = await fetchFontBytes(value, options.timeoutMs)
      if (!bytes) continue
      registered.push(registerFontBytes(cleanName, bytes, { aliases, isFallback: true }))
      continue
    }
    registered.push(registerFontBytes(cleanName, value, { aliases, isFallback: true }))
  }
  return registered
}

export function registerFontBytes(name: string, data: Uint8Array | ArrayBuffer | ArrayBufferView, options?: RwssFontLoadOptions): string {
  const mod = getWasm() as WasmModule & { registerFont?: (name: string, bytes: Uint8Array, options?: unknown) => string }
  if (!mod.registerFont) throw new Error('rwss WASM registerFont export is unavailable; rebuild pkg with wasm-pack')
  return mod.registerFont(name, toUint8Array(data), options)
}

export function registerFontData(data: Uint8Array | ArrayBuffer | ArrayBufferView, options?: RwssFontLoadOptions): string {
  const mod = getWasm() as WasmModule & { registerFontData?: (bytes: Uint8Array, options?: unknown) => string }
  if (!mod.registerFontData) throw new Error('rwss WASM registerFontData export is unavailable; rebuild pkg with wasm-pack')
  return mod.registerFontData(toUint8Array(data), options)
}

export function setFallbackFonts(fonts: string[]): void {
  const mod = getWasm() as WasmModule & { setFallbackFonts?: (fonts: string[]) => void }
  mod.setFallbackFonts?.(fonts)
}

export function clearRegisteredFonts(): void {
  const mod = getWasm() as WasmModule & { clearRegisteredFonts?: () => void }
  mod.clearRegisteredFonts?.()
}

export function listRegisteredFonts(): RwssRegisteredFont[] {
  const mod = getWasm() as WasmModule & { listRegisteredFonts?: () => RwssRegisteredFont[] }
  return mod.listRegisteredFonts?.() ?? []
}

export function resolveFont(name: string): RwssResolvedFont | null {
  const mod = getWasm() as WasmModule & { resolveFont?: (name: string) => RwssResolvedFont }
  return mod.resolveFont?.(name) ?? null
}

async function fetchFontBytes(url: string, timeoutMs = 30000): Promise<Uint8Array | undefined> {
  if (typeof fetch !== 'function') return undefined
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined
  try {
    const response = await fetch(url, controller ? { signal: controller.signal } : undefined)
    if (!response.ok && response.status !== 0) return undefined
    return new Uint8Array(await response.arrayBuffer())
  } catch {
    return undefined
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

function inferFontNameFromUrl(url: string, fallback = 'font'): string {
  const clean = url.split(/[?#]/, 1)[0]
  const tail = clean.split('/').filter(Boolean).pop() ?? fallback
  return tail.replace(/\.(ttf|otf|ttc|otc|woff2?|bin)$/i, '') || fallback
}

function normalizeFontFamily(name: string): string {
  const trimmed = name.trim().toLowerCase()
  return trimmed.startsWith('@') ? trimmed.slice(1) : trimmed
}

function dedupeAliases(values: (string | undefined)[]): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => !!value))]
}

function toUint8Array(data: Uint8Array | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

export function imageDataFromBytes(bytes: Uint8Array | number[], width: number, height: number): ImageData {
  const data = bytes instanceof Uint8Array ? new Uint8ClampedArray(bytes) : new Uint8ClampedArray(bytes)
  return new ImageData(data, width, height)
}

export function planeToImageData(plane: RwssPlaneData): ImageData {
  return imageDataFromBytes(plane.rgba, plane.width, plane.height)
}

export function normalizeFrameData(raw: Omit<AssRenderedFrameData, 'imageData'> & { imageData: Uint8Array | number[] }): AssRenderedFrameData {
  return {
    ...raw,
    imageData: imageDataFromBytes(raw.imageData, raw.screenWidth, raw.screenHeight)
  }
}

export function renderAssDataToFrame(data: AssSubtitleData, crop: RwssFrameCropMode = 'screen'): AssRenderedFrameData {
  const bounds = getAssBounds(data.compositionData)
  const targetBounds = crop === 'bounds' && bounds ? bounds : { x: 0, y: 0, width: data.width, height: data.height }
  const imageData = new ImageData(targetBounds.width, targetBounds.height)

  for (const plane of data.compositionData) {
    blendPlane(imageData.data, targetBounds.width, targetBounds.height, plane, targetBounds.x, targetBounds.y)
  }

  return {
    imageData,
    bounds,
    offsetX: targetBounds.x,
    offsetY: targetBounds.y,
    screenWidth: data.width,
    screenHeight: data.height,
    crop,
    compositionCount: data.compositionData.length
  }
}

export function renderFrameData(data: AssSubtitleData, options?: AssFrameRenderOptions): AssRenderedFrameData {
  return renderAssDataToFrame(data, options?.crop ?? 'screen')
}

export function toCanvas(frame: AssRenderedFrameData, canvas?: HTMLCanvasElement | OffscreenCanvas): HTMLCanvasElement | OffscreenCanvas {
  const target = canvas ?? document.createElement('canvas')
  target.width = frame.imageData.width
  target.height = frame.imageData.height
  const ctx = target.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  if (!ctx) throw new Error('Canvas 2D context is unavailable')
  ctx.putImageData(frame.imageData, 0, 0)
  return target
}

export async function toBlob(frame: AssRenderedFrameData, type = 'image/png', quality?: number): Promise<Blob> {
  const canvas = toCanvas(frame)
  if ('convertToBlob' in canvas) {
    return (canvas as OffscreenCanvas).convertToBlob({ type, quality })
  }
  return new Promise((resolve, reject) => {
    ;(canvas as HTMLCanvasElement).toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Failed to encode canvas'))), type, quality)
  })
}

export async function toImageBitmap(frame: AssRenderedFrameData): Promise<ImageBitmap> {
  return createImageBitmap(frame.imageData)
}

export function getAssBounds(planes: RwssPlaneData[]) {
  let xMin = Infinity
  let yMin = Infinity
  let xMax = -Infinity
  let yMax = -Infinity
  for (const plane of planes) {
    if (plane.width <= 0 || plane.height <= 0) continue
    xMin = Math.min(xMin, plane.x)
    yMin = Math.min(yMin, plane.y)
    xMax = Math.max(xMax, plane.x + plane.width)
    yMax = Math.max(yMax, plane.y + plane.height)
  }
  if (!Number.isFinite(xMin) || xMin >= xMax || yMin >= yMax) return null
  return { x: xMin, y: yMin, width: xMax - xMin, height: yMax - yMin }
}

function blendPlane(
  target: Uint8ClampedArray,
  targetWidth: number,
  targetHeight: number,
  plane: RwssPlaneData,
  offsetX: number,
  offsetY: number
): void {
  const rgba = plane.rgba instanceof Uint8Array ? plane.rgba : new Uint8Array(plane.rgba)
  for (let y = 0; y < plane.height; y++) {
    const dstY = plane.y + y - offsetY
    if (dstY < 0 || dstY >= targetHeight) continue
    for (let x = 0; x < plane.width; x++) {
      const dstX = plane.x + x - offsetX
      if (dstX < 0 || dstX >= targetWidth) continue
      const src = (y * plane.width + x) * 4
      const dst = (dstY * targetWidth + dstX) * 4
      const srcAlpha = rgba[src + 3] / 255
      const dstAlpha = target[dst + 3] / 255
      const outAlpha = srcAlpha + dstAlpha * (1 - srcAlpha)
      if (outAlpha <= 0) continue
      target[dst] = Math.round(((rgba[src] / 255) * srcAlpha + (target[dst] / 255) * dstAlpha * (1 - srcAlpha)) / outAlpha * 255)
      target[dst + 1] = Math.round(((rgba[src + 1] / 255) * srcAlpha + (target[dst + 1] / 255) * dstAlpha * (1 - srcAlpha)) / outAlpha * 255)
      target[dst + 2] = Math.round(((rgba[src + 2] / 255) * srcAlpha + (target[dst + 2] / 255) * dstAlpha * (1 - srcAlpha)) / outAlpha * 255)
      target[dst + 3] = Math.round(outAlpha * 255)
    }
  }
}
