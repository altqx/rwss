/**
 * WASM module management for rwss.
 * Matches libbitsub: package glue via import.meta.url, optional worker glue URL.
 */

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
type WasmGlue = WasmModule & {
  default?: (input?: { module_or_path: string | URL | Request } | string | URL | Request) => Promise<unknown>
}

/** Default fallback font family list. */
export const DEFAULT_FALLBACK_FONTS = ['liberation sans']
/** Packaged Liberation Sans mapping used when no fonts are supplied. */
export const DEFAULT_AVAILABLE_FONTS: Record<string, string | Uint8Array | ArrayBuffer | ArrayBufferView> = {
  'liberation sans': new URL('../default.woff2', import.meta.url).toString()
}

let wasmModule: WasmModule | null = null
let wasmInitPromise: Promise<WasmModule> | null = null

/** Initialize the generated WASM module. Safe to call more than once. */
export async function initWasm(input?: string | URL | Request, glueUrl?: string): Promise<WasmModule> {
  if (wasmModule) return wasmModule
  if (wasmInitPromise) return wasmInitPromise

  wasmInitPromise = (async () => {
    try {
      const mod = await loadWasmGlue(glueUrl)
      const init = (mod as WasmGlue).default
      if (init) await (input === undefined ? init() : init({ module_or_path: input }))
      wasmModule = mod
      return mod
    } catch (error) {
      wasmInitPromise = null
      throw error
    }
  })()
  return wasmInitPromise
}

/** Whether initWasm() has completed. */
export function isWasmInitialized(): boolean {
  return wasmModule !== null
}

/** Return the initialized WASM module, or throw if it is not ready. */
export function getWasm(): WasmModule {
  if (!wasmModule) {
    throw new Error('rwss WASM is not initialized. Call initWasm() first.')
  }
  return wasmModule
}

/** Return the WASM file URL (always an absolute URL). */
export function getWasmUrl(): string {
  return resolvePackageAssetUrl('../../pkg/rwss_bg.wasm', '/rwss/rwss_bg.wasm')
}

/** Return the wasm-bindgen glue script URL (always an absolute URL). */
export function getWasmGlueUrl(): string {
  return resolvePackageAssetUrl('../../pkg/rwss.js', '/rwss/rwss.js')
}

/** Resolve the wasm/glue URLs a worker should load, matching libbitsub. */
export function resolveWasmLoadUrls(wasmUrl?: string | URL | Request): { wasmUrl: string; glueUrl: string } {
  if (wasmUrl === undefined) {
    return { wasmUrl: getWasmUrl(), glueUrl: getWasmGlueUrl() }
  }
  const resolvedWasmUrl = String(wasmUrl)
  return { wasmUrl: resolvedWasmUrl, glueUrl: deriveGlueUrl(resolvedWasmUrl) ?? getWasmGlueUrl() }
}

function resolvePackageAssetUrl(relativeFromModule: string, publicFallback: string): string {
  try {
    return new URL(relativeFromModule, import.meta.url).href
  } catch {
    if (typeof window !== 'undefined') {
      return new URL(publicFallback, window.location.origin).href
    }
    return publicFallback
  }
}

function deriveGlueUrl(wasmUrl: string | URL | Request): string | undefined {
  const raw = String(wasmUrl)
  if (/_bg\.wasm(?:\?.*)?$/i.test(raw)) return raw.replace(/_bg\.wasm(?=\?|$)/i, '.js')
  try {
    const derivedUrl = new URL(raw)
    if (!/_bg\.wasm$/i.test(derivedUrl.pathname)) return undefined
    derivedUrl.pathname = derivedUrl.pathname.replace(/_bg\.wasm$/i, '.js')
    return derivedUrl.href
  } catch {
    return undefined
  }
}

async function loadWasmGlue(glueUrl?: string): Promise<WasmModule> {
  if (!glueUrl) return import('../../pkg/rwss')
  const importer = new Function('url', 'return import(url)') as (url: string) => Promise<WasmModule>
  return importer(glueUrl)
}

if (typeof window !== 'undefined') {
  setTimeout(() => {
    initWasm().catch((error) => console.warn('[rwss] WASM pre-init failed:', error))
  }, 100)
}

/** Register a font from a URL, bytes, or RwssFontSource. */
export async function registerFont(font: RwssFontSource | string, data?: Uint8Array | ArrayBuffer | ArrayBufferView, options?: RwssFontLoadOptions): Promise<string | undefined> {
  await initWasm()
  if (typeof font === 'string') {
    const bytes = data ? toUint8Array(data) : await fetchFontBytes(font, options?.timeoutMs)
    if (!bytes) return undefined
    return registerFontBytes(inferFontNameFromUrl(font, options?.name), bytes, { ...options, aliases: dedupeAliases([...(options?.aliases ?? []), inferFontNameFromUrl(font)]) })
  }
  return registerFontData(font.data, { ...font, ...options, aliases: dedupeAliases([...(font.aliases ?? []), ...(options?.aliases ?? [])]) })
}

/** Register a named map of fonts and optional fallbacks. */
export async function registerAvailableFonts(fonts?: Record<string, string | Uint8Array | ArrayBuffer | ArrayBufferView>, options: RwssAvailableFontLoadOptions = {}): Promise<string[]> {
  if (!fonts) return []
  await initWasm()
  if (options.fallbackFonts) setFallbackFonts(options.fallbackFonts)
  const loaded = await Promise.all(Object.entries(fonts).map(async ([name, value]) => ({
    name,
    bytes: typeof value === 'string' ? await fetchFontBytes(value, options.timeoutMs) : value
  })))
  const registered: string[] = []
  for (const { name, bytes } of loaded) {
    if (!bytes) continue
    const cleanName = normalizeFontFamily(name)
    const aliases = dedupeAliases([name, cleanName])
    registered.push(registerFontBytes(cleanName, bytes, { aliases, isFallback: true }))
  }
  return registered
}

/** Register already-loaded font bytes under a family name. */
export function registerFontBytes(name: string, data: Uint8Array | ArrayBuffer | ArrayBufferView, options?: RwssFontLoadOptions): string {
  const mod = getWasm() as WasmModule & { registerFont?: (name: string, bytes: Uint8Array, options?: unknown) => string }
  if (!mod.registerFont) throw new Error('rwss WASM registerFont export is unavailable; rebuild pkg with wasm-pack')
  return mod.registerFont(name, toUint8Array(data), options)
}

/** Register font bytes and infer family metadata from options. */
export function registerFontData(data: Uint8Array | ArrayBuffer | ArrayBufferView, options?: RwssFontLoadOptions): string {
  const mod = getWasm() as WasmModule & { registerFontData?: (bytes: Uint8Array, options?: unknown) => string }
  if (!mod.registerFontData) throw new Error('rwss WASM registerFontData export is unavailable; rebuild pkg with wasm-pack')
  return mod.registerFontData(toUint8Array(data), options)
}

/** Replace the virtual font registry fallback list. */
export function setFallbackFonts(fonts: string[]): void {
  const mod = getWasm() as WasmModule & { setFallbackFonts?: (fonts: string[]) => void }
  mod.setFallbackFonts?.(fonts)
}

/** Remove every font from the virtual registry. */
export function clearRegisteredFonts(): void {
  const mod = getWasm() as WasmModule & { clearRegisteredFonts?: () => void }
  mod.clearRegisteredFonts?.()
}

/** List fonts currently in the virtual registry. */
export function listRegisteredFonts(): RwssRegisteredFont[] {
  const mod = getWasm() as WasmModule & { listRegisteredFonts?: () => RwssRegisteredFont[] }
  return mod.listRegisteredFonts?.() ?? []
}

/** Resolve a family name through the virtual font registry. */
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

/** Wrap raw RGBA bytes in an ImageData. */
export function imageDataFromBytes(bytes: Uint8Array | number[], width: number, height: number): ImageData {
  const data = bytes instanceof Uint8Array && bytes.buffer instanceof ArrayBuffer
    ? new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8ClampedArray(bytes)
  return new ImageData(data, width, height)
}

/** Convert one ASS plane to ImageData. */
export function planeToImageData(plane: RwssPlaneData): ImageData {
  return imageDataFromBytes(plane.rgba, plane.width, plane.height)
}

/** Normalize a WASM frame export into AssRenderedFrameData. */
export function normalizeFrameData(raw: Omit<AssRenderedFrameData, 'imageData'> & {
  imageData: Uint8Array | number[]
  imageWidth?: number
  imageHeight?: number
}): AssRenderedFrameData {
  const width = raw.imageWidth ?? (raw.crop === 'bounds' ? raw.bounds?.width ?? 0 : raw.screenWidth)
  const height = raw.imageHeight ?? (raw.crop === 'bounds' ? raw.bounds?.height ?? 0 : raw.screenHeight)
  return {
    ...raw,
    imageData: imageDataFromBytes(raw.imageData, width, height)
  }
}

/** Compose ASS planes into a cropped or full-screen RGBA frame. */
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

/** Compose a subtitle frame into RGBA pixels. */
export function renderFrameData(data: AssSubtitleData, options?: AssFrameRenderOptions): AssRenderedFrameData {
  return renderAssDataToFrame(data, options?.crop ?? 'screen')
}

/** Draw rendered frame data onto a canvas. */
export function toCanvas(frame: AssRenderedFrameData, canvas?: HTMLCanvasElement | OffscreenCanvas): HTMLCanvasElement | OffscreenCanvas {
  const target = canvas ?? document.createElement('canvas')
  if (target.width !== frame.imageData.width) target.width = frame.imageData.width
  if (target.height !== frame.imageData.height) target.height = frame.imageData.height
  const ctx = target.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  if (!ctx) throw new Error('Canvas 2D context is unavailable')
  ctx.putImageData(frame.imageData, 0, 0)
  return target
}

/** Encode rendered frame data as an image Blob. */
export async function toBlob(frame: AssRenderedFrameData, type = 'image/png', quality?: number): Promise<Blob> {
  const canvas = toCanvas(frame)
  if ('convertToBlob' in canvas) {
    return (canvas as OffscreenCanvas).convertToBlob({ type, quality })
  }
  return new Promise((resolve, reject) => {
    ;(canvas as HTMLCanvasElement).toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Failed to encode canvas'))), type, quality)
  })
}

/** Create an ImageBitmap from rendered frame data. */
export async function toImageBitmap(frame: AssRenderedFrameData): Promise<ImageBitmap> {
  return createImageBitmap(frame.imageData)
}

/** get Ass Bounds. */
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
