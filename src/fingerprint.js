/**
 * fingerprint.js — deterministic per-account browser profile.
 *
 * The same account code always yields the same profile (so a returning account looks like the same
 * device), while different codes spread across a small pool of coherent Windows machines.
 *
 * Two deliberate constraints:
 *
 * 1. Timezone is NOT a diversity dimension. Mainland China has a single tz, and most Chinese IANA
 *    names (Asia/Chongqing, Asia/Harbin, Asia/Hong_Kong) are aliases that `Intl` canonicalises back
 *    to `Asia/Shanghai` — using them would produce identical or implausible values. Every account
 *    therefore reports `Asia/Shanghai`, which is consistent with a China-based egress IP.
 *
 * 2. The user agent stays real (Windows, the installed Chromium's major version) unless the caller
 *    opts into `uaMode: 'spoofed'`. Chromium derives `sec-ch-ua`, `sec-ch-ua-platform` and
 *    `navigator.userAgentData` from the real binary; overriding only the UA string creates three
 *    mutually inconsistent surfaces, which is a stronger signal than a shared UA. Diversity comes
 *    from viewport / DPR / cores / memory / GPU strings / canvas noise instead.
 *
 * @module ego-publish/fingerprint
 */
import { createHmac } from 'node:crypto';

/** GPU vendors/renderers that are actually seen on Windows consumer machines. */
const GPUS = [
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00003EA0) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 (0x00001F82) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Series (0x000067DF) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) HD Graphics 630 (0x00005912) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
];

/** Coherent Windows desktop shapes. `viewport` is the inner window size. */
const SHAPES = [
  { viewport: { width: 1366, height: 657 }, dsf: 1, cores: 4, memory: 8 },
  { viewport: { width: 1440, height: 760 }, dsf: 1, cores: 8, memory: 8 },
  { viewport: { width: 1536, height: 824 }, dsf: 1.25, cores: 8, memory: 16 },
  { viewport: { width: 1600, height: 860 }, dsf: 1, cores: 12, memory: 16 },
  { viewport: { width: 1920, height: 969 }, dsf: 1, cores: 16, memory: 32 },
  { viewport: { width: 1280, height: 620 }, dsf: 1, cores: 6, memory: 8 },
  { viewport: { width: 1512, height: 822 }, dsf: 1.25, cores: 10, memory: 16 },
  { viewport: { width: 1745, height: 941 }, dsf: 1, cores: 8, memory: 16 },
];

const LOCALE = 'zh-CN';
const LANGUAGES = ['zh-CN', 'zh'];
const TIMEZONE = 'Asia/Shanghai';

function secret() {
  const raw = process.env.EGO_PUBLISH_FP_SECRET;
  if (raw && raw.trim()) return raw.trim();
  return 'ego-publish/fingerprint/v1';
}

function digest(code) {
  return createHmac('sha256', secret()).update(String(code)).digest();
}

/**
 * Derive the stable profile for one account code.
 *
 * @param {string} code
 * @param {{ uaMode?: 'real'|'spoofed', chromeMajor?: number|string, poolIndex?: number }} [options]
 * @returns {{
 *   code: string, slot: number, userAgent: string, platform: string, locale: string,
 *   languages: string[], timezoneId: string, viewport: {width:number,height:number},
 *   deviceScaleFactor: number, cores: number, memory: number,
 *   gpuVendor: string, gpuRenderer: string, seed: number,
 * }}
 */
export function deriveFingerprint(code, options = {}) {
  const hash = digest(code);
  const slot = options.poolIndex ?? hash[0] % SHAPES.length;
  const shape = SHAPES[slot % SHAPES.length];
  const gpu = GPUS[hash[1] % GPUS.length];
  const major = String(options.chromeMajor ?? readMajor(options) ?? 156).replace(/[^0-9].*$/, '') || '156';

  const realUa = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  const spoofedUa = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  const userAgent = options.uaMode === 'spoofed' ? spoofedUa : realUa;

  return {
    code,
    slot,
    userAgent,
    platform: 'Win32',
    locale: LOCALE,
    languages: LANGUAGES.slice(),
    timezoneId: TIMEZONE,
    viewport: { ...shape.viewport },
    deviceScaleFactor: shape.dsf,
    cores: shape.cores,
    memory: shape.memory,
    gpuVendor: gpu.vendor,
    gpuRenderer: gpu.renderer,
    seed: hash.readUInt32BE(2),
  };
}

/** Stable 32-bit seed for canvas/audio noise. */
export function noiseSeed(code) {
  return digest(code).readUInt32BE(2) % 100000;
}

function readMajor() {
  return null;
}

/** Only these keys are safe to echo into status output. */
export function publicFingerprint(fp) {
  if (!fp) return null;
  return {
    slot: fp.slot,
    viewport: `${fp.viewport.width}x${fp.viewport.height}`,
    deviceScaleFactor: fp.deviceScaleFactor,
    cores: fp.cores,
    memory: fp.memory,
    timezoneId: fp.timezoneId,
    locale: fp.locale,
    gpuRenderer: String(fp.gpuRenderer).slice(0, 60),
  };
}
