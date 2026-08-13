/**
 * Internal TypeScript barrel for the rwss public API.
 *
 * @module
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
  AkariSubOptions,
  EncryptedSubtitleContent,
  FrameTimeline,
  OpenedAssSubtitles,
  PerformanceStats,
  PerformanceStatsCallback,
  RawASSImage,
  RenderImage,
  RenderMessage,
  RenderTimes,
  ResetStatsCallback,
  SubtitleColorSpace,
  VideoAssSubtitleOptions,
  VideoFrameCallbackMetadata,
  WebYCbCrColorSpace,
  RwssFrameCropMode,
  RwssPlaneData,
  RwssRendererBackend,
  RwssRendererEvent,
  RwssRendererStatsSnapshot,
  RwssFontSource,
  RwssFontLoadOptions,
  RwssAvailableFontLoadOptions,
  RwssRegisteredFont,
  RwssResolvedFont,
  WorkerInitMessage,
  WorkerInboundMessage,
  WorkerOutboundMessage
} from './types'
export {
  MAX_FONT_BYTES,
  MAX_FRAME_PREFETCH,
  MAX_RENDER_IMAGES,
  MAX_RENDER_PIXELS
} from './types'

export { initWasm, isWasmInitialized, getWasm, getWasmUrl, getWasmGlueUrl } from './wasm'
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
export { composeAssFrameCpu, putCompositionOnCanvas, type RwssImageCompositionResult } from './gpu-compositor'
export { createEncryptedSubtitleContent, decryptSubtitleContent, importAesGcmKey, type RwssRawAesKey } from './crypto'
export {
  AssRendererWorkerClient,
  createAssRendererWorkerClient,
  type AssRendererWorkerClientOptions,
  type SerializableWorkerOptions,
  type RwssWorkerRequest,
  type RwssWorkerResponse
} from './worker-client'
export { AssParser, detectSubtitleFormat, normalizeError, openAss } from './parsers'
export { AssRenderer, createAssRenderer } from './renderers'
/** Alias of {@link AssRenderer} for AkariSub-compatible integrations. */
export { AssRenderer as AkariSub } from './renderers'
/** Default export of {@link AssRenderer}. */
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
export {
  compensatedMediaTime,
  compositorScheduleLeadMs,
  estimateRefreshIntervalMs,
  frameIndexAtOrAfter,
  isStalePresentation,
  nearestFrameIndex,
  normalizeFrameTimeline,
  presentationLeadSeconds,
  predictFrameDisplayTimeMs,
  presentedFrameIndex,
  resolvePresentationMediaTime,
  secondsToAssMs,
  selectRenderMediaTime,
  snapToFrameTimeline,
  snapToSubtitleTimeline,
  subtitleTimeForFrame,
  updateTimingCompensation
} from './timing'
