/**
 * wrass TypeScript modules barrel export.
 */

export type {
  AssCueBounds,
  AssFrameRenderOptions,
  AssMetadata,
  AssRenderedFrameData,
  AssSubtitleData,
  AssSubtitleFormatName,
  ASSEvent,
  ASSEventCallback,
  ASSStyle,
  ASSStyleCallback,
  EncryptedSubtitleContent,
  OpenedAssSubtitles,
  PerformanceStats,
  PerformanceStatsCallback,
  RenderImage,
  RenderTimes,
  ResetStatsCallback,
  SubtitleColorSpace,
  VideoAssSubtitleOptions,
  WebYCbCrColorSpace,
  WrassBlendMode,
  WrassFrameCropMode,
  WrassPlaneData,
  WrassRendererBackend,
  WrassRendererEvent,
  WrassRendererStatsSnapshot,
  WrassFontSource,
  WrassFontLoadOptions,
  WrassAvailableFontLoadOptions,
  WrassRegisteredFont,
  WrassResolvedFont,
  HbGpuShaderMessage,
  HbGpuRenderMessage,
  WorkerInitMessage,
  WorkerInboundMessage,
  WorkerOutboundMessage
} from './types'

export { initWasm, isWasmInitialized, getWasm, getWasmUrl } from './wasm'
export {
  DEFAULT_AVAILABLE_FONTS,
  DEFAULT_FALLBACK_FONTS,
  registerFont,
  registerAvailableFonts,
  registerFontBytes,
  registerFontData,
  setFallbackFonts,
  clearRegisteredFonts,
  listRegisteredFonts,
  resolveFont
} from './wasm'
export { imageDataFromBytes, planeToImageData, renderFrameData, toBlob, toCanvas, toImageBitmap }
  from './wasm'
export { composeAssFrameCpu, putCompositionOnCanvas, type WrassImageCompositionResult } from './gpu-compositor'
export { createEncryptedSubtitleContent, decryptSubtitleContent, importAesGcmKey, type WrassRawAesKey } from './crypto'
export {
  AssRendererWorkerClient,
  createAssRendererWorkerClient,
  type AssRendererWorkerClientOptions,
  type SerializableWorkerOptions,
  type WrassWorkerRequest,
  type WrassWorkerResponse
} from './worker-client'
export { AssParser, detectSubtitleFormat, normalizeError, openAss } from './parsers'
export { AssRenderer, AssRenderer as AkariSub, createAssRenderer }
  from './renderers'
export { default } from './renderers'
export {
  colorMatrixConversionMap,
  computeCanvasSize,
  dropBlur,
  fixAlpha,
  fixPlayRes,
  getAlphaBug,
  getBitmapBug,
  getColorSpaceFilterUrl,
  getVideoPosition,
  libassYCbCrMap,
  parseAss,
  runFeatureTests,
  testImageBugs,
  webYCbCrMap
} from './utils'
export { WebGPURenderer, isWebGPUSupported, type WebGPURendererOptions } from './webgpu-renderer'
export { WebGL2Renderer, isWebGL2Supported } from './webgl2-renderer'
