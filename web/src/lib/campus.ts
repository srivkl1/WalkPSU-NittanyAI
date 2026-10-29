// Old Main, Penn State University Park
export const CAMPUS_CENTER: [number, number] = [40.7982, -77.8599]

/** Highlight for buildings hosting an active drop. */
export const DROP_ACCENT = '#f97316'

/** Campus event types (Penn State Discover's `theme`): a readable name, the map pin's color, and the map key's hint. */
export const EVENT_THEMES: Record<string, { label: string; color: string; hint: string }> = {
  Social: { label: 'Social', color: '#f59e0b', hint: 'Club socials and hangouts' },
  ThoughtfulLearning: { label: 'Learning', color: '#2563eb', hint: 'Talks, workshops, study sessions' },
  Arts: { label: 'Arts', color: '#e11d48', hint: 'Shows, exhibits, performances' },
  Cultural: { label: 'Cultural', color: '#9333ea', hint: 'Culture and heritage celebrations' },
  Spirituality: { label: 'Spirituality', color: '#0d9488', hint: 'Faith and reflection' },
  GroupBusiness: { label: 'Club business', color: '#64748b', hint: 'Club meetings and elections' },
  CommunityService: { label: 'Community service', color: '#16a34a', hint: 'Volunteering' },
  Fundraising: { label: 'Fundraiser', color: '#ea580c', hint: 'Bake sales and benefits' },
  Athletics: { label: 'Athletics', color: '#dc2626', hint: 'Games and sports' },
}
/** Any other or missing theme: Penn State navy. */
export const EVENT_PIN = '#1e407c'
export const eventTheme = (theme: string | null) => (theme && EVENT_THEMES[theme]) || { label: theme ?? 'Campus event', color: EVENT_PIN, hint: '' }

export const DROP_TYPES = {
  minigame: { label: 'Mini-game', color: '#7c3aed' },
  photo_hunt: { label: 'Photo hunt', color: '#db2777' },
  checkin: { label: 'Check-in', color: '#0891b2' },
  meetup: { label: 'Meetup', color: '#65a30d' },
} as const

/** Extra search terms for buildings whose official PASDA names don't match what students call them. */
export const BUILDING_NICKNAMES: Record<string, string> = {
  '0005000': 'HUB-Robeson Center',
  '0045000': 'Bryce Jordan Center BJC',
  '0039000': 'IST Building',
}
