/**
 * Google Identity Services (GIS) OAuth2 authentication for Google Drive.
 *
 * Uses the Token Client flow (implicit grant) — no backend needed.
 * The access token is persisted in localStorage so it survives new tabs / page reloads
 * (valid for ~1 hour from issuance).
 *
 * Auto-renewal: When the token expires, we attempt a silent re-auth (no popup).
 * If the user has previously granted consent, Google will issue a new token
 * without user interaction. The popup only shows on first-time sign-in.
 *
 * Scope: drive.file — access only to files created by this app.
 * Stems are stored in a visible "WebLooper" folder in the user's Drive.
 */

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string
const SCOPES = 'https://www.googleapis.com/auth/drive.file'
const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client'

const STORAGE_KEY_TOKEN = 'weblooper_drive_token'
const STORAGE_KEY_EXPIRY = 'weblooper_drive_token_expiry'
const STORAGE_KEY_WAS_SIGNED_IN = 'weblooper_drive_was_signed_in'

type AuthChangeCallback = (signedIn: boolean) => void

let accessToken: string | null = null
let tokenExpiry: number = 0
let tokenClient: any = null
let gisLoaded = false
let gisLoadPromise: Promise<void> | null = null
let silentRefreshInProgress: Promise<string | null> | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null
const authChangeListeners: Set<AuthChangeCallback> = new Set()

// ---------- Proactive Refresh Timer ----------

/**
 * Schedule a silent token refresh ~5 minutes before expiry.
 * This keeps the session alive without user interaction.
 */
function scheduleProactiveRefresh(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
  if (!accessToken || tokenExpiry <= Date.now()) return

  const msUntilExpiry = tokenExpiry - Date.now()
  // Refresh 5 minutes before expiry, or at half-life if less than 10 min remaining
  const refreshIn = Math.max(msUntilExpiry - 5 * 60 * 1000, msUntilExpiry / 2)

  if (refreshIn <= 0) {
    // Already close to expiry — refresh now
    silentRefresh().catch(() => {})
    return
  }

  refreshTimer = setTimeout(() => {
    console.log('[drive-auth] Proactive token refresh triggered')
    silentRefresh().catch((err) => {
      console.warn('[drive-auth] Proactive refresh failed:', err)
    })
  }, refreshIn)
}

// ---------- Persistence helpers ----------

function persistToken(): void {
  try {
    if (accessToken && tokenExpiry > Date.now()) {
      localStorage.setItem(STORAGE_KEY_TOKEN, accessToken)
      localStorage.setItem(STORAGE_KEY_EXPIRY, String(tokenExpiry))
      localStorage.setItem(STORAGE_KEY_WAS_SIGNED_IN, '1')
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
      // Expired — clean up token but keep was_signed_in flag
      localStorage.removeItem(STORAGE_KEY_TOKEN)
      localStorage.removeItem(STORAGE_KEY_EXPIRY)
    }
  } catch {}
}

function clearPersistedToken(): void {
  try {
    localStorage.removeItem(STORAGE_KEY_TOKEN)
    localStorage.removeItem(STORAGE_KEY_EXPIRY)
    localStorage.removeItem(STORAGE_KEY_WAS_SIGNED_IN)
  } catch {}
}

/**
 * Check if the user was previously signed in (even if token is expired).
 * Used to trigger auto-renewal on app load.
 */
function wasSignedIn(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY_WAS_SIGNED_IN) === '1'
  } catch {
    return false
  }
}

// Restore on module load (runs when any tab imports this module)
restoreToken()
// If we restored a valid token, schedule proactive refresh before it expires
if (accessToken && tokenExpiry > Date.now()) {
  scheduleProactiveRefresh()
}

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
        scheduleProactiveRefresh()
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
 * Attempt to silently refresh the token without showing a popup.
 * This works if the user has previously granted consent to this app.
 * Returns the new token, or null if silent refresh failed (user needs interactive sign-in).
 */
async function silentRefresh(): Promise<string | null> {
  if (!CLIENT_ID) return null
  if (!wasSignedIn()) return null

  try {
    await loadGisScript()

    const google = (window as any).google
    if (!google?.accounts?.oauth2) return null

    return new Promise((resolve) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: (response: any) => {
          if (response.error) {
            console.log('[drive-auth] Silent refresh failed:', response.error)
            resolve(null)
            return
          }
          accessToken = response.access_token
          tokenExpiry = Date.now() + (response.expires_in - 60) * 1000
          persistToken()
          scheduleProactiveRefresh()
          notifyListeners()
          console.log('[drive-auth] Silent token refresh successful')
          resolve(accessToken!)
        },
        error_callback: () => {
          resolve(null)
        },
      })

      // prompt: '' means no user interaction — just try to get a token silently
      client.requestAccessToken({ prompt: '' })
    })
  } catch (err) {
    console.warn('[drive-auth] Silent refresh error:', err)
    return null
  }
}

/**
 * Sign out — revoke the token and clear local state.
 */
export function signOut(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
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
 * Get a valid token, re-authenticating silently if expired.
 * If silent refresh fails (e.g., consent revoked), falls back to interactive sign-in popup.
 * Throws if the user denies consent.
 */
export async function getValidToken(): Promise<string> {
  const current = getAccessToken()
  if (current) return current

  // Try silent refresh first (no popup)
  if (wasSignedIn()) {
    // Dedup concurrent silent refresh attempts
    if (!silentRefreshInProgress) {
      silentRefreshInProgress = silentRefresh().finally(() => {
        silentRefreshInProgress = null
      })
    }
    const refreshed = await silentRefreshInProgress
    if (refreshed) return refreshed
  }

  // Silent refresh failed — need interactive sign-in
  return await signIn()
}

/**
 * Attempt auto-login on app startup if the user was previously signed in.
 * This runs silently in the background — no popup, no user action needed.
 * If it fails (consent revoked, network error), the user stays signed out silently.
 */
export async function tryAutoLogin(): Promise<void> {
  if (isSignedIn()) return // Already have a valid token
  if (!wasSignedIn()) return // User never signed in before

  try {
    if (!silentRefreshInProgress) {
      silentRefreshInProgress = silentRefresh().finally(() => {
        silentRefreshInProgress = null
      })
    }
    await silentRefreshInProgress
  } catch {
    // Silently fail — user will see "Sign in" button and can sign in manually
  }
}
