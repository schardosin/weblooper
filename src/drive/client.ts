/**
 * Google Drive API v3 client — file operations via fetch.
 *
 * Uses the `drive.file` scope — only accesses files created by this app.
 * All stem data lives in a visible "WebLooper" folder in the user's Drive root.
 * Uses the Drive REST API directly — no gapi.client dependency.
 */

const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'

const APP_FOLDER_NAME = 'WebLooper'

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  modifiedTime: string
  size?: string
  parents?: string[]
}

// Cache the app root folder ID so we don't look it up every time
let appFolderId: string | null = null

/**
 * Get (or create) the root "WebLooper" folder in the user's Drive.
 * With drive.file scope, we can only see files/folders our app created,
 * so there's no risk of collision with user-created folders.
 */
export async function getAppFolder(token: string): Promise<string> {
  if (appFolderId) return appFolderId

  // Search for existing folder
  const params = new URLSearchParams({
    q: `name = '${APP_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id,name)',
    pageSize: '1',
  })

  const res = await fetch(`${DRIVE_API}/files?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!res.ok) {
    throw new DriveError('Failed to search for app folder', res.status)
  }

  const data = await res.json()
  if (data.files && data.files.length > 0) {
    appFolderId = data.files[0].id
    return appFolderId!
  }

  // Create it
  const createRes = await fetch(`${DRIVE_API}/files`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: APP_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    }),
  })

  if (!createRes.ok) {
    throw new DriveError('Failed to create app folder', createRes.status)
  }

  const folder = await createRes.json()
  appFolderId = folder.id
  return appFolderId!
}

/**
 * Reset the cached app folder ID (e.g. on sign-out).
 */
export function resetAppFolderCache(): void {
  appFolderId = null
}

/**
 * List files (optionally filtered by query).
 * Unlike appDataFolder, we query regular Drive space.
 */
export async function listFiles(
  token: string,
  query?: string,
): Promise<DriveFile[]> {
  const params = new URLSearchParams({
    fields: 'files(id,name,mimeType,modifiedTime,size,parents)',
    pageSize: '100',
  })
  if (query) params.set('q', query)

  const res = await fetch(`${DRIVE_API}/files?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!res.ok) {
    throw new DriveError('Failed to list files', res.status)
  }

  const data = await res.json()
  return data.files || []
}

/**
 * Create a folder inside the app's root folder (or a specified parent).
 * Returns the folder ID.
 */
export async function createFolder(
  token: string,
  name: string,
  parentId?: string,
): Promise<string> {
  // If no parent specified, use the app root folder
  const parent = parentId || await getAppFolder(token)

  const metadata = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [parent],
  }

  const res = await fetch(`${DRIVE_API}/files`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(metadata),
  })

  if (!res.ok) {
    throw new DriveError('Failed to create folder', res.status)
  }

  const data = await res.json()
  return data.id
}

/**
 * Upload a file to the app folder (or a subfolder).
 * Uses multipart upload for files < 5MB, resumable for larger.
 * Returns the file ID.
 */
export async function uploadFile(
  token: string,
  name: string,
  data: ArrayBuffer | string,
  mimeType: string,
  parentId?: string,
  onProgress?: (percent: number) => void,
): Promise<string> {
  const contentBytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
  const contentSize = contentBytes.byteLength

  // Resolve parent folder
  const parent = parentId || await getAppFolder(token)

  // For files < 5MB, use simple multipart upload
  if (contentSize < 5 * 1024 * 1024) {
    return uploadMultipart(token, name, contentBytes, mimeType, parent)
  }

  // For larger files, use resumable upload
  return uploadResumable(token, name, contentBytes, mimeType, parent, onProgress)
}

async function uploadMultipart(
  token: string,
  name: string,
  data: Uint8Array,
  mimeType: string,
  parentId: string,
): Promise<string> {
  const metadata = {
    name,
    parents: [parentId],
  }

  const boundary = '---weblooper_boundary_' + Date.now()
  const metaJson = JSON.stringify(metadata)

  // Build multipart body manually
  const encoder = new TextEncoder()
  const preamble = encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metaJson}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\nContent-Transfer-Encoding: binary\r\n\r\n`
  )
  const postamble = encoder.encode(`\r\n--${boundary}--`)

  const body = new Uint8Array(preamble.length + data.length + postamble.length)
  body.set(preamble, 0)
  body.set(data, preamble.length)
  body.set(postamble, preamble.length + data.length)

  const res = await fetch(`${UPLOAD_API}/files?uploadType=multipart`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
  })

  if (!res.ok) {
    throw new DriveError('Multipart upload failed', res.status)
  }

  const result = await res.json()
  return result.id
}

async function uploadResumable(
  token: string,
  name: string,
  data: Uint8Array,
  mimeType: string,
  parentId: string,
  onProgress?: (percent: number) => void,
): Promise<string> {
  // Step 1: Initiate resumable session
  const metadata = {
    name,
    parents: [parentId],
  }

  const initRes = await fetch(`${UPLOAD_API}/files?uploadType=resumable`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Upload-Content-Type': mimeType,
      'X-Upload-Content-Length': String(data.byteLength),
    },
    body: JSON.stringify(metadata),
  })

  if (!initRes.ok) {
    throw new DriveError('Failed to initiate resumable upload', initRes.status)
  }

  const uploadUrl = initRes.headers.get('Location')
  if (!uploadUrl) throw new DriveError('No upload URL in response', 500)

  // Step 2: Upload data in a single PUT (chunking not needed for < 50MB stems)
  onProgress?.(10)

  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Length': String(data.byteLength),
      'Content-Type': mimeType,
    },
    body: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
  })

  if (!uploadRes.ok) {
    throw new DriveError('Resumable upload failed', uploadRes.status)
  }

  onProgress?.(100)

  const result = await uploadRes.json()
  return result.id
}

/**
 * Download file content by ID.
 */
export async function downloadFile(token: string, fileId: string): Promise<ArrayBuffer> {
  const res = await fetch(`${DRIVE_API}/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!res.ok) {
    throw new DriveError('Failed to download file', res.status)
  }

  return await res.arrayBuffer()
}

/**
 * Download file content as text.
 */
export async function downloadFileAsText(token: string, fileId: string): Promise<string> {
  const res = await fetch(`${DRIVE_API}/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!res.ok) {
    throw new DriveError('Failed to download file', res.status)
  }

  return await res.text()
}

/**
 * Update (overwrite) an existing file's content.
 */
export async function updateFile(
  token: string,
  fileId: string,
  data: ArrayBuffer | string,
  mimeType: string,
): Promise<void> {
  const body = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)

  const res = await fetch(`${UPLOAD_API}/files/${fileId}?uploadType=media`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': mimeType,
    },
    body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
  })

  if (!res.ok) {
    throw new DriveError('Failed to update file', res.status)
  }
}

/**
 * Delete a file or folder by ID.
 */
export async function deleteFile(token: string, fileId: string): Promise<void> {
  const res = await fetch(`${DRIVE_API}/files/${fileId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!res.ok && res.status !== 404) {
    throw new DriveError('Failed to delete file', res.status)
  }
}

/**
 * Find a file by name in the app folder (or a specified parent).
 */
export async function findFileByName(token: string, name: string, parentId?: string): Promise<DriveFile | null> {
  let query = `name = '${name}' and trashed = false`
  if (parentId) {
    query += ` and '${parentId}' in parents`
  } else {
    const appFolder = await getAppFolder(token)
    query += ` and '${appFolder}' in parents`
  }

  const files = await listFiles(token, query)
  return files.length > 0 ? files[0] : null
}

class DriveError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(`[Drive] ${message} (${status})`)
    this.name = 'DriveError'
    this.status = status
  }
}
