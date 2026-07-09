export * from './types'
export { StemPlayer } from './stem-player'
export type { StemTrack, StemState, StemPlayerEvent } from './stem-player'
export { createStemMixerUI } from './mixer-ui'
export { createBestStemEngine, hasMinimumBrowserCapabilities } from './engine'
export { separateWithDemucsRs, isDemucsRsSupported, getDemucsRsModelLabel, getDemucsRsModelUrl } from './demucs-rs-adapter'
export type { DemucsRsModel } from './demucs-rs-adapter'

// Persistence (OPFS + localStorage manifest)
export {
  saveStemSession,
  loadStemSession,
  listStemSessions,
  deleteStemSession,
  findStemSessionForYouTubeVideo,
  findStemSessionByYouTubeTitle,
  updateStemSessionPresets,
  updateStemSessionMix,
  updateStemSessionLyricTrack,
  type StemSessionMeta,
} from './persistence'

// Local CLI (uvx) job helpers — Drive handoff for native Demucs on the user's machine
export {
  WEBLOOPER_STEMS_CLI_VERSION,
  WEBLOOPER_STEMS_PACKAGE,
  WEBLOOPER_STEMS_UVX_FROM,
  buildLocalCliJob,
  encodeJobPayload,
  formatUvxCommand,
  detectHostOs,
  getUvInstallCommand,
  getLocalCliUiCopy,
  UV_INSTALL_COMMAND,
  type LocalCliJobPayload,
  type HostOs,
} from './local-cli'

// Note: demucs-web 4-stem adapter has been fully removed per user request.
// 6-stem via demucs-rs (guitar + piano) is now the exclusive path.
