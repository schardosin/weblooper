/**
 * Signature / `n` parameter deciphering for YouTube.
 *
 * YouTube obfuscates the `n` parameter (throttle parameter) on media URLs.
 * Without deciphering, downloads will be severely throttled or return 403.
 *
 * This implementation handles modern YouTube player JS obfuscation patterns
 * used as of 2025-2026. Inspired by techniques from yt-dlp and youtubei.js.
 */

export interface DecipheredUrl {
  url?: string;
  baseUrl?: string;
}

/**
 * Main entry point: Takes a format object and returns usable URLs with
 * deciphered n-parameter and signature if needed.
 */
export async function decipherFormat(
  format: {
    url?: string;
    baseUrl?: string;
    n?: string;
    signature?: string;
    signatureCipher?: string;
    playerUrl?: string;
  },
  playerUrlFromResponse?: string
): Promise<DecipheredUrl> {
  // If URLs have no n-parameter or signature cipher, they may work directly
  const urlStr = format.url || format.baseUrl || ''
  const hasNParam = urlStr.includes('&n=') || urlStr.includes('?n=')
  const hasSigCipher = !!format.signatureCipher

  if (!hasNParam && !hasSigCipher && !format.signature) {
    return {
      url: format.url || '',
      baseUrl: format.baseUrl || undefined,
    };
  }

  const playerUrl = format.playerUrl || playerUrlFromResponse;
  if (!playerUrl) {
    console.warn('[youtube] Deciphering may be needed but no player URL available. Trying URLs as-is.');
    return { url: format.url || '', baseUrl: format.baseUrl || undefined };
  }

  try {
    const decipherer = await getOrCreateDecipherer(playerUrl);
    const result: DecipheredUrl = {};

    if (format.signatureCipher) {
      // Format doesn't have a direct URL — need to construct it from signatureCipher
      const constructed = decipherer.decipherSignatureCipher(format.signatureCipher);
      if (constructed) result.url = constructed;
    } else if (format.url) {
      result.url = decipherer.decipherUrl(format.url);
    }

    if (format.baseUrl) {
      result.baseUrl = decipherer.decipherUrl(format.baseUrl);
    }

    return {
      url: result.url || format.url || '',
      baseUrl: result.baseUrl || format.baseUrl || undefined,
    };
  } catch (err) {
    console.error('[youtube] Signature deciphering failed:', err);
    return {
      url: format.url || '',
      baseUrl: format.baseUrl || undefined,
    };
  }
}

// --------------------------
// Internal Decipherer Logic
// --------------------------

interface Transform {
  type: 'reverse' | 'splice' | 'swap' | 'rotate' | 'push';
  param?: number;
}

class SignatureDecipherer {
  private sigTransforms: Transform[] = [];
  private nTransformFn: ((n: string) => string) | null = null;
  private playerJs: string = '';

  playerUrl: string;

  constructor(playerUrl: string) {
    this.playerUrl = playerUrl;
  }

  async init(): Promise<void> {
    this.playerJs = await this.fetchPlayerJs();
    this.sigTransforms = this.extractSignatureTransforms(this.playerJs);
    this.nTransformFn = this.extractNTransformFunction(this.playerJs);
  }

  private async fetchPlayerJs(): Promise<string> {
    // In dev mode, proxy through Vite to avoid CORS
    const isDev = import.meta.env?.DEV;
    let url = this.playerUrl;

    if (isDev && url.startsWith('https://www.youtube.com')) {
      url = url.replace('https://www.youtube.com', '/yt-api');
    }

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch player JS: ${res.status}`);
    return await res.text();
  }

  /**
   * Extract the n-parameter transform function from the player JS.
   *
   * Modern YouTube uses a complex function that manipulates an array of characters.
   * We attempt to extract and evaluate it directly for best accuracy.
   */
  private extractNTransformFunction(playerJs: string): ((n: string) => string) | null {
    // Strategy 1: Find the function by its characteristic structure
    // YouTube's n-transform typically looks like:
    //   var X = function(a) { var b = a.split(""), c = [...complex array...]; ... return b.join("") }
    // or:
    //   function X(a) { var b = a.split(""); ... return b.join("") }

    // Look for the variable assignment pattern that yt-dlp uses
    const nFuncPatterns = [
      // Pattern: enhanced_except_XYZ = function(a) {...}
      /(?:enhanced_except_|[a-zA-Z0-9$_]+)\s*=\s*function\(a\)\s*\{(\s*a\s*=\s*a\.split\(""\)[\s\S]*?return\s+a\.join\(""\))\}/,
      // Pattern: var X = function(a) { a = a.split(""); ... return a.join("") }
      /var\s+[a-zA-Z0-9$_]+\s*=\s*function\(a\)\s*\{(\s*a\s*=\s*a\.split\(""\)[\s\S]*?return\s+a\.join\(""\))\}/,
      // Pattern: function X(a) { a = a.split(""); ... return a.join("") }
      /function\s+[a-zA-Z0-9$_]+\s*\(a\)\s*\{(\s*a\s*=\s*a\.split\(""\)[\s\S]*?return\s+a\.join\(""\))\}/,
    ];

    for (const pattern of nFuncPatterns) {
      const match = playerJs.match(pattern);
      if (match && match[1]) {
        try {
          // Try to create an executable function from the matched body
          const fn = new Function('a', match[1]) as (a: string) => string;
          // Test with a dummy value to see if it works without error
          fn('abcdefghijklmnop');
          return fn;
        } catch {
          // Function creation or test failed — complex dependencies
          // Fall through to simpler transform extraction
        }
      }
    }

    // Strategy 2: Use simpler transform-based approach as fallback
    const transforms = this.extractNTransforms(playerJs);
    if (transforms.length > 0) {
      return (n: string) => this.applyTransforms(n, transforms);
    }

    console.warn('[youtube] Could not extract n-transform function from player JS.');
    return null;
  }

  /**
   * Fallback: Extract individual transform operations for the n-parameter.
   */
  private extractNTransforms(playerJs: string): Transform[] {
    const transforms: Transform[] = [];

    // Look for the common manipulation patterns in the n-transform function area
    const patterns = [
      /a=a\.split\(""\);([\s\S]{20,500}?)return a\.join\(""\)/,
      /b=a\.split\(""\);([\s\S]{20,500}?)return b\.join\(""\)/,
    ];

    for (const regex of patterns) {
      const match = playerJs.match(regex);
      if (match && match[1]) {
        return this.parseTransformOperations(match[1]);
      }
    }

    return transforms;
  }

  /**
   * Extract the signature deciphering transforms.
   * These handle the `s` (signature) parameter on cipher-protected streams.
   */
  private extractSignatureTransforms(playerJs: string): Transform[] {
    // Find the signature decipher function
    // It's typically referenced from a line like: a.set("alr","yes"); ... c&&(c=X(decodeURIComponent(c)), ...)
    // The function itself splits on "", applies transforms, and joins back.

    const sigFuncPatterns = [
      // Common pattern: \b[a-zA-Z0-9]+\s*=\s*function\(a\)\{a=a\.split\(""\);(.+?);return a\.join\(""\)\}
      /\b[a-zA-Z0-9$]+\s*=\s*function\(a\)\{a=a\.split\(""\);([^}]+);return a\.join\(""\)\}/,
      /function [a-zA-Z0-9$]+\(a\)\{a=a\.split\(""\);([^}]+);return a\.join\(""\)\}/,
    ];

    for (const pattern of sigFuncPatterns) {
      const match = playerJs.match(pattern);
      if (match && match[1]) {
        return this.parseSignatureTransformCalls(match[1], playerJs);
      }
    }

    return [];
  }

  /**
   * Parse the signature transform calls like: Xy.rK(a,2);Xy.Ed(a,51);Xy.rK(a,3);Xy.rA(a)
   * We need to resolve what each method does (reverse, splice, swap).
   */
  private parseSignatureTransformCalls(callsCode: string, fullJs: string): Transform[] {
    const transforms: Transform[] = [];

    // Extract the object name (e.g., "Xy" from "Xy.rK(a,2)")
    const objMatch = callsCode.match(/([a-zA-Z0-9$_]+)\.[a-zA-Z0-9$_]+\(/);
    if (!objMatch) return this.parseTransformOperations(callsCode);

    const objName = objMatch[1];

    // Find the object definition to understand what each method does
    const objPattern = new RegExp(
      `var\\s+${objName.replace(/\$/g, '\\$')}\\s*=\\s*\\{([\\s\\S]*?)\\};`
    );
    const objMatch2 = fullJs.match(objPattern);

    if (!objMatch2) return this.parseTransformOperations(callsCode);

    const objBody = objMatch2[1];

    // Map method names to transform types
    const methodMap = new Map<string, 'reverse' | 'splice' | 'swap'>();

    // reverse: function(a){a.reverse()}
    const reversePattern = /([a-zA-Z0-9$_]+)\s*:\s*function\s*\(\s*a\s*\)\s*\{\s*a\.reverse\(\)\s*\}/g;
    let m;
    while ((m = reversePattern.exec(objBody)) !== null) {
      methodMap.set(m[1], 'reverse');
    }

    // splice: function(a,b){a.splice(0,b)}
    const splicePattern = /([a-zA-Z0-9$_]+)\s*:\s*function\s*\(\s*a\s*,\s*b\s*\)\s*\{\s*a\.splice\(\s*0\s*,\s*b\s*\)\s*\}/g;
    while ((m = splicePattern.exec(objBody)) !== null) {
      methodMap.set(m[1], 'splice');
    }

    // swap: function(a,b){var c=a[0];a[0]=a[b%a.length];a[b%a.length]=c}
    const swapPattern = /([a-zA-Z0-9$_]+)\s*:\s*function\s*\(\s*a\s*,\s*b\s*\)\s*\{[^}]*?a\[0\][^}]*?\}/g;
    while ((m = swapPattern.exec(objBody)) !== null) {
      if (!methodMap.has(m[1])) {
        methodMap.set(m[1], 'swap');
      }
    }

    // Now parse the calls
    const callPattern = new RegExp(
      `${objName.replace(/\$/g, '\\$')}\\.([a-zA-Z0-9$_]+)\\(a(?:,(\\d+))?\\)`,
      'g'
    );

    while ((m = callPattern.exec(callsCode)) !== null) {
      const method = m[1];
      const param = m[2] ? parseInt(m[2], 10) : undefined;
      const type = methodMap.get(method);

      if (type) {
        transforms.push({ type, param });
      }
    }

    return transforms;
  }

  private parseTransformOperations(code: string): Transform[] {
    const transforms: Transform[] = [];
    const ops = code.split(';').map(s => s.trim()).filter(Boolean);

    for (const op of ops) {
      if (/\.reverse\(\)/.test(op)) {
        transforms.push({ type: 'reverse' });
      } else if (/\.splice\(\s*0\s*,\s*(\d+)\s*\)/.test(op)) {
        const m = op.match(/\.splice\(\s*0\s*,\s*(\d+)\s*\)/);
        if (m) transforms.push({ type: 'splice', param: parseInt(m[1], 10) });
      } else {
        // Check for swap patterns: a[0]=a[N%a.length] or similar
        const swapMatch = op.match(/\[0\].*?\[(\d+)%/);
        if (swapMatch) {
          transforms.push({ type: 'swap', param: parseInt(swapMatch[1], 10) });
        }
      }
    }

    return transforms;
  }

  /**
   * Apply transforms to a string value.
   */
  private applyTransforms(value: string, transforms: Transform[]): string {
    let result = value.split('');

    for (const t of transforms) {
      switch (t.type) {
        case 'reverse':
          result.reverse();
          break;
        case 'splice':
          if (t.param !== undefined) result.splice(0, t.param);
          break;
        case 'swap':
          if (t.param !== undefined) {
            const pos = t.param % result.length;
            [result[0], result[pos]] = [result[pos], result[0]];
          }
          break;
        case 'rotate':
          if (t.param !== undefined) {
            const n = t.param % result.length;
            result = [...result.slice(n), ...result.slice(0, n)];
          }
          break;
      }
    }

    return result.join('');
  }

  /**
   * Decipher a URL by transforming the `n` parameter (throttle prevention).
   */
  decipherUrl(originalUrl: string): string {
    try {
      const url = new URL(originalUrl);

      // Transform the n parameter if present and we have a transform function
      const nParam = url.searchParams.get('n');
      if (nParam && this.nTransformFn) {
        try {
          const decipheredN = this.nTransformFn(nParam);
          url.searchParams.set('n', decipheredN);
        } catch (e) {
          console.warn('[youtube] n-parameter transform failed, keeping original', e);
        }
      }

      return url.toString();
    } catch (e) {
      console.warn('[youtube] Failed to parse/decipher URL, returning original', e);
      return originalUrl;
    }
  }

  /**
   * Decipher a signatureCipher string and construct the full URL.
   * signatureCipher is URL-encoded: "s=...&sp=sig&url=..."
   */
  decipherSignatureCipher(signatureCipher: string): string | null {
    try {
      const params = new URLSearchParams(signatureCipher);
      const sig = params.get('s');
      const sp = params.get('sp') || 'signature';
      const url = params.get('url');

      if (!sig || !url) return null;

      // Decipher the signature
      const decipheredSig = this.sigTransforms.length > 0
        ? this.applyTransforms(sig, this.sigTransforms)
        : sig;

      // Build the full URL
      const fullUrl = new URL(url);
      fullUrl.searchParams.set(sp, decipheredSig);

      // Also decipher the n parameter on the constructed URL
      return this.decipherUrl(fullUrl.toString());
    } catch (e) {
      console.error('[youtube] Failed to decipher signatureCipher', e);
      return null;
    }
  }
}

// Simple cache so we don't re-download the same player JS repeatedly
const deciphererCache = new Map<string, SignatureDecipherer>();

async function getOrCreateDecipherer(playerUrl: string): Promise<SignatureDecipherer> {
  if (deciphererCache.has(playerUrl)) {
    return deciphererCache.get(playerUrl)!;
  }

  const decipherer = new SignatureDecipherer(playerUrl);
  await decipherer.init();
  deciphererCache.set(playerUrl, decipherer);

  return decipherer;
}
