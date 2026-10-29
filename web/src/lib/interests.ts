// "For you": a player's major and interests matched to Penn State Discover's own keywords (each event's categories,
// theme, and benefits) plus words in its title and club name. Pure functions, so it runs anywhere and is unit-tested
// (tests/unit/interests.test.mjs). Profiles stay on the phone and in the player's private row; nothing is sent to a
// server to match.

export type Interest = {
  id: string
  label: string
  emoji: string
  /** Discover categoryNames that mean this interest. */
  categories: string[]
  /** Discover themes. */
  themes: string[]
  /** Discover benefitNames. */
  benefits: string[]
  /** Words in an event's title or club name. */
  words: RegExp
}

/** Ids are stored in player_profiles.interests; its check constraint lists the same ids. */
export const INTERESTS: Interest[] = [
  {
    id: 'free_food', label: 'Free food', emoji: '🍕', categories: [], themes: [], benefits: ['Free Food'],
    words: /\b(free food|pizza|snacks?|food|dinner|lunch|breakfast|brunch|bagels?|donuts?|cookies?|ice cream|tacos?|bbq|potluck|pancakes?)\b/i,
  },
  { id: 'free_stuff', label: 'Free stuff', emoji: '🎁', categories: [], themes: [], benefits: ['Free Stuff'], words: /\b(giveaways?|swag|free t-?shirts?|raffle)\b/i },
  {
    id: 'career', label: 'Career', emoji: '💼', categories: ['Career Exploration', 'Leadership Development'], themes: [], benefits: [],
    words: /\b(careers?|internships?|resumes?|résumés?|networking|recruit\w*|job fair|employers?|interviews?|professional)\b/i,
  },
  {
    id: 'academic', label: 'Academic', emoji: '📚', categories: ['Academically Focused', 'Workshops and Presentations', 'Lectures & Speaking Engagements', 'Honors'],
    themes: ['ThoughtfulLearning'], benefits: [], words: /\b(study|lecture|research|seminar|tutoring|symposium|workshop)\b/i,
  },
  {
    id: 'tech', label: 'Tech', emoji: '💻', categories: [], themes: [], benefits: [],
    words: /\b(hack\w*|coding|code|programming|software|computer|computing|cyber\w*|robot\w*|ai|artificial intelligence|machine learning|data science|tech|technology|app dev\w*|game dev\w*)\b/i,
  },
  {
    id: 'wellness', label: 'Wellness', emoji: '🧘', categories: ['Health and Wellness'], themes: [], benefits: [],
    words: /\b(yoga|meditation|mindful\w*|wellness|well-being|mental health|self-care|fitness)\b/i,
  },
  {
    id: 'sports', label: 'Sports', emoji: '🏀', categories: ['Athletics and Recreation'], themes: ['Athletics'], benefits: [],
    words: /\b(basketball|soccer|football|volleyball|hockey|tennis|run|running|5k|intramural|pickleball|climbing|swim\w*|ski\w*)\b/i,
  },
  {
    id: 'arts', label: 'Arts & music', emoji: '🎨', categories: ['Arts and Entertainment'], themes: ['Arts'], benefits: [],
    words: /\b(music|concert|band|choir|a cappella|film|movie|theat(er|re)|dance|art|gallery|painting|craft\w*|poetry|comedy|improv)\b/i,
  },
  { id: 'culture', label: 'Culture', emoji: '🌍', categories: ['Cultural Appreciation'], themes: ['Cultural'], benefits: [], words: /\b(cultur\w*|heritage|international|diwali|lunar new year)\b/i },
  {
    id: 'social', label: 'Social', emoji: '🎉', categories: ['Social Activities'], themes: ['Social'], benefits: [],
    words: /\b(social|mixer|party|game night|trivia|karaoke|bingo|hangout|meet and greet)\b/i,
  },
  { id: 'sustainability', label: 'Sustainability', emoji: '🌱', categories: ['Sustainability'], themes: [], benefits: [], words: /\b(sustainab\w*|climate|environment\w*|garden\w*|recycl\w*|green)\b/i },
  {
    id: 'service', label: 'Service', emoji: '🤝', categories: ['Community Service', 'Volunteer Opportunity', 'Civic Engagement', 'Philanthropy and Fundraising'],
    themes: ['CommunityService', 'Fundraising'], benefits: [], words: /\b(volunteer\w*|service|fundrais\w*|charity|thon|donat\w*|voter|vote)\b/i,
  },
  { id: 'faith', label: 'Faith', emoji: '🕊️', categories: ['Religious or Spiritual'], themes: ['Spirituality'], benefits: [], words: /\b(faith|worship|prayer|bible|church|mass|ministry|spiritual\w*)\b/i },
  {
    id: 'clubs', label: 'Join a club', emoji: '🙌', categories: ['Recruiting New Members', 'Regular Meeting'], themes: ['GroupBusiness'], benefits: [],
    words: /\b(general (body )?meeting|gbm|interest meeting|new members?|info session|recruitment)\b/i,
  },
]

const BY_ID = new Map(INTERESTS.map((i) => [i.id, i]))
export const interestById = (id: string) => BY_ID.get(id)

/** Suggestions for the major field (University Park). Any text is allowed. */
export const MAJORS = [
  'Accounting', 'Actuarial Science', 'Advertising', 'Aerospace Engineering', 'Architecture', 'Biochemistry', 'Biology',
  'Biomedical Engineering', 'Business', 'Chemical Engineering', 'Chemistry', 'Civil Engineering', 'Communications',
  'Computer Engineering', 'Computer Science', 'Criminology', 'Cybersecurity', 'Data Sciences', 'Economics', 'Education',
  'Electrical Engineering', 'English', 'Environmental Science', 'Film Production', 'Finance', 'Graphic Design',
  'History', 'Hospitality Management', 'Industrial Engineering', 'Information Sciences and Technology', 'Journalism',
  'Kinesiology', 'Management', 'Marketing', 'Mathematics', 'Mechanical Engineering', 'Meteorology', 'Music',
  'Nursing', 'Nutrition', 'Philosophy', 'Physics', 'Political Science', 'Psychology', 'Public Relations',
  'Recreation, Park, and Tourism Management', 'Sociology', 'Statistics', 'Supply Chain', 'Theatre', 'Undecided',
]

/** Majors that suggest an interest the student didn't pick. These count for less than a picked interest. */
const MAJOR_HINTS: [RegExp, string][] = [
  [/comput|software|cyber|data|informat|electrical|\bist\b/i, 'tech'],
  [/business|financ|account|market|management|supply chain|economic|actuar/i, 'career'],
  [/nurs|kinesiolog|nutrition|health|psycholog/i, 'wellness'],
  [/environment|energy|forest|agri|earth|meteorolog|geograph/i, 'sustainability'],
  [/\bart|music|theat|film|design|architect/i, 'arts'],
]

/** Words too general to match a major on ("Computer Science" should match "computer", not every "science" talk). */
const GENERIC = new Set(['science', 'sciences', 'studies', 'management', 'and', 'the', 'general', 'undecided', 'program', 'major'])

/** Word stems from a major, e.g. "Mechanical Engineering" → ["mechani", "engineer"]; "Nursing" → ["nurs"]. */
export function majorStems(major: string | null | undefined) {
  return (major ?? '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 4 && !GENERIC.has(w))
    .map((w) => w.slice(0, Math.max(4, w.length - 3)))
}

export type Profile = { major: string | null; interests: string[] }
/** The parts of an event matching needs (an EventResult with Discover's keywords). */
export type MatchableEvent = { title: string; organization: string | null; theme: string | null; categories?: string[]; benefits?: string[] }
export type Match = { score: number; reasons: string[] }

const PICKED = 3
const MAJOR = 3
const HINTED = 1

function interestMatches(interest: Interest, e: MatchableEvent, text: string) {
  return (
    interest.categories.some((c) => e.categories?.includes(c)) ||
    (e.theme !== null && interest.themes.includes(e.theme)) ||
    interest.benefits.some((b) => e.benefits?.includes(b)) ||
    interest.words.test(text)
  )
}

/** How well an event fits a profile, and why ("Career", "Mechanical Engineering"). Score 0: not for you. */
export function matchEvent(e: MatchableEvent, profile: Profile): Match {
  const text = `${e.title} ${e.organization ?? ''}`
  const reasons: string[] = []
  let score = 0
  const picked = new Set(profile.interests)
  for (const id of picked) {
    const interest = BY_ID.get(id)
    if (interest && interestMatches(interest, e, text)) {
      score += PICKED
      reasons.push(interest.label)
    }
  }
  const stems = majorStems(profile.major)
  if (stems.length && stems.some((s) => new RegExp(`\\b${s}`, 'i').test(text))) {
    score += MAJOR
    reasons.push(profile.major!.trim())
  }
  for (const [pattern, id] of MAJOR_HINTS) {
    const interest = BY_ID.get(id)
    if (!interest || picked.has(id) || !pattern.test(profile.major ?? '')) continue
    if (interestMatches(interest, e, text)) {
      score += HINTED
      reasons.push(interest.label)
    }
  }
  return { score, reasons: [...new Set(reasons)] }
}

/** Events that fit, best first (ties: soonest, the input order). */
export function forYou<T extends MatchableEvent>(events: T[], profile: Profile, limit = 5): (T & { match: Match })[] {
  return events
    .map((e, i) => ({ e, i, match: matchEvent(e, profile) }))
    .filter((x) => x.match.score > 0)
    .sort((a, b) => b.match.score - a.match.score || a.i - b.i)
    .slice(0, limit)
    .map(({ e, match }) => ({ ...e, match }))
}

export const hasProfile = (p: Profile | null) => !!p && (p.interests.length > 0 || !!p.major?.trim())
