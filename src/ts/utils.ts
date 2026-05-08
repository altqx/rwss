import type { SubtitleColorSpace, WebYCbCrColorSpace } from './types'

export const webYCbCrMap: Record<string, WebYCbCrColorSpace> = {
  bt709: 'BT709',
  bt470bg: 'BT601',
  smpte170m: 'BT601'
}

export const libassYCbCrMap: Record<string, SubtitleColorSpace> = {
  'TV.601': 'BT601',
  'TV.709': 'BT709',
  'TV.240M': 'SMPTE240M',
  'TV.FCC': 'FCC'
}

export const colorMatrixConversionMap: Record<string, Record<string, string>> = {
  BT601: {
    BT709: '1.0864 -0.0723 -0.0141 0 0 0.0965 0.8451 0.0584 0 0 -0.0141 -0.0277 1.0418 0 0 0 0 0 1 0'
  },
  BT709: {
    BT601: '0.9136 0.0784 0.008 0 0 -0.105 1.1722 -0.0672 0 0 0.0096 0.0322 0.9582 0 0 0 0 0 1 0'
  }
}

export function computeCanvasSize(video: HTMLVideoElement, maxRenderHeight = 0): { width: number; height: number } {
  const width = video.videoWidth || Math.round(video.getBoundingClientRect().width) || 1
  const height = video.videoHeight || Math.round(video.getBoundingClientRect().height) || 1
  if (maxRenderHeight > 0 && height > maxRenderHeight) {
    const scale = maxRenderHeight / height
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(maxRenderHeight)) }
  }
  return { width: Math.max(1, width), height: Math.max(1, height) }
}

export function getVideoPosition(video: HTMLVideoElement): { x: number; y: number; width: number; height: number } {
  const rect = video.getBoundingClientRect()
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
}

export function fixAlpha(data: Uint8ClampedArray | Uint8Array): Uint8ClampedArray | Uint8Array {
  for (let index = 3; index < data.length; index += 4) data[index] = Math.max(0, Math.min(255, data[index]))
  return data
}

export function parseAss(text: string): { info: Record<string, string>; styles: string[]; events: string[] } {
  const info: Record<string, string> = {}
  const styles: string[] = []
  const events: string[] = []
  let section = ''
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (/^\[.*\]$/.test(trimmed)) section = trimmed.toLowerCase()
    else if (section === '[script info]' && trimmed.includes(':')) {
      const separator = trimmed.indexOf(':')
      info[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim()
    } else if (section === '[v4+ styles]' && trimmed.startsWith('Style:')) styles.push(trimmed)
    else if (section === '[events]' && /^(Dialogue|Comment):/.test(trimmed)) events.push(trimmed)
  }
  return { info, styles, events }
}

export function dropBlur(text: string): string {
  return text.replace(/\\(?:blur|be)\s*[-+]?\d*\.?\d+/gi, '')
}

export function fixPlayRes(text: string, width = 384, height = 288): string {
  const hasX = /^PlayResX:/mi.test(text)
  const hasY = /^PlayResY:/mi.test(text)
  let next = text
  if (hasX) next = next.replace(/^PlayResX:.*$/mi, `PlayResX: ${width}`)
  if (hasY) next = next.replace(/^PlayResY:.*$/mi, `PlayResY: ${height}`)
  if (!hasX || !hasY) next = next.replace(/\[Script Info\]\s*/i, `[Script Info]\n${!hasX ? `PlayResX: ${width}\n` : ''}${!hasY ? `PlayResY: ${height}\n` : ''}`)
  return next
}

export function testImageBugs(): { alphaBug: boolean; bitmapBug: boolean } {
  return { alphaBug: false, bitmapBug: false }
}

export function runFeatureTests(): { canvas2d: boolean; webgl2: boolean; webgpu: boolean; offscreenCanvas: boolean } {
  return {
    canvas2d: typeof document !== 'undefined' && !!document.createElement('canvas').getContext('2d'),
    webgl2: typeof document !== 'undefined' && !!document.createElement('canvas').getContext('webgl2'),
    webgpu: typeof navigator !== 'undefined' && 'gpu' in navigator,
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined'
  }
}

export function getAlphaBug(): boolean {
  return testImageBugs().alphaBug
}

export function getBitmapBug(): boolean {
  return testImageBugs().bitmapBug
}

export function getColorSpaceFilterUrl(matrix: string): string {
  return `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'><filter id='f'><feColorMatrix type='matrix' values='${encodeURIComponent(matrix)}'/></filter></svg>#f")`
}
