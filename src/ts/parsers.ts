import type { ASSEvent, ASSStyle, AssMetadata, AssSubtitleData, OpenedAssSubtitles, AssFrameRenderOptions, AssRenderedFrameData } from './types'
import { getWasm, initWasm, normalizeFrameData, renderFrameData } from './wasm'

type WasmAssParser = InstanceType<typeof import('../../pkg/rwss').AssParser>

/** Low-level ASS/SSA parser and frame renderer backed by rassa WASM. */
export class AssParser implements OpenedAssSubtitles {
  /** Always `'ass'`. */
  readonly format = 'ass' as const
  /** Parsed script metadata. */
  readonly metadata: AssMetadata
  /** Event timestamps in seconds. */
  readonly timestamps: Float64Array
  private parser: WasmAssParser

  private constructor(parser: WasmAssParser) {
    this.parser = parser
    this.metadata = parser.metadata()
    this.timestamps = new Float64Array(parser.timestamps())
  }

  /** Open ASS/SSA text and initialize WASM if needed. */
  static async open(text: string, wasmUrl?: string | URL | Request): Promise<AssParser> {
    await initWasm(wasmUrl)
    const { AssParser: WasmParser } = getWasm()
    return new AssParser(new WasmParser(text))
  }

  /** Render the event at a timestamp-list index. */
  renderAtIndex(index: number): AssSubtitleData | undefined {
    return this.callRender(() => this.parser.renderAtIndex(index))
  }

  /** Render ASS planes at a media timestamp in seconds. */
  renderAtTimestamp(timeSeconds: number): AssSubtitleData | undefined {
    return this.callRender(() => this.parser.renderAtTimestamp(timeSeconds))
  }

  /** Flatten the event at a timestamp-list index into RGBA. */
  renderFrameDataAtIndex(index: number, options?: AssFrameRenderOptions): AssRenderedFrameData | undefined {
    const raw = this.renderAtIndex(index)
    if (!raw) return undefined
    return options?.crop === 'bounds' ? renderFrameData(raw, options) : normalizeFrameData(this.parser.renderFrameDataAtIndex(index))
  }

  /** Flatten the frame at a media timestamp into RGBA. */
  renderFrameDataAtTimestamp(timeSeconds: number, options?: AssFrameRenderOptions): AssRenderedFrameData | undefined {
    const raw = this.renderAtTimestamp(timeSeconds)
    if (!raw) return undefined
    return options?.crop === 'bounds' ? renderFrameData(raw, options) : normalizeFrameData(this.parser.renderFrameDataAtTimestamp(timeSeconds))
  }

  /** Return parsed ASS events. */
  getEvents(): ASSEvent[] {
    return this.parser.getEvents() as ASSEvent[]
  }

  /** Return parsed ASS styles. */
  getStyles(): ASSStyle[] {
    return this.parser.getStyles() as ASSStyle[]
  }

  /** Clear parser-side render caches. */
  clearCache(): void {
    this.parser.clearCache()
  }

  /** Free WASM parser resources. */
  dispose(): void {
    this.parser.dispose()
  }

  private callRender(fn: () => AssSubtitleData): AssSubtitleData | undefined {
    try {
      const data = fn()
      return data.compositionData.length > 0 ? data : undefined
    } catch (error) {
      throw normalizeError(error)
    }
  }
}

/** Open an ASS/SSA document and return an OpenedAssSubtitles handle. */
export async function openAss(text: string, wasmUrl?: string | URL | Request): Promise<OpenedAssSubtitles> {
  return AssParser.open(text, wasmUrl)
}

/** Detect ASS/SSA from a file name or document header. */
export function detectSubtitleFormat(nameOrText: string): 'ass' | 'unknown' {
  const value = nameOrText.trimStart().toLowerCase()
  if (value.endsWith('.ass') || value.endsWith('.ssa') || value.startsWith('[script info]') || value.startsWith('[v4+ styles]')) {
    return 'ass'
  }
  return 'unknown'
}

/** Normalize unknown thrown values into Error instances. */
export function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
