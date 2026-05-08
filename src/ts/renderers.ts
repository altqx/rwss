import type {
  ASSEvent,
  ASSStyle,
  EncryptedSubtitleContent,
  PerformanceStats,
  VideoAssSubtitleOptions,
  WrassRendererStatsSnapshot,
  WrassFontSource
} from './types'
import { openAss, type AssParser } from './parsers'
import { decryptSubtitleContent } from './crypto'
import {
  DEFAULT_AVAILABLE_FONTS,
  DEFAULT_FALLBACK_FONTS,
  registerAvailableFonts,
  registerFont,
  registerFontData,
  setFallbackFonts,
  toCanvas
} from './wasm'

interface RendererState {
  isPaused: boolean
  currentTime: number
  rate: number
}

export class AssRenderer {
  private options: VideoAssSubtitleOptions
  private opened?: AssParser
  private raf = 0
  private destroyed = false
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private framesRendered = 0
  private framesDropped = 0
  private lastRenderTime = 0
  private minRenderTime = 0
  private maxRenderTime = 0
  private totalRenderTime = 0
  private lastCueKey = ''
  private currentTrackText = ''
  private state: RendererState = { isPaused: true, currentTime: 0, rate: 1 }
  private events: ASSEvent[] = []
  private styles: ASSStyle[] = []
  private styleOverridePatch: Partial<ASSStyle> | null = null
  private readonly addedFonts: (string | Uint8Array | WrassFontSource)[] = []
  private defaultFont = 'sans'

  constructor(options: VideoAssSubtitleOptions) {
    if (!options) throw new Error('No options provided')
    if (!options.video && !options.canvas) throw new Error('Provide video or canvas in options')
    this.options = {
      targetFps: 24,
      timeOffset: 0,
      renderAhead: 0.008,
      availableFonts: DEFAULT_AVAILABLE_FONTS,
      fallbackFonts: DEFAULT_FALLBACK_FONTS,
      useLocalFonts: typeof (globalThis as { queryLocalFonts?: unknown }).queryLocalFonts !== 'undefined',
      ...options
    }
    this.defaultFont = this.options.fallbackFonts?.[0] ?? this.defaultFont
    this.addedFonts.push(...(this.options.fonts ?? []))
    this.canvas = options.canvas ?? this.createOverlayCanvas(options.video!)
    const ctx = this.canvas.getContext('2d', { alpha: true, desynchronized: true })
    if (!ctx) throw new Error('Canvas rendering not supported')
    this.ctx = ctx
    this.options.onCanvasFallback?.()
    if (this.options.autoLoad !== false) void this.load()
  }

  get rendererType(): 'canvas2d' {
    return 'canvas2d'
  }

  async load(): Promise<void> {
    this.options.onLoading?.()
    this.options.onEvent?.({ type: 'load-start' })
    try {
      const content = await resolveSubtitleContent(this.options)
      await this.setTrackInternal(content)
      this.options.onLoaded?.()
      this.options.onEvent?.({ type: 'load-complete', metadata: this.opened!.metadata })
      this.start()
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error))
      this.options.onError?.(normalized)
      this.options.onEvent?.({ type: 'error', error: normalized })
      throw normalized
    }
  }

  start(): void {
    if (this.destroyed || this.raf) return
    const interval = 1000 / Math.max(1, this.options.targetFps ?? 24)
    let lastTick = 0
    const tick = (now: number) => {
      this.raf = requestAnimationFrame(tick)
      if (this.options.onDemandRender === false && now - lastTick < interval) return
      lastTick = now
      this.renderCurrentTime()
    }
    this.raf = requestAnimationFrame(tick)
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  resize(width?: number, height?: number): void {
    if (width && height) {
      this.canvas.width = Math.max(1, Math.round(width))
      this.canvas.height = Math.max(1, Math.round(height))
      return
    }
    if (!this.options.video || this.options.canvas) return
    const rect = this.options.video.getBoundingClientRect()
    const naturalWidth = this.options.video.videoWidth || 1
    const naturalHeight = this.options.video.videoHeight || 1
    const maxHeight = this.options.maxRenderHeight && this.options.maxRenderHeight > 0 ? this.options.maxRenderHeight : Infinity
    const targetHeight = Math.min(Math.round(rect.height || naturalHeight), maxHeight)
    const targetWidth = Math.round((rect.width || naturalWidth) * (targetHeight / Math.max(1, Math.round(rect.height || naturalHeight))))
    this.canvas.width = Math.max(1, targetWidth)
    this.canvas.height = Math.max(1, targetHeight)
  }

  setVideo(video: HTMLVideoElement): void {
    this.options.video = video
    this.resize()
  }

  runBenchmark(): void {
    const start = performance.now()
    this.renderCurrentTime(true)
    this.options.onEvent?.({ type: 'message', target: 'runBenchmark', data: { elapsed: performance.now() - start } })
  }

  setTrackByUrl(url: string): void {
    this.options.subUrl = url
    this.options.subContent = undefined
    this.options.encryptedSubContent = undefined
    void this.reloadFromOptions()
  }

  setTrack(content: string | Uint8Array | ArrayBuffer): void {
    this.options.subContent = content
    this.options.subUrl = undefined
    this.options.encryptedSubContent = undefined
    void this.setTrackInternal(decodeSubtitleBytes(content))
  }

  setEncryptedTrack(content: EncryptedSubtitleContent): void {
    this.options.encryptedSubContent = content
    this.options.subContent = undefined
    this.options.subUrl = undefined
    void this.reloadFromOptions()
  }

  freeTrack(): void {
    this.opened?.dispose()
    this.opened = undefined
    this.currentTrackText = ''
    this.events = []
    this.styles = []
    this.lastCueKey = ''
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }

  setIsPaused(isPaused: boolean): void {
    this.state.isPaused = isPaused
  }

  setRate(rate: number): void {
    this.state.rate = rate
  }

  setCurrentTime(isPaused?: boolean, currentTime?: number, rate?: number): void {
    if (typeof isPaused === 'boolean') this.state.isPaused = isPaused
    if (typeof currentTime === 'number') this.state.currentTime = currentTime
    if (typeof rate === 'number') this.state.rate = rate
    this.renderCurrentTime(true)
  }

  createEvent(event: Partial<ASSEvent>): void {
    this.events.push(normalizeEvent(event, this.events.length))
    void this.rebuildTrackFromState()
  }

  setEvent(event: Partial<ASSEvent>, index: number): void {
    assertIndex(index, this.events.length, 'event')
    this.events[index] = { ...this.events[index], ...event }
    void this.rebuildTrackFromState()
  }

  removeEvent(index: number): void {
    assertIndex(index, this.events.length, 'event')
    this.events.splice(index, 1)
    void this.rebuildTrackFromState()
  }

  async getEvents(): Promise<ASSEvent[]> {
    return this.events.map((event) => ({ ...event }))
  }

  styleOverride(style: Partial<ASSStyle>): void {
    this.styleOverridePatch = { ...style }
    void this.rebuildTrackFromState()
  }

  disableStyleOverride(): void {
    this.styleOverridePatch = null
    void this.rebuildTrackFromState()
  }

  createStyle(style: Partial<ASSStyle>): void {
    this.styles.push(normalizeStyle(style, this.styles.length))
    void this.rebuildTrackFromState()
  }

  setStyle(style: Partial<ASSStyle>, index: number): void {
    assertIndex(index, this.styles.length, 'style')
    this.styles[index] = { ...this.styles[index], ...style }
    void this.rebuildTrackFromState()
  }

  removeStyle(index: number): void {
    assertIndex(index, this.styles.length, 'style')
    this.styles.splice(index, 1)
    void this.rebuildTrackFromState()
  }

  async getStyles(): Promise<ASSStyle[]> {
    return this.effectiveStyles().map((style) => ({ ...style }))
  }

  async addFont(font: string | Uint8Array | WrassFontSource, data?: Uint8Array | ArrayBuffer | ArrayBufferView): Promise<string | undefined> {
    const source = data && typeof font === 'string' ? { name: font, data } : font
    this.addedFonts.push(source)
    let registeredPath: string | undefined
    if (typeof source === 'string') {
      registeredPath = await registerFont(source, undefined, { isFallback: false })
    } else if (source instanceof Uint8Array) {
      registeredPath = registerFontData(source, { isFallback: false })
    } else {
      registeredPath = await registerFont(source, undefined, { isFallback: false })
    }
    this.options.onEvent?.({ type: 'message', target: 'addFont', data: { font: source, path: registeredPath } })
    return registeredPath
  }

  setDefaultFont(font: string): void {
    this.defaultFont = font
    if (this.styles.length === 0) this.styles.push(normalizeStyle({ FontName: font }, 0))
    this.styles = this.styles.map((style) => (style.FontName ? style : { ...style, FontName: font }))
    void this.rebuildTrackFromState()
  }

  async getStats(): Promise<PerformanceStats> {
    const avgRenderTime = this.framesRendered > 0 ? this.totalRenderTime / this.framesRendered : 0
    return {
      framesRendered: this.framesRendered,
      framesDropped: this.framesDropped,
      avgRenderTime,
      maxRenderTime: this.maxRenderTime,
      minRenderTime: this.minRenderTime,
      lastRenderTime: this.lastRenderTime,
      pendingRenders: 0,
      totalEvents: this.events.length,
      cacheHits: 0,
      cacheMisses: 0,
      renderFps: avgRenderTime > 0 ? Math.round(1000 / avgRenderTime) : 0,
      usingWorker: !!this.options.workerUrl,
      offscreenRender: !!this.options.offscreenRender,
      onDemandRender: this.options.onDemandRender !== false
    }
  }

  getStatsSnapshot(): WrassRendererStatsSnapshot {
    const avgRenderTime = this.framesRendered > 0 ? this.totalRenderTime / this.framesRendered : 0
    return {
      framesRendered: this.framesRendered,
      framesDropped: this.framesDropped,
      avgRenderTime,
      maxRenderTime: this.maxRenderTime,
      minRenderTime: this.minRenderTime,
      lastRenderTime: this.lastRenderTime,
      pendingRenders: 0,
      totalEvents: this.events.length,
      cacheHits: 0,
      cacheMisses: 0,
      renderFps: avgRenderTime > 0 ? Math.round(1000 / avgRenderTime) : 0,
      usingWorker: !!this.options.workerUrl,
      offscreenRender: !!this.options.offscreenRender,
      onDemandRender: this.options.onDemandRender !== false,
      backend: 'canvas2d'
    }
  }

  async resetStats(): Promise<void> {
    this.framesRendered = 0
    this.framesDropped = 0
    this.lastRenderTime = 0
    this.minRenderTime = 0
    this.maxRenderTime = 0
    this.totalRenderTime = 0
  }

  async getEventCount(): Promise<number> {
    return this.events.length
  }

  async getStyleCount(): Promise<number> {
    return this.styles.length
  }

  sendMessage(target: string, data?: unknown): void {
    this.options.onEvent?.({ type: 'message', target, data })
    if (this.options.debug) console.debug('[wrass]', target, data)
  }

  renderCurrentTime(force = false): void {
    if (!this.opened) return
    const started = performance.now()
    const baseTime = this.options.video?.currentTime ?? this.state.currentTime
    const time = baseTime + (this.options.timeOffset ?? 0) + (this.options.renderAhead ?? 0) * this.state.rate
    const frame = this.opened.renderFrameDataAtTimestamp(time)
    const cueKey = frame ? `${time.toFixed(3)}:${frame.compositionCount}:${frame.bounds?.x ?? -1}:${frame.bounds?.y ?? -1}` : 'empty'
    if (!force && cueKey === this.lastCueKey) return
    this.lastCueKey = cueKey
    this.resize()
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    if (frame) {
      const bitmapCanvas = toCanvas(frame) as HTMLCanvasElement
      this.ctx.drawImage(bitmapCanvas, 0, 0, this.canvas.width, this.canvas.height)
      const renderTime = performance.now() - started
      this.options.onEvent?.({ type: 'render', time, compositionCount: frame.compositionCount, renderTime, bounds: frame.bounds, backend: this.rendererType, dropped: false })
    }
    this.recordRenderTime(performance.now() - started)
  }

  destroy(): void {
    this.destroyed = true
    this.stop()
    this.opened?.dispose()
    if (!this.options.canvas) this.canvas.remove()
  }

  private async reloadFromOptions(): Promise<void> {
    const content = await resolveSubtitleContent(this.options)
    await this.setTrackInternal(content)
  }

  private async setTrackInternal(content: string): Promise<void> {
    await this.registerConfiguredFonts(content)
    this.opened?.dispose()
    this.currentTrackText = content
    this.opened = (await openAss(content, this.options.wasmUrl)) as AssParser
    this.events = this.opened.getEvents().map((event) => ({ ...event }))
    this.styles = this.opened.getStyles().map((style) => ({ ...style }))
    this.lastCueKey = ''
    this.options.onEvent?.({ type: 'track-ready', metadata: this.opened.metadata })
  }

  private async rebuildTrackFromState(): Promise<void> {
    const text = buildAssDocument(this.effectiveStyles(), this.events, this.opened?.metadata.playResX ?? 384, this.opened?.metadata.playResY ?? 288)
    await this.setTrackInternal(text)
  }

  private async registerConfiguredFonts(content?: string): Promise<void> {
    const fallbackFonts = this.options.fallbackFonts ?? DEFAULT_FALLBACK_FONTS
    setFallbackFonts(fallbackFonts)
    const availableFonts = this.options.availableFonts ?? DEFAULT_AVAILABLE_FONTS
    const requestedFamilies = content ? extractRequestedFontFamilies(content) : []
    const selectedAvailableFonts = selectAvailableFonts(availableFonts, fallbackFonts, requestedFamilies)
    await registerAvailableFonts(selectedAvailableFonts, { fallbackFonts })
    await this.registerLocalFonts(requestedFamilies)
    for (const font of this.addedFonts) {
      if (typeof font === 'string') await registerFont(font, undefined, { isFallback: false })
      else if (font instanceof Uint8Array) registerFontData(font, { isFallback: false })
      else await registerFont(font, undefined, { isFallback: false })
    }
  }

  private async registerLocalFonts(requestedFamilies: string[]): Promise<void> {
    if (!this.options.useLocalFonts || typeof (globalThis as { queryLocalFonts?: unknown }).queryLocalFonts !== 'function') return
    const queryLocalFonts = (globalThis as unknown as { queryLocalFonts: (options?: { postscriptNames?: string[] }) => Promise<Array<{ family?: string; fullName?: string; postscriptName?: string; blob?: () => Promise<Blob> }>> }).queryLocalFonts
    const targets = requestedFamilies.length > 0 ? requestedFamilies : this.options.fallbackFonts ?? []
    for (const family of targets) {
      try {
        const faces = await queryLocalFonts({ postscriptNames: [family] })
        for (const face of faces) {
          const blob = await face.blob?.()
          if (!blob) continue
          const data = new Uint8Array(await blob.arrayBuffer())
          await registerFont({ name: face.family ?? face.fullName ?? face.postscriptName ?? family, data, aliases: [family], isFallback: false })
        }
      } catch {
        // Browser permission denial or unsupported query shape should not prevent subtitle loading.
      }
    }
  }

  private effectiveStyles(): ASSStyle[] {
    if (!this.styleOverridePatch) return this.styles
    return this.styles.map((style) => ({ ...style, ...this.styleOverridePatch }))
  }

  private recordRenderTime(value: number): void {
    this.lastRenderTime = value
    this.totalRenderTime += value
    this.minRenderTime = this.framesRendered === 0 ? value : Math.min(this.minRenderTime, value)
    this.maxRenderTime = Math.max(this.maxRenderTime, value)
    this.framesRendered++
  }

  private createOverlayCanvas(video: HTMLVideoElement): HTMLCanvasElement {
    const canvas = document.createElement('canvas')
    canvas.className = 'Wrass'
    canvas.style.position = 'absolute'
    canvas.style.inset = '0'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.pointerEvents = 'none'
    const parent = document.createElement('div')
    parent.className = 'WrassContainer'
    parent.style.position = 'relative'
    parent.style.display = 'inline-block'
    video.insertAdjacentElement('afterend', parent)
    parent.append(video, canvas)
    return canvas
  }
}

export default AssRenderer

export function createAssRenderer(options: VideoAssSubtitleOptions): AssRenderer {
  return new AssRenderer(options)
}

function selectAvailableFonts(
  availableFonts: Record<string, string | Uint8Array | ArrayBuffer | ArrayBufferView>,
  fallbackFonts: string[],
  requestedFamilies: string[]
): Record<string, string | Uint8Array | ArrayBuffer | ArrayBufferView> {
  const selected: Record<string, string | Uint8Array | ArrayBuffer | ArrayBufferView> = {}
  const wanted = new Set([...fallbackFonts, ...requestedFamilies].map(fontKey))
  for (const [family, source] of Object.entries(availableFonts)) {
    if (wanted.size === 0 || wanted.has(fontKey(family))) selected[family] = source
  }
  return selected
}

function extractRequestedFontFamilies(content: string): string[] {
  const families: string[] = []
  const stylesMatch = content.match(/\[V4\+?\s*Styles?\][^\[]*(?=\[|$)/i)
  if (stylesMatch) {
    for (const match of stylesMatch[0].matchAll(/^Style:[^,]*,([^,]+)/gmi)) {
      families.push(match[1].trim())
    }
  }
  const eventsMatch = content.match(/\[Events\][\s\S]*/i)
  if (eventsMatch) {
    for (const match of eventsMatch[0].matchAll(/\\fn([^\\}]*?)(?=[\\}])/g)) {
      families.push(match[1].trim())
    }
  }
  return [...new Set(families.map((family) => family.replace(/^@/, '').trim()).filter(Boolean))]
}

function fontKey(value: string): string {
  const trimmed = value.trim().toLowerCase()
  return trimmed.startsWith('@') ? trimmed.slice(1) : trimmed
}

async function resolveSubtitleContent(options: VideoAssSubtitleOptions): Promise<string> {
  if (options.encryptedSubContent) return decryptSubtitleContent(options.encryptedSubContent)
  if (options.subContent !== undefined) return decodeSubtitleBytes(options.subContent)
  if (options.subUrl) {
    const response = await fetch(options.subUrl)
    if (!response.ok) throw new Error(`Failed to fetch ASS subtitle: ${response.status} ${response.statusText}`)
    return response.text()
  }
  throw new Error('Missing ASS subtitle input: provide subUrl, subContent or encryptedSubContent')
}

function decodeSubtitleBytes(content: string | Uint8Array | ArrayBuffer): string {
  if (typeof content === 'string') return content
  if (content instanceof ArrayBuffer) return new TextDecoder().decode(content)
  return new TextDecoder().decode(content)
}

function normalizeEvent(event: Partial<ASSEvent>, readOrder: number): ASSEvent {
  return {
    Start: event.Start ?? 0,
    Duration: event.Duration ?? 1,
    Style: event.Style ?? 'Default',
    Name: event.Name ?? '',
    MarginL: event.MarginL ?? 0,
    MarginR: event.MarginR ?? 0,
    MarginV: event.MarginV ?? 0,
    Effect: event.Effect ?? '',
    Text: event.Text ?? '',
    ReadOrder: event.ReadOrder ?? readOrder,
    Layer: event.Layer ?? 0
  }
}

function normalizeStyle(style: Partial<ASSStyle>, index: number): ASSStyle {
  return {
    Name: style.Name ?? (index === 0 ? 'Default' : `Style${index}`),
    FontName: style.FontName ?? 'sans',
    FontSize: style.FontSize ?? 24,
    PrimaryColour: style.PrimaryColour ?? 0x00ffffff,
    SecondaryColour: style.SecondaryColour ?? 0x0000ffff,
    OutlineColour: style.OutlineColour ?? 0x00000000,
    BackColour: style.BackColour ?? 0x00000000,
    Bold: style.Bold ?? 0,
    Italic: style.Italic ?? 0,
    Underline: style.Underline ?? 0,
    StrikeOut: style.StrikeOut ?? 0,
    ScaleX: style.ScaleX ?? 100,
    ScaleY: style.ScaleY ?? 100,
    Spacing: style.Spacing ?? 0,
    Angle: style.Angle ?? 0,
    BorderStyle: style.BorderStyle ?? 1,
    Outline: style.Outline ?? 0,
    Shadow: style.Shadow ?? 0,
    Alignment: style.Alignment ?? 2,
    MarginL: style.MarginL ?? 0,
    MarginR: style.MarginR ?? 0,
    MarginV: style.MarginV ?? 0,
    Encoding: style.Encoding ?? 1,
    TreatFontnameAsPattern: style.TreatFontnameAsPattern ?? 0,
    Blur: style.Blur ?? 0,
    Justify: style.Justify ?? 0
  }
}

function assertIndex(index: number, length: number, kind: string): void {
  if (!Number.isInteger(index) || index < 0 || index >= length) throw new RangeError(`ASS ${kind} index out of range`)
}

function buildAssDocument(styles: ASSStyle[], events: ASSEvent[], playResX: number, playResY: number): string {
  const normalizedStyles = styles.length > 0 ? styles : [normalizeStyle({}, 0)]
  return [
    '[Script Info]',
    `PlayResX: ${Math.round(playResX)}`,
    `PlayResY: ${Math.round(playResY)}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...normalizedStyles.map(serializeStyle),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events.map(serializeEvent)
  ].join('\n')
}

function serializeStyle(style: ASSStyle): string {
  return `Style: ${[
    style.Name,
    style.FontName,
    style.FontSize,
    assColor(style.PrimaryColour),
    assColor(style.SecondaryColour),
    assColor(style.OutlineColour),
    assColor(style.BackColour),
    style.Bold,
    style.Italic,
    style.Underline,
    style.StrikeOut,
    style.ScaleX,
    style.ScaleY,
    style.Spacing,
    style.Angle,
    style.BorderStyle,
    style.Outline,
    style.Shadow,
    style.Alignment,
    style.MarginL,
    style.MarginR,
    style.MarginV,
    style.Encoding
  ].map(escapeCsv).join(',')}`
}

function serializeEvent(event: ASSEvent): string {
  return `Dialogue: ${[
    event.Layer,
    formatAssTime(event.Start),
    formatAssTime(event.Start + event.Duration),
    event.Style,
    event.Name,
    event.MarginL,
    event.MarginR,
    event.MarginV,
    event.Effect,
    event.Text
  ].map(escapeCsv).join(',')}`
}

function formatAssTime(seconds: number): string {
  const safe = Math.max(0, seconds)
  const centiseconds = Math.round(safe * 100)
  const cs = centiseconds % 100
  const totalSeconds = Math.floor(centiseconds / 100)
  const s = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const m = totalMinutes % 60
  const h = Math.floor(totalMinutes / 60)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

function assColor(value: number): string {
  return `&H${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

function escapeCsv(value: string | number): string {
  return String(value).replace(/\r?\n/g, '\\N')
}
