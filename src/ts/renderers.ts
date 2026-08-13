import type {
  ASSEvent,
  ASSStyle,
  AssRenderedFrameData,
  EncryptedSubtitleContent,
  FrameTimeline,
  PerformanceStats,
  VideoAssSubtitleOptions,
  VideoFrameCallbackMetadata,
  RwssFontSource,
  RwssRendererBackend,
  RwssRendererStatsSnapshot
} from './types'
import { MAX_FONT_BYTES, MAX_FRAME_PREFETCH } from './types'
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
import { computeRenderSize, dropBlur, getVideoPosition } from './utils'
import { WebGPURenderer, isWebGPUSupported } from './webgpu-renderer'
import { WebGL2Renderer, isWebGL2Supported } from './webgl2-renderer'
import {
  compensatedMediaTime,
  normalizeFrameTimeline,
  presentedFrameIndex,
  presentationLeadSeconds,
  resolvePresentationMediaTime,
  selectRenderMediaTime,
  subtitleTimeForFrame,
  updateTimingCompensation
} from './timing'

interface RendererState {
  isPaused: boolean
  currentTime: number
  rate: number
}

interface PreparedFrame {
  index: number
  time: number
  width: number
  height: number
  frame?: AssRenderedFrameData
  planes?: number
}

const DEFAULT_RENDER_AHEAD = 0

const isLikelyWebKit = (): boolean => {
  if (typeof navigator === 'undefined') return false
  const userAgent = navigator.userAgent || ''
  const vendor = navigator.vendor || ''
  const isIOSWebKit = /\b(iPhone|iPad|iPod)\b/i.test(userAgent)
  if (!/AppleWebKit/i.test(userAgent)) return false
  if (isIOSWebKit) return true
  if (/\b(Chrome|Chromium|Edg|OPR|SamsungBrowser|Firefox)\b/i.test(userAgent)) return false
  return vendor.includes('Apple')
}

/** High-level video/canvas ASS renderer with RVFC sync and GPU fallback. */
export class AssRenderer extends EventTarget {
  private options: VideoAssSubtitleOptions
  private opened?: AssParser
  private raf = 0
  private videoFrameCallback = 0
  private rvfcGeneration = 0
  private destroyed = false
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D | null = null
  private canvasParent?: HTMLDivElement
  private framesRendered = 0
  private framesDropped = 0
  private lastRenderTime = 0
  private minRenderTime = 0
  private maxRenderTime = 0
  private totalRenderTime = 0
  private lastCueKey = ''
  private lastImageCount = 0
  private lastImagePixels = 0
  private cacheHits = 0
  private cacheMisses = 0
  private currentTrackText = ''
  private state: RendererState = { isPaused: true, currentTime: 0, rate: 1 }
  private events: ASSEvent[] = []
  private styles: ASSStyle[] = []
  private styleOverridePatch: Partial<ASSStyle> | null = null
  private readonly addedFonts: (string | Uint8Array | RwssFontSource)[] = []
  private defaultFont = 'sans'
  private gpuRenderer: WebGPURenderer | WebGL2Renderer | null = null
  private backend: RwssRendererBackend = 'canvas2d'
  private frameTimeline: (Float64Array & { mediaTimeOrigin?: number; subtitleTimeOffset?: number }) | null = null
  private preparedFrames = new Map<number, PreparedFrame>()
  private prepareQueue: number[] = []
  private preparing = false
  private renderEpoch = 0
  private nextPresentationId = 1
  private latestPresentationId = 0
  private lastPresentedFrameIndex?: number
  private timingCompensationSeconds = 0
  private lastDemandDispatchedAt = 0
  private pendingRenders = 0
  private boundTimeUpdate = (event: Event) => this.syncVideoClock(event)
  private boundSetRate = () => this.syncVideoClock(new Event('ratechange'))
  private boundResize = () => this.resize()
  private resizeObserver?: ResizeObserver
  private readonly isCustomCanvas: boolean
  private readonly wantsOffscreenRender: boolean
  private readonly rawAssImageGpu: boolean
  private readonly adaptiveTiming: boolean
  private readonly onDemandRender: boolean
  private readonly isLikelyWebKit: boolean

  /** Seconds added to media time before sampling ASS. */
  public timeOffset: number
  /** When true, emit extra renderer debug logs. */
  public debug: boolean
  /** Extra scale applied before the height cap. */
  public prescaleFactor: number
  /** Height limit used when applying prescaleFactor. */
  public prescaleHeightLimit: number
  /** Hard cap on overlay backing-store height. */
  public maxRenderHeight: number
  /** Whether a render is currently in flight. */
  public busy = false
  /** Extra seconds of render-ahead lead. */
  public renderAhead: number
  /** Exact-frame prefetch runway (0–24). */
  public framePrefetch: number

  /** Create a video or canvas ASS renderer. */
  constructor(options: VideoAssSubtitleOptions) {
    super()
    if (!options) throw new Error('No options provided')
    if (!options.video && !options.canvas) throw new Error('Provide video or canvas in options')

    this.assertFontLimits(options)
    this.isLikelyWebKit = isLikelyWebKit()
    this.isCustomCanvas = !!options.canvas
    this.rawAssImageGpu = options.rawAssImageGpu ?? false
    this.wantsOffscreenRender = options.offscreenRender ?? !this.isCustomCanvas
    this.onDemandRender = options.onDemandRender !== false
    this.adaptiveTiming = options.adaptiveTiming !== false
    this.frameTimeline = options.frameTimeline ? normalizeFrameTimeline(options.frameTimeline) : null
    this.framePrefetch = clampPrefetch(options.framePrefetch ?? 2)
    this.timeOffset = options.timeOffset || 0
    this.debug = !!options.debug
    this.prescaleFactor = options.prescaleFactor || 1
    this.prescaleHeightLimit = options.prescaleHeightLimit || 1080
    this.maxRenderHeight = options.maxRenderHeight || 0
    this.renderAhead = options.renderAhead ?? DEFAULT_RENDER_AHEAD

    this.options = {
      targetFps: 24,
      timeOffset: this.timeOffset,
      renderAhead: this.renderAhead,
      availableFonts: DEFAULT_AVAILABLE_FONTS,
      fallbackFonts: DEFAULT_FALLBACK_FONTS,
      useLocalFonts: typeof (globalThis as { queryLocalFonts?: unknown }).queryLocalFonts !== 'undefined',
      useFontconfigProvider: options.useFontconfigProvider ?? true,
      libassMemoryLimit: 128,
      libassGlyphLimit: 2048,
      blendMode: options.blendMode ?? 'wasm',
      ...options,
      offscreenRender: this.wantsOffscreenRender,
      rawAssImageGpu: this.rawAssImageGpu,
      adaptiveTiming: this.adaptiveTiming,
      onDemandRender: this.onDemandRender
    }
    this.defaultFont = this.options.fallbackFonts?.[0] ?? this.defaultFont
    this.addedFonts.push(...(this.options.fonts ?? []))
    this.canvas = options.canvas ?? this.createOverlayCanvas(options.video!)
    this.ctx = this.canvas.getContext('2d', { alpha: true, desynchronized: true })
    if (!this.ctx) throw new Error('Canvas rendering not supported')

    if (!this.isCustomCanvas) this.initManagedGpuRenderer()
    if (this.backend === 'canvas2d') this.options.onCanvasFallback?.()
    if (options.video) this.setVideo(options.video)
    if (this.options.autoLoad !== false) void this.load()
  }

  /** Active presentation backend. */
  get rendererType(): RwssRendererBackend {
    return this.backend
  }

  /** Whether WebGPU or WebGL2 is presenting the overlay. */
  get isUsingGPURenderer(): boolean {
    return this.gpuRenderer !== null && this.backend !== 'canvas2d'
  }

  /** @deprecated Use rendererType === 'webgpu'. */
  get isUsingWebGPU(): boolean {
    return this.backend === 'webgpu'
  }

  /** Load the configured subtitle input and start the render loop. */
  async load(): Promise<void> {
    this.options.onLoading?.()
    this.emitEvent({ type: 'load-start' })
    try {
      const content = await resolveSubtitleContent(this.options)
      await this.setTrackInternal(content, 'ready')
      this.options.onLoaded?.()
      if (this.opened) this.emitEvent({ type: 'load-complete', metadata: this.opened.metadata })
      this.start()
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error))
      this.options.onError?.(normalized)
      this.emitEvent({ type: 'error', error: normalized })
      this.dispatchEvent(new CustomEvent('error', { detail: normalized }))
      throw normalized
    }
  }

  /** Start the RVFC or animation-frame render loop. */
  start(): void {
    if (this.destroyed || this.raf || this.videoFrameCallback) return
    if (this.options.video && this.onDemandRender && typeof this.options.video.requestVideoFrameCallback === 'function') {
      this.scheduleRVFC(this.options.video)
      return
    }

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

  /** Stop the render loop without disposing the renderer. */
  stop(): void {
    this.rvfcGeneration++
    if (this.raf) cancelAnimationFrame(this.raf)
    if (this.videoFrameCallback && this.options.video) {
      try {
        this.options.video.cancelVideoFrameCallback(this.videoFrameCallback)
      } catch {
        // Already-fired handles can throw in some polyfills.
      }
    }
    this.raf = 0
    this.videoFrameCallback = 0
  }

  /** Resize the overlay canvas and optionally redraw immediately. */
  resize(width?: number, height?: number, top = 0, left = 0, force: boolean = this.isVideoPaused()): void {
    this.layoutCanvas(width, height, top, left)
    if (force && this.opened) this.renderCurrentTime(true)
  }

  /** Bind a different video element and resubscribe clock listeners. */
  setVideo(video: HTMLVideoElement): void {
    this.removeVideoListeners()
    this.options.video = video
    this.state.isPaused = !!(video.paused || video.ended)
    this.state.rate = this.playbackRate()
    if (typeof video.addEventListener === 'function') {
      for (const type of ['timeupdate', 'progress', 'play', 'playing', 'pause', 'ended', 'waiting', 'stalled', 'seeking', 'seeked'] as const) {
        video.addEventListener(type, this.boundTimeUpdate, false)
      }
      video.addEventListener('ratechange', this.boundSetRate, false)
      if (!this.onDemandRender) video.addEventListener('resize', this.boundResize, false)
    }
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver ??= new ResizeObserver(() => this.resize())
      this.resizeObserver.observe(video)
    }
    this.resize()
    if (this.onDemandRender) this.scheduleRVFC(video)
    this.syncVideoClock()
  }

  /** Replace or clear the encoded-frame timeline used for exact sampling. */
  setFrameTimeline(frameTimes: FrameTimeline | null): void {
    this.frameTimeline = frameTimes ? normalizeFrameTimeline(frameTimes) : null
    this.options.frameTimeline = frameTimes ?? undefined
    this.bumpRenderEpoch()
    this.syncVideoClock()
    this.primePreparedFrames(this.currentExactFrameMediaTime())
    void this.dispatchNextPreparation()
  }

  /** Emit a simple render-timing debug message. */
  runBenchmark(): void {
    const start = performance.now()
    this.renderCurrentTime(true)
    this.emitEvent({ type: 'message', target: 'runBenchmark', data: { elapsed: performance.now() - start } })
  }

  /** Replace the current track by fetching a URL. */
  setTrackByUrl(url: string): void {
    this.options.subUrl = url
    this.options.subContent = undefined
    this.options.encryptedSubContent = undefined
    void this.reloadFromOptions()
  }

  /** Replace the current track from ASS text or bytes. */
  setTrack(content: string | Uint8Array | ArrayBuffer): void {
    this.options.subContent = content
    this.options.subUrl = undefined
    this.options.encryptedSubContent = undefined
    void this.setTrackInternal(decodeSubtitleBytes(content), 'trackReady')
  }

  /** Replace the current track from an encrypted payload. */
  setEncryptedTrack(content: EncryptedSubtitleContent): void {
    this.options.encryptedSubContent = content
    this.options.subContent = undefined
    this.options.subUrl = undefined
    void this.reloadFromOptions()
  }

  /** Unload the current track and clear the overlay. */
  freeTrack(): void {
    this.bumpRenderEpoch()
    this.opened?.dispose()
    this.opened = undefined
    this.currentTrackText = ''
    this.events = []
    this.styles = []
    this.lastCueKey = ''
    this.clearCanvas()
  }

  /** Override the paused flag used by manual clock control. */
  setIsPaused(isPaused: boolean): void {
    this.state.isPaused = isPaused
    this.syncVideoClock()
  }

  /** Override the playback rate used by manual clock control. */
  setRate(rate: number): void {
    this.state.rate = rate
    this.setCurrentTime(this.isVideoPaused(), this.currentVideoTimeWithOffset(), rate)
  }

  /** Override paused/currentTime/rate together for manual clock control. */
  setCurrentTime(isPaused?: boolean, currentTime?: number, rate?: number): void {
    if (typeof isPaused === 'boolean') this.state.isPaused = isPaused
    if (typeof currentTime === 'number') this.state.currentTime = currentTime
    if (typeof rate === 'number') this.state.rate = rate
    this.renderAtMediaTime((currentTime ?? this.state.currentTime) - this.timeOffset, true)
  }

  /** Append an ASS event and rebuild the in-memory track. */
  createEvent(event: Partial<ASSEvent>): void {
    this.events.push(normalizeEvent(event, this.events.length))
    void this.rebuildTrackFromState()
  }

  /** Patch an ASS event by index and rebuild the in-memory track. */
  setEvent(event: Partial<ASSEvent>, index: number): void {
    assertIndex(index, this.events.length, 'event')
    this.events[index] = { ...this.events[index], ...event }
    void this.rebuildTrackFromState()
  }

  /** Remove an ASS event by index and rebuild the in-memory track. */
  removeEvent(index: number): void {
    assertIndex(index, this.events.length, 'event')
    this.events.splice(index, 1)
    void this.rebuildTrackFromState()
  }

  /** Return a copy of the current ASS events. */
  async getEvents(): Promise<ASSEvent[]> {
    return this.events.map((event, index) => ({ ...event, _index: index }))
  }

  /** Apply a style override patch to every style. */
  styleOverride(style: Partial<ASSStyle>): void {
    this.styleOverridePatch = { ...style }
    void this.rebuildTrackFromState()
  }

  /** Clear the style override patch. */
  disableStyleOverride(): void {
    this.styleOverridePatch = null
    void this.rebuildTrackFromState()
  }

  /** Append an ASS style and rebuild the in-memory track. */
  createStyle(style: Partial<ASSStyle>): void {
    this.styles.push(normalizeStyle(style, this.styles.length))
    void this.rebuildTrackFromState()
  }

  /** Patch an ASS style by index and rebuild the in-memory track. */
  setStyle(style: Partial<ASSStyle>, index: number): void {
    assertIndex(index, this.styles.length, 'style')
    this.styles[index] = { ...this.styles[index], ...style }
    void this.rebuildTrackFromState()
  }

  /** Remove an ASS style by index and rebuild the in-memory track. */
  removeStyle(index: number): void {
    assertIndex(index, this.styles.length, 'style')
    this.styles.splice(index, 1)
    void this.rebuildTrackFromState()
  }

  /** Return a copy of the effective ASS styles. */
  async getStyles(): Promise<ASSStyle[]> {
    return this.effectiveStyles().map((style) => ({ ...style }))
  }

  /** Register an extra font and keep it for later track rebuilds. */
  async addFont(font: string | Uint8Array | RwssFontSource, data?: Uint8Array | ArrayBuffer | ArrayBufferView): Promise<string | undefined> {
    const source = data && typeof font === 'string' ? { name: font, data } : font
    if (typeof source !== 'string' && !(source instanceof Uint8Array) && 'data' in source) {
      const bytes = source.data instanceof Uint8Array ? source.data : new Uint8Array(source.data instanceof ArrayBuffer ? source.data : source.data.buffer)
      if (bytes.byteLength > MAX_FONT_BYTES) throw new Error('Font files are limited to 32 MiB')
    } else if (source instanceof Uint8Array && source.byteLength > MAX_FONT_BYTES) {
      throw new Error('Font files are limited to 32 MiB')
    }
    this.addedFonts.push(source)
    let registeredPath: string | undefined
    if (typeof source === 'string') registeredPath = await registerFont(source, undefined, { isFallback: false })
    else if (source instanceof Uint8Array) registeredPath = registerFontData(source, { isFallback: false })
    else registeredPath = await registerFont(source, undefined, { isFallback: false })
    this.emitEvent({ type: 'message', target: 'addFont', data: { font: source, path: registeredPath } })
    return registeredPath
  }

  /** Change the default/fallback font family. */
  setDefaultFont(font: string): void {
    this.defaultFont = font
    if (this.styles.length === 0) this.styles.push(normalizeStyle({ FontName: font }, 0))
    this.styles = this.styles.map((style) => (style.FontName ? style : { ...style, FontName: font }))
    void this.rebuildTrackFromState()
  }

  /** Return current renderer performance stats. */
  async getStats(): Promise<PerformanceStats> {
    return this.buildStats()
  }

  /** Return a synchronous stats snapshot including the active backend. */
  getStatsSnapshot(): RwssRendererStatsSnapshot {
    return { ...this.buildStats(), backend: this.backend }
  }

  /** Reset render counters and learned timing compensation. */
  async resetStats(): Promise<void> {
    this.framesRendered = 0
    this.framesDropped = 0
    this.lastRenderTime = 0
    this.minRenderTime = 0
    this.maxRenderTime = 0
    this.totalRenderTime = 0
    this.cacheHits = 0
    this.cacheMisses = 0
    this.timingCompensationSeconds = 0
  }

  /** Return the number of ASS events in the current track. */
  async getEventCount(): Promise<number> {
    return this.events.length
  }

  /** Return the number of ASS styles in the current track. */
  async getStyleCount(): Promise<number> {
    return this.styles.length
  }

  /** Emit an observability message event. */
  async sendMessage(target: string, data?: unknown, _transferable?: Transferable[]): Promise<void> {
    this.emitEvent({ type: 'message', target, data })
    if (this.debug) console.debug('[rwss]', target, data)
  }

  /** Render the current video or manual clock time. */
  renderCurrentTime(force = false): void {
    const mediaTime = this.options.video?.currentTime ?? this.state.currentTime - this.timeOffset
    this.renderAtMediaTime(mediaTime, force)
  }

  /** Stop rendering, dispose parser state, and remove auto-created canvases. */
  destroy(err?: Error | string): Error | undefined {
    this.destroyed = true
    this.stop()
    this.removeVideoListeners()
    this.resizeObserver?.disconnect()
    this.gpuRenderer?.destroy()
    this.opened?.dispose()
    this.preparedFrames.clear()
    if (!this.options.canvas) {
      this.canvas.remove()
      this.canvasParent?.remove()
    }
    if (err) {
      const error = err instanceof Error ? err : new Error(err)
      this.emitEvent({ type: 'error', error })
      return error
    }
    return undefined
  }

  private buildStats(): PerformanceStats {
    const avgRenderTime = this.framesRendered > 0 ? this.totalRenderTime / this.framesRendered : 0
    return {
      framesRendered: this.framesRendered,
      framesDropped: this.framesDropped,
      avgRenderTime,
      maxRenderTime: this.maxRenderTime,
      minRenderTime: this.minRenderTime,
      lastRenderTime: this.lastRenderTime,
      timingCompensationMs: this.onDemandRender ? Math.round(this.timingCompensationSeconds * 100_000) / 100 : undefined,
      lastImageCount: this.lastImageCount,
      lastImagePixels: this.lastImagePixels,
      pendingRenders: this.pendingRenders,
      totalEvents: this.events.length,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      renderFps: avgRenderTime > 0 ? Math.round(1000 / avgRenderTime) : 0,
      usingWorker: !!this.options.workerUrl && this.wantsOffscreenRender,
      rawAssImageGpu: this.rawAssImageGpu && this.backend === 'webgl2',
      workerRenderer: this.wantsOffscreenRender && this.options.workerUrl
        ? this.rawAssImageGpu ? 'webgl2-raw-ass' : 'canvas2d'
        : 'main-thread',
      offscreenRender: this.wantsOffscreenRender,
      onDemandRender: this.onDemandRender
    }
  }

  private scheduleRVFC(video: HTMLVideoElement): void {
    if (!this.onDemandRender || this.destroyed || typeof video.requestVideoFrameCallback !== 'function') return
    const generation = this.rvfcGeneration
    this.videoFrameCallback = video.requestVideoFrameCallback((now, metadata) => {
      if (this.options.video === video && generation === this.rvfcGeneration) this.videoFrameCallback = 0
      if (this.destroyed || this.options.video !== video || generation !== this.rvfcGeneration) return
      this.handleRVFC(now, {
        mediaTime: Number.isFinite(metadata.mediaTime) ? metadata.mediaTime : video.currentTime,
        width: metadata.width,
        height: metadata.height,
        presentedFrames: metadata.presentedFrames,
        expectedDisplayTime: metadata.expectedDisplayTime,
        presentationTime: (metadata as VideoFrameCallbackMetadata).presentationTime
      })
    })
  }

  private handleRVFC(now: number, metadata: VideoFrameCallbackMetadata): void {
    if (this.destroyed) return
    const presentationId = this.nextPresentationId++
    const isPaused = this.isVideoPaused()
    const expectedDisplayTime = Number.isFinite(metadata.expectedDisplayTime)
      ? metadata.expectedDisplayTime
      : Number.isFinite(metadata.presentationTime)
        ? metadata.presentationTime
        : now
    const mediaTime = resolvePresentationMediaTime(
      metadata.mediaTime,
      this.options.video?.currentTime,
      !!this.frameTimeline?.length,
      this.frameTimeline?.mediaTimeOrigin,
      this.frameTimeline ?? undefined
    )

    let presented = false
    if (!isPaused && this.frameTimeline && this.framePrefetch > 0) {
      const frameIndex = presentedFrameIndex(this.frameTimeline, mediaTime)
      if (frameIndex >= 0) this.lastPresentedFrameIndex = frameIndex
      const prepared = this.preparedFrames.get(frameIndex)
      if (prepared) {
        this.preparedFrames.delete(frameIndex)
        this.presentPreparedFrame(prepared, presentationId)
        presented = true
      }
      this.primePreparedFrames(mediaTime)
    }

    if (!presented) this.renderAtMediaTime(mediaTime, false, presentationId, isPaused ? undefined : expectedDisplayTime)
    void this.dispatchNextPreparation()
    this.scheduleRVFC(this.options.video!)
  }

  private renderAtMediaTime(mediaTime: number, force = false, presentationId = this.nextPresentationId++, expectedDisplayTime?: number): void {
    if (!this.opened || this.destroyed) return
    if (presentationId < this.latestPresentationId) {
      this.framesDropped++
      return
    }
    this.latestPresentationId = presentationId

    const isPaused = this.isVideoPaused()
    const dispatchedAt = performance.now()
    const adaptiveLead =
      this.adaptiveTiming && !isPaused
        ? presentationLeadSeconds(dispatchedAt, expectedDisplayTime, this.timingCompensationSeconds)
        : 0
    const predicted = compensatedMediaTime(mediaTime, this.playbackRate(), this.renderAhead, adaptiveLead, isPaused)
    const renderTime = selectRenderMediaTime(this.frameTimeline, mediaTime, predicted, isPaused) + this.timeOffset

    this.busy = true
    this.pendingRenders++
    this.lastDemandDispatchedAt = dispatchedAt
    try {
      const painted = this.paintSubtitleTime(renderTime, force)
      if (painted && this.adaptiveTiming && !isPaused) {
        this.timingCompensationSeconds = updateTimingCompensation(
          this.timingCompensationSeconds,
          performance.now(),
          dispatchedAt
        )
      }
    } finally {
      this.busy = false
      this.pendingRenders = Math.max(0, this.pendingRenders - 1)
    }
  }

  private paintSubtitleTime(time: number, force: boolean): boolean {
    if (!this.opened) return false
    const started = performance.now()
    const planes = this.options.blendMode === 'js' || this.rawAssImageGpu ? this.opened.renderAtTimestamp(time) : undefined
    const frame = planes && this.options.blendMode === 'js'
      ? undefined
      : this.opened.renderFrameDataAtTimestamp(time)
    const compositionCount = planes?.compositionData.length ?? frame?.compositionCount ?? 0
    const bounds = frame?.bounds ?? null
    const cueKey = `${time.toFixed(4)}:${compositionCount}:${bounds?.x ?? -1}:${bounds?.y ?? -1}`
    this.layoutCanvas()
    if (!force && cueKey === this.lastCueKey) {
      this.cacheHits++
      return false
    }
    this.lastCueKey = cueKey
    this.cacheMisses++
    const painted = this.presentFrame(frame, planes, time)
    const renderTime = performance.now() - started
    this.lastImageCount = compositionCount
    this.lastImagePixels = planes
      ? planes.compositionData.reduce((sum, plane) => sum + plane.width * plane.height, 0)
      : frame
        ? frame.imageData.width * frame.imageData.height
        : 0
    this.recordRenderTime(renderTime)
    this.emitEvent({
      type: 'render',
      time,
      compositionCount,
      renderTime,
      bounds,
      backend: this.backend,
      dropped: !painted
    })
    return painted
  }

  private presentFrame(frame: AssRenderedFrameData | undefined, planes: ReturnType<AssParser['renderAtTimestamp']>, _time: number): boolean {
    try {
      if (this.gpuRenderer && planes && (this.rawAssImageGpu || this.backend !== 'canvas2d')) {
        this.gpuRenderer.render(planes)
        return true
      }
      if (!this.ctx) return false
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
      if (frame) {
        const bitmapCanvas = toCanvas(frame) as HTMLCanvasElement
        this.ctx.drawImage(bitmapCanvas, 0, 0, this.canvas.width, this.canvas.height)
      }
      return true
    } catch (error) {
      if (this.debug) console.warn('[rwss] present failed; preserving last subtitle frame', error)
      return false
    }
  }

  private presentPreparedFrame(prepared: PreparedFrame, presentationId: number): void {
    if (presentationId < this.latestPresentationId) {
      this.framesDropped++
      return
    }
    this.latestPresentationId = presentationId
    const painted = this.presentFrame(prepared.frame, undefined, prepared.time)
    if (!painted) this.framesDropped++
    this.emitEvent({
      type: 'render',
      time: prepared.time,
      compositionCount: prepared.planes ?? prepared.frame?.compositionCount ?? 0,
      renderTime: 0,
      bounds: prepared.frame?.bounds ?? null,
      backend: this.backend,
      dropped: !painted
    })
  }

  private primePreparedFrames(mediaTime: number): void {
    const timeline = this.frameTimeline
    if (!timeline || timeline.length === 0 || this.framePrefetch <= 0 || this.destroyed) return
    const currentIndex = presentedFrameIndex(timeline, mediaTime)
    const lastIndex = Math.min(timeline.length - 1, currentIndex + this.framePrefetch)
    for (const [index] of this.preparedFrames) {
      if (index < currentIndex || index > lastIndex) this.preparedFrames.delete(index)
    }
    this.prepareQueue = this.prepareQueue.filter((index) => index > currentIndex && index <= lastIndex)
    const requested = new Set([...this.preparedFrames.keys(), ...this.prepareQueue])
    for (let index = Math.max(0, currentIndex); index <= lastIndex; index++) {
      if (!requested.has(index)) this.prepareQueue.push(index)
    }
  }

  private async dispatchNextPreparation(): Promise<void> {
    if (this.preparing || !this.opened || !this.frameTimeline || this.framePrefetch <= 0) return
    this.preparing = true
    try {
      while (this.prepareQueue.length > 0 && !this.destroyed) {
        const index = this.prepareQueue.shift()
        if (index == null || this.preparedFrames.has(index)) continue
        const time = subtitleTimeForFrame(this.frameTimeline, index)
        if (!Number.isFinite(time)) continue
        const frame = this.opened.renderFrameDataAtTimestamp(time + this.timeOffset)
        this.preparedFrames.set(index, {
          index,
          time: time + this.timeOffset,
          width: frame?.screenWidth ?? this.canvas.width,
          height: frame?.screenHeight ?? this.canvas.height,
          frame,
          planes: frame?.compositionCount
        })
      }
    } finally {
      this.preparing = false
    }
  }

  private async fillExactFrameRunway(): Promise<void> {
    if (!this.shouldBufferExactFrames()) return
    const mediaTime = this.currentExactFrameMediaTime()
    this.renderAtMediaTime(mediaTime, true)
    this.primePreparedFrames(mediaTime)
    await this.dispatchNextPreparation()
  }

  private shouldBufferExactFrames(): boolean {
    return this.isVideoPaused() && this.onDemandRender && !!this.frameTimeline?.length && this.framePrefetch > 0
  }

  private currentExactFrameMediaTime(): number {
    const mediaTime = this.options.video?.currentTime ?? Math.max(0, this.state.currentTime - this.timeOffset)
    if (!this.frameTimeline?.length) return mediaTime
    const index = presentedFrameIndex(this.frameTimeline, mediaTime)
    return index >= 0 ? this.frameTimeline[index] : mediaTime
  }

  private currentVideoTimeWithOffset(): number {
    const currentTime = this.options.video?.currentTime ?? this.state.currentTime
    return (Number.isFinite(currentTime) ? currentTime : 0) + this.timeOffset
  }

  private playbackRate(): number {
    const rate = this.options.video?.playbackRate ?? this.state.rate
    return Number.isFinite(rate) && rate > 0 ? rate : 1
  }

  private isVideoPaused(): boolean {
    const video = this.options.video
    if (!video) return this.state.isPaused
    return !!(video.paused || video.ended || this.state.isPaused)
  }

  private syncVideoClock(event?: Event): void {
    const video = this.options.video
    if (!video || this.destroyed) return
    if (event) this.applyPlayState(event)
    this.state.rate = this.playbackRate()
    const shouldRenderExactFrame =
      this.isVideoPaused() ||
      event?.type === 'pause' ||
      event?.type === 'seeking' ||
      event?.type === 'seeked' ||
      event?.type === 'waiting' ||
      event?.type === 'stalled' ||
      event?.type === 'ended'
    if (shouldRenderExactFrame) {
      this.bumpRenderEpoch()
      this.renderAtMediaTime(video.currentTime, true)
      if (this.shouldBufferExactFrames()) {
        this.primePreparedFrames(this.currentExactFrameMediaTime())
        void this.dispatchNextPreparation()
      }
    }
  }

  private applyPlayState(event: Event): void {
    switch (event.type) {
      case 'play':
      case 'playing':
      case 'canplay':
        this.state.isPaused = false
        break
      case 'pause':
      case 'ended':
      case 'seeking':
      case 'waiting':
      case 'stalled':
        this.state.isPaused = true
        break
      case 'seeked':
        this.state.isPaused = this.isVideoPaused()
        break
    }
  }

  private bumpRenderEpoch(): void {
    this.renderEpoch++
    this.preparedFrames.clear()
    this.prepareQueue.length = 0
    this.lastCueKey = ''
  }

  private async reloadFromOptions(): Promise<void> {
    const content = await resolveSubtitleContent(this.options)
    await this.setTrackInternal(content, 'trackReady')
  }

  private async setTrackInternal(content: string, readyEvent: 'ready' | 'trackReady'): Promise<void> {
    this.bumpRenderEpoch()
    const prepared = this.prepareTrackText(content)
    await this.registerConfiguredFonts(prepared)
    this.opened?.dispose()
    this.currentTrackText = prepared
    this.opened = (await openAss(prepared, this.options.wasmUrl)) as AssParser
    this.events = this.opened.getEvents().map((event) => ({ ...event }))
    this.styles = this.opened.getStyles().map((style) => ({ ...style }))
    await this.maybeWarmTrack()
    if (this.shouldBufferExactFrames()) await this.fillExactFrameRunway()
    this.emitTrackReady(readyEvent)
  }

  private emitTrackReady(readyEvent: 'ready' | 'trackReady'): void {
    if (!this.opened) return
    if (readyEvent === 'ready') this.dispatchEvent(new CustomEvent('ready'))
    else this.dispatchEvent(new CustomEvent('trackReady'))
    this.emitEvent({ type: 'track-ready', metadata: this.opened.metadata })
  }

  private async maybeWarmTrack(): Promise<void> {
    if (!this.opened || !this.options.fullTrackWarmup) return
    const step = Math.max(0.04, this.options.fullTrackWarmupStep ?? 1)
    const times = this.opened.timestamps
    if (!times.length) return
    const last = times[times.length - 1]
    const warmup = () => {
      for (let time = times[0]; time <= last; time += step) this.opened?.renderAtTimestamp(time)
    }
    if (this.options.blockingFullTrackWarmup) warmup()
    else {
      this.emitEvent({ type: 'partial-ready' })
      this.dispatchEvent(new CustomEvent('partial_ready'))
      warmup()
    }
  }

  private prepareTrackText(content: string): string {
    let next = content
    if (this.options.dropAllBlur) next = dropBlur(next)
    if (this.options.dropAllAnimations) next = dropAnimations(next)
    return next
  }

  private async rebuildTrackFromState(): Promise<void> {
    const text = buildAssDocument(this.effectiveStyles(), this.events, this.opened?.metadata.playResX ?? 384, this.opened?.metadata.playResY ?? 288)
    await this.setTrackInternal(text, 'trackReady')
  }

  private async registerConfiguredFonts(content?: string): Promise<void> {
    const fallbackFonts = this.options.fallbackFonts ?? DEFAULT_FALLBACK_FONTS
    setFallbackFonts(fallbackFonts)
    const availableFonts = this.options.availableFonts ?? DEFAULT_AVAILABLE_FONTS
    const requestedFamilies = content ? extractRequestedFontFamilies(content) : []
    const selectedAvailableFonts = selectAvailableFonts(availableFonts, fallbackFonts, requestedFamilies)
    await registerAvailableFonts(selectedAvailableFonts, { fallbackFonts })
    if (this.options.useFontconfigProvider !== false) await this.registerLocalFonts(requestedFamilies)
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
          if (data.byteLength > MAX_FONT_BYTES) continue
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

  private initManagedGpuRenderer(): void {
    if (this.isLikelyWebKit) return
    try {
      if (isWebGPUSupported()) {
        this.gpuRenderer = new WebGPURenderer(this.canvas)
        this.backend = 'webgpu'
        void this.gpuRenderer.init()
        return
      }
      if (isWebGL2Supported()) {
        this.gpuRenderer = new WebGL2Renderer(this.canvas)
        this.backend = 'webgl2'
        void this.gpuRenderer.init()
      }
    } catch {
      this.gpuRenderer = null
      this.backend = 'canvas2d'
    }
  }

  private layoutCanvas(width?: number, height?: number, top = 0, left = 0): void {
    if (width && height) {
      this.setCanvasSize(width, height)
      if (this.canvas.style) {
        this.canvas.style.top = `${top}px`
        this.canvas.style.left = `${left}px`
      }
      return
    }

    const video = this.options.video
    if (!video || this.options.canvas) return

    const videoSize = getVideoPosition(video)
    const renderSize = computeRenderSize(
      videoSize.width || video.videoWidth || 1,
      videoSize.height || video.videoHeight || 1,
      this.prescaleFactor,
      this.prescaleHeightLimit,
      this.maxRenderHeight
    )
    this.setCanvasSize(Math.max(1, Math.round(renderSize.width)), Math.max(1, Math.round(renderSize.height)))
    if (!this.canvas.style) return
    this.canvas.style.width = `${videoSize.width}px`
    this.canvas.style.height = `${videoSize.height}px`
    this.canvas.style.top = `${videoSize.y}px`
    this.canvas.style.left = `${videoSize.x}px`
  }

  private setCanvasSize(width: number, height: number): void {
    const nextWidth = Math.max(1, Math.round(width))
    const nextHeight = Math.max(1, Math.round(height))
    if (this.canvas.width === nextWidth && this.canvas.height === nextHeight) return
    this.canvas.width = nextWidth
    this.canvas.height = nextHeight
    this.gpuRenderer?.updateSize(nextWidth, nextHeight)
    this.bumpRenderEpoch()
  }

  private clearCanvas(): void {
    this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }

  private createOverlayCanvas(video: HTMLVideoElement): HTMLCanvasElement {
    const canvas = document.createElement('canvas')
    canvas.className = 'Rwss'
    canvas.style.position = 'absolute'
    canvas.style.display = 'block'
    canvas.style.pointerEvents = 'none'
    canvas.style.zIndex = '0'
    const parent = document.createElement('div')
    parent.className = 'RwssContainer'
    parent.style.position = 'relative'
    parent.style.zIndex = '1'
    parent.style.isolation = 'isolate'
    parent.style.pointerEvents = 'none'
    video.insertAdjacentElement('afterend', parent)
    parent.append(video, canvas)
    this.canvasParent = parent
    return canvas
  }

  private removeVideoListeners(): void {
    const video = this.options.video
    if (!video || typeof video.removeEventListener !== 'function') return
    for (const type of ['timeupdate', 'progress', 'play', 'playing', 'pause', 'ended', 'waiting', 'stalled', 'seeking', 'seeked'] as const) {
      video.removeEventListener(type, this.boundTimeUpdate, false)
    }
    video.removeEventListener('ratechange', this.boundSetRate, false)
    video.removeEventListener('resize', this.boundResize, false)
    try {
      this.resizeObserver?.unobserve(video)
    } catch {
      // Detached videos can reject unobserve.
    }
  }

  private assertFontLimits(options: VideoAssSubtitleOptions): void {
    for (const [index, font] of (options.fonts ?? []).entries()) {
      const size = fontByteLength(font)
      if (size > MAX_FONT_BYTES) throw new Error(`Font ${index + 1} exceeds the 32 MiB per-font limit`)
    }
    for (const [name, font] of Object.entries(options.availableFonts ?? {})) {
      const size = fontByteLength(font)
      if (size > MAX_FONT_BYTES) throw new Error(`Font ${name} exceeds the 32 MiB per-font limit`)
    }
  }

  private emitEvent(event: Parameters<NonNullable<VideoAssSubtitleOptions['onEvent']>>[0]): void {
    this.options.onEvent?.(event)
  }
}

/** Default export of {@link AssRenderer}. */
export default AssRenderer

/** Construct an AssRenderer. */
export function createAssRenderer(options: VideoAssSubtitleOptions): AssRenderer {
  return new AssRenderer(options)
}

function fontByteLength(font: string | Uint8Array | ArrayBuffer | ArrayBufferView | RwssFontSource): number {
  if (typeof font === 'string') return 0
  if (font instanceof Uint8Array) return font.byteLength
  if (font instanceof ArrayBuffer) return font.byteLength
  if (ArrayBuffer.isView(font)) return font.byteLength
  if ('data' in font) return fontByteLength(font.data)
  return 0
}

function clampPrefetch(value: number): number {
  if (!Number.isFinite(value)) return 2
  return Math.max(0, Math.min(MAX_FRAME_PREFETCH, Math.floor(value)))
}

function dropAnimations(text: string): string {
  return text.replace(/\\(?:move|t|fad|fade|org)\b[^\\}]*/gi, '')
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
