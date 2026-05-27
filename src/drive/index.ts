export { signIn, signOut, isSignedIn, getAccessToken, onAuthChange, getValidToken } from './auth'
export {
  uploadStemSession,
  downloadStemSession,
  fetchCloudSessions,
  deleteCloudSession,
  isSessionInCloud,
  // Video state sync (cross-device recent videos + loop settings)
  fetchCloudVideoStates,
  uploadVideoStates,
  deleteCloudVideoState,
  isVideoInCloud,
} from './sync'
export type {
  CloudSession,
  UploadProgress,
  DownloadProgress,
  CloudVideoState,
} from './sync'
