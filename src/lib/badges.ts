/**
 * Contributor achievement badges calculation logic.
 */

export interface Badge {
  id: string;
  name: string;
  iconType: 'bug' | 'idea' | 'puzzle' | 'flame' | 'shield';
  description: string;
  color: string;
}

export const ALL_BADGES: Record<string, Badge> = {
  bug_hunter: {
    id: 'bug_hunter',
    name: 'Bug Hunter',
    iconType: 'bug',
    description: 'Reported 5 or more confirmed or fixed bugs in AnymeX.',
    color: '#ed4245',
  },
  visionary: {
    id: 'visionary',
    name: 'Visionary',
    iconType: 'idea',
    description: 'Submitted a popular suggestion with 20 or more votes.',
    color: '#f5c542',
  },
  extension_pioneer: {
    id: 'extension_pioneer',
    name: 'Extension Pioneer',
    iconType: 'puzzle',
    description: 'Reported an extension compatibility issue that was fixed.',
    color: '#5865f2',
  },
  active_supporter: {
    id: 'active_supporter',
    name: 'Active Supporter',
    iconType: 'flame',
    description: 'Voted on 10 or more reports on AnymeX Desk.',
    color: '#e67e22',
  },
  staff: {
    id: 'staff',
    name: 'Staff Contributor',
    iconType: 'shield',
    description: 'Verified staff member helping moderate and triage reports.',
    color: '#57f287',
  },
};

export interface UserStats {
  reportsCount: number;
  fixedCount: number;
  totalVotesReceived: number;
  votesGivenCount: number;
  hasExtensionFix: boolean;
  hasTopSuggestion: boolean;
  isStaff: boolean;
}

export function computeBadges(stats: UserStats): Badge[] {
  const earned: Badge[] = [];

  if (stats.isStaff) {
    earned.push(ALL_BADGES.staff);
  }

  if (stats.fixedCount >= 3 || stats.reportsCount >= 5) {
    earned.push(ALL_BADGES.bug_hunter);
  }

  if (stats.hasTopSuggestion || stats.totalVotesReceived >= 20) {
    earned.push(ALL_BADGES.visionary);
  }

  if (stats.hasExtensionFix) {
    earned.push(ALL_BADGES.extension_pioneer);
  }

  if (stats.votesGivenCount >= 10) {
    earned.push(ALL_BADGES.active_supporter);
  }

  return earned;
}
