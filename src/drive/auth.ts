/**
 * Google Identity Services (GIS) OAuth2 authentication for Google Drive.
 *
 * Uses the Token Client flow (implicit grant) — no backend needed.
 * The access token is persisted in localStorage so it survives new tabs / page reloads
 * (valid for ~1 hour from issuance).
 *
 * Scope: drive.file — access only to files created by this app.
 * Stems are stored in a visible "WebLooper" folder in the user's Drive.
 */

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string
const SCOPES = 'https://www.googleapis.com/auth/drive.file'
const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client'

const STORAGE_KEY_TOKEN = 'weblooper_drive_token'
const STORAGE_KEY_EXPIRY = 'weblooper_drive_token_expiry'

type AuthChangeCallback = (signedIn: boolean) => void

let accessToken: string | null = null
let tokenExpiry: number = 0
let tokenClient: any = null
let gisLoaded = false
let gisLoadPromise: Promise<void> | null = null
const authChangeListeners: Set<AuthChangeCallback> = new Set()

// ---------- Persistence helpers ----------

function persistToken(): void {
  try {
    if (accessToken && tokenExpiry > Date.now()) {
      localStorage.setItem(STORAGE_KEY_TOKEN, accessToken)
      localStorage.setItem(STORAGE_KEY_EXPIRY, String(tokenExpiry))
    } else {
      localStorage.removeItem(STORAGE_KEY_TOKEN)
      localStorage.removeItem(STORAGE_KEY_EXPIRY)
    }
  } catch {}
}

function restoreToken(): void {
  try {
    const token = localStorage.getItem(STORAGE_KEY_TOKEN)
    const expiry = Number(localStorage.getItem(STORAGE_KEY_EXPIRY) || '0')
    if (token && expiry > Date.now()) {
      accessToken = token
      tokenExpiry = expiry
    } else {
      // Expired — clean up
      localStorage.removeItem(STORAGE_KEY_TOKEN)
      localStorage.removeItem(STORAGE_KEY_EXPIRY)
    }
  } catch {}
}

function clearPersistedToken(): void {
  try {
    localStorage.removeItem(STORAGE_KEY_TOKEN)
    localStorage.removeItem(STORAGE_KEY_EXPIRY)
  } catch {}
}

// Restore on module load (runs when any tab imports this module)
restoreToken()

// ---------- GIS Script Loading ----------

/**
 * Load the Google Identity Services script dynamically.
 */
function loadGisScript(): Promise<void> {
  if (gisLoaded) return Promise.resolve()
  if (gisLoadPromise) return gisLoadPromise

  gisLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = GIS_SCRIPT_URL
    script.async = true
    script.defer = true
    script.onload = () => {
      gisLoaded = true
      resolve()
    }
    script.onerror = () => reject(new Error('Failed to load Google Identity Services script'))
    document.head.appendChild(script)
  })

  return gisLoadPromise
}

function notifyListeners() {
  const signedIn = isSignedIn()
  authChangeListeners.forEach(cb => cb(signedIn))
}

// ---------- Public API ----------

/**
 * Check if the user is currently signed in with a valid token.
 */
export function isSignedIn(): boolean {
  return !!accessToken && Date.now() < tokenExpiry
}

/**
 * Get the current access token (or null if not signed in / expired).
 */
export function getAccessToken(): string | null {
  if (!accessToken || Date.now() >= tokenExpiry) return null
  return accessToken
}

/**
 * Initiate Google sign-in. Opens the Google consent popup.
 * Returns the access token on success.
 */
export async function signIn(): Promise<string> {
  if (!CLIENT_ID) {
    throw new Error('Google Client ID not configured. Set VITE_GOOGLE_CLIENT_ID in .env')
  }

  await loadGisScript()

  return new Promise((resolve, reject) => {
    const google = (window as any).google

    if (!google?.accounts?.oauth2) {
      reject(new Error('Google Identity Services not available'))
      return
    }

    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      callback: (response: any) => {
        if (response.error) {
          reject(new Error(`Google sign-in failed: ${response.error}`))
          return
        }
        accessToken = response.access_token
        // Token typically expires in 3600 seconds; we set expiry slightly early
        tokenExpiry = Date.now() + (response.expires_in - 60) * 1000
        persistToken()
        notifyListeners()
        resolve(accessToken!)
      },
      error_callback: (error: any) => {
        reject(new Error(`Google sign-in error: ${error?.type || error?.message || 'unknown'}`))
      },
    })

    tokenClient.requestAccessToken()
  })
}

/**
 * Sign out — revoke the token and clear local state.
 */
export function signOut(): void {
  if (accessToken) {
    const google = (window as any).google
    try {
      google?.accounts?.oauth2?.revoke?.(accessToken)
    } catch {}
  }
  accessToken = null
  tokenExpiry = 0
  clearPersistedToken()
  // Clear cached folder ID
  import('./client').then(c => c.resetAppFolderCache()).catch(() => {})
  notifyListeners()
}

/**
 * Register a callback for auth state changes.
 * Returns an unsubscribe function.
 */
export function onAuthChange(cb: AuthChangeCallback): () => void {
  authChangeListeners.add(cb)
  return () => { authChangeListeners.delete(cb) }
}

/**
 * Get a valid token, re-authenticating if expired.
 * Throws if the user denies consent.
 */
export async function getValidToken(): Promise<string> {
  const current = getAccessToken()
  if (current) return current
  return await signIn()
}
