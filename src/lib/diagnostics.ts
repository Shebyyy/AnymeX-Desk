/**
 * Diagnostics and Crash Log parser.
 *
 * Extracts application version, platform, OS version, ROM, and exception type
 * from raw pasted logcat / error traces, and redacts sensitive tokens.
 */

export interface ParsedDiagnostics {
  appVersion?: string;
  platform?: string;
  osDetails?: string;
  exceptionType?: string;
  cleanedLog: string;
}

export function parseCrashLog(raw: string): ParsedDiagnostics {
  let appVersion: string | undefined;
  let platform: string | undefined;
  let osDetails: string | undefined;
  let exceptionType: string | undefined;

  // Detect App Version: e.g. "AnymeX v3.1.7", "Version: 3.1.7+39", "App Version: 3.2.0"
  const verMatch = raw.match(/(?:AnymeX|version|app[_\s-]?ver|build)[\s:=v]+([0-9]+\.[0-9]+(?:\.[0-9]+)?(?:[+-_a-zA-Z0-9]+)?)/i);
  if (verMatch) {
    appVersion = verMatch[1].trim();
  }

  // Detect Android version & device/ROM
  const androidMatch = raw.match(/Android[\s:]+([0-9]+(?:\.[0-9]+)?)/i);
  if (androidMatch) {
    platform = 'android';
    osDetails = `Android ${androidMatch[1]}`;
  }

  // Detect MIUI, OneUI, OxygenOS, HarmonyOS, ColorOS
  const romMatch = raw.match(/(MIUI|OneUI|OxygenOS|ColorOS|HarmonyOS|RealmeUI|Flyme)[\s:=v]+([0-9a-zA-Z.]+)/i);
  if (romMatch) {
    osDetails = osDetails ? `${osDetails} (${romMatch[1]} ${romMatch[2]})` : `${romMatch[1]} ${romMatch[2]}`;
  }

  // Detect Windows
  if (/Windows\s+(?:10|11|Server)/i.test(raw) || /win32|win64/i.test(raw)) {
    platform = platform || 'windows';
    const winMatch = raw.match(/Windows\s+(1[01]|Server(?:\s+\d+)?)/i);
    if (winMatch) osDetails = `Windows ${winMatch[1]}`;
  }

  // Detect iOS / iPadOS
  if (/iPhone|iPad|iOS/i.test(raw)) {
    platform = platform || 'ios';
  }

  // Detect common exceptions: e.g. java.lang.NullPointerException, HttpException, etc.
  const excMatch = raw.match(/(?:Exception|Error):\s*([a-zA-Z0-9_.$]+)|\b([a-zA-Z0-9_]+Exception)\b/);
  if (excMatch) {
    exceptionType = excMatch[1] || excMatch[2];
  }

  // Redaction: strip auth tokens, bearer tokens, passwords, cookies
  let cleaned = raw
    .replace(/(Bearer\s+)[a-zA-Z0-9_.-]+/gi, '$1[REDACTED_TOKEN]')
    .replace(/(password|token|secret|api[_-]?key)\s*[:=]\s*["']?[^"'\s]+["']?/gi, '$1: [REDACTED]')
    .replace(/(cookie:\s*)[^\r\n]+/gi, '$1[REDACTED_COOKIE]');

  return {
    appVersion,
    platform,
    osDetails,
    exceptionType,
    cleanedLog: cleaned,
  };
}
