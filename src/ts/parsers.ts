import type { ASSEvent, ASSStyle, AssSubtitleData, OpenedAssSubtitles, AssFrameRenderOptions, AssRenderedFrameData } from './types'
import { getWasm, initWasm, normalizeFrameData, renderFrameData } from './wasm'

type WasmAssParser = InstanceType<typeof import('../../pkg/wrass').AssParser>

export class AssParser implements OpenedAssSubtitles {
  readonly format = 'ass' as const
  readonly metadata
  readonly timestamps: Float64Array
  private parser: WasmAssParser

  private constructor(parser: WasmAssParser) {
    this.parser = parser
    this.metadata = parser.metadata()
    this.timestamps = new Float64Array(parser.timestamps())
  }

  static async open(text: string, wasmUrl?: string | URL | Request): Promise<AssParser> {
    await initWasm(wasmUrl)
    const { AssParser: WasmParser } = getWasm()
    return new AssParser(new WasmParser(text))
  }

  renderAtIndex(index: number): AssSubtitleData | undefined {
    return this.callRender(() => this.parser.renderAtIndex(index))
  }

  renderAtTimestamp(timeSeconds: number): AssSubtitleData | undefined {
    return this.callRender(() => this.parser.renderAtTimestamp(timeSeconds))
  }

  renderFrameDataAtIndex(index: number, options?: AssFrameRenderOptions): AssRenderedFrameData | undefined {
    const raw = this.renderAtIndex(index)
    if (!raw) return undefined
    return options?.crop === 'bounds' ? renderFrameData(raw, options) : normalizeFrameData(this.parser.renderFrameDataAtIndex(index))
  }

  renderFrameDataAtTimestamp(timeSeconds: number, options?: AssFrameRenderOptions): AssRenderedFrameData | undefined {
    const raw = this.renderAtTimestamp(timeSeconds)
    if (!raw) return undefined
    return options?.crop === 'bounds' ? renderFrameData(raw, options) : normalizeFrameData(this.parser.renderFrameDataAtTimestamp(timeSeconds))
  }

  getEvents(): ASSEvent[] {
    return this.parser.getEvents() as ASSEvent[]
  }

  getStyles(): ASSStyle[] {
    return this.parser.getStyles() as ASSStyle[]
  }

  clearCache(): void {
    this.parser.clearCache()
  }

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

export async function openAss(text: string, wasmUrl?: string | URL | Request): Promise<OpenedAssSubtitles> {
  return AssParser.open(text, wasmUrl)
}

export function detectSubtitleFormat(nameOrText: string): 'ass' | 'unknown' {
  const value = nameOrText.trimStart().toLowerCase()
  if (value.endsWith('.ass') || value.endsWith('.ssa') || value.startsWith('[script info]') || value.startsWith('[v4+ styles]')) {
    return 'ass'
  }
  return 'unknown'
}

export function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
