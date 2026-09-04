/**
 * User Presence & Activity Status Helper.
 * Computes online, away, or offline status based on activity telemetry.
 */

export type PresenceStatus = 'online' | 'away' | 'offline';

export interface PresenceInfo {
  status: PresenceStatus;
  label: string;
  relativeText: string;
}

export function formatPresenceRelative(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.floor(seconds))}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
  return `${Math.floor(seconds / 604800)}w`;
}

export function getPresence(
  lastSeen?: number | null,
  lastLogin?: number | null,
  nowSeconds = Math.floor(Date.now() / 1000)
): PresenceInfo {
  const timestamp = lastSeen || lastLogin;
  if (!timestamp) {
    return { status: 'offline', label: 'Offline', relativeText: 'Never seen' };
  }

  const diff = Math.max(0, nowSeconds - timestamp);

  // Online: active within last 5 minutes (300s)
  if (diff < 5 * 60) {
    return {
      status: 'online',
      label: 'Online',
      relativeText: 'Active now',
    };
  }

  // Away / Idle: active within last 20 minutes (1200s)
  if (diff < 20 * 60) {
    const mins = Math.max(1, Math.floor(diff / 60));
    return {
      status: 'away',
      label: 'Away',
      relativeText: `Active ${mins}m ago`,
    };
  }

  // Offline: 20+ minutes inactive
  return {
    status: 'offline',
    label: 'Offline',
    relativeText: `Last seen ${formatPresenceRelative(diff)} ago`,
  };
}
