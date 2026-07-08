export { signIn, signOut, isSignedIn, getAccessToken, getTokenExpiry, onAuthChange, getValidToken, tryAutoLogin } from './auth'
export {
  uploadStemSession,
  downloadStemSession,
  fetchCloudSessions,
  deleteCloudSession,
  isSessionInCloud,
  updateCloudStemMeta,
  loadLyricTrackFromCloud,
  createColabNotebookForSession,
  // External stem separation (Colab / local CLI)
  createExternalStemSession,
  createStemColabSession,
  createStemColabNotebook,
  checkExternalStemStatus,
  getExternalStemProgress,
  checkStemColabStatus,
  downloadStemFile,
  // Video state sync (cross-device recent videos + loop settings)
  fetchCloudVideoStates,
  uploadVideoStates,
  deleteCloudVideoState,
  isVideoInCloud,
  // Pitch cache sync
  uploadPitchRawAudio,
  uploadPitchedAudio,
  downloadPitchedAudio,
  downloadPitchRawAudio,
  getPitchCacheEntry,
} from './sync'
export type {
  CloudSession,
  UploadProgress,
  DownloadProgress,
  CloudVideoState,
  PitchCacheCloudEntry,
} from './sync'
