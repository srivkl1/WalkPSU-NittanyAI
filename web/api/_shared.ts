import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../src/lib/database.types.ts'

// Shared by the functions in web/api. The leading underscore keeps Vercel from serving this file as an endpoint.

// Gemini often answers 503 "high demand", and models get retired, so retry once, then fall back to other models.
const GEMINI_ATTEMPTS = ['gemini-flash-latest', 'gemini-flash-latest', 'gemini-3.8-flash', 'gemini-flash-lite-latest']
/**
 * How long one askGeminiJson call may take, retries included. Vercel stops a function at 60 s (vercel.json) and the
 * player then gets no answer at all, so Gemini must give up well before that and leave time for a fallback (search's
 * keyword matches). GEMINI_TIMEOUT_MS overrides it in tests.
 */
export const GEMINI_BUDGET_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 25_000

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * Gemini couldn't answer: `busy` (overloaded or rate limited, worth retrying soon), `unavailable` (out of credits, bad
 * key or retired models: a person has to fix it), or `garbled` (it answered, but not with the JSON we asked for).
 * Callers with a fallback (event search) catch this; others pass it on as a user-facing error.
 */
export class GeminiError extends HttpError {
  kind: 'busy' | 'unavailable' | 'garbled'
  constructor(kind: GeminiError['kind'], who: string) {
    super(
      kind === 'garbled' ? 502 : 503,
      kind === 'busy'
        ? `${who} is busy right now. Try again in a minute`
        : kind === 'unavailable'
          ? `${who} is unavailable right now. Try again later`
          : `${who} gave no answer. Try again`,
    )
    this.kind = kind
  }
}

export function env(name: string) {
  const value = process.env[name]
  if (!value) throw new HttpError(500, `Server is missing ${name}`)
  return value
}

/** Runs a handler and turns thrown errors into `{ error }` JSON. Only unexpected (500) errors are logged. */
export async function respond(run: () => Promise<unknown>) {
  try {
    return Response.json(await run())
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500
    if (status === 500) console.error(e)
    return Response.json({ error: (e as Error).message }, { status })
  }
}

/** The caller as a player: a Supabase client acting with their JWT (so RLS applies) and their player id. */
export async function signedInPlayer(request: Request, action: string): Promise<{ playerId: string; asPlayer: SupabaseClient<Database> }> {
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '')
  if (!token) throw new HttpError(401, `Sign in to ${action}`)
  const asPlayer = createClient<Database>(env('VITE_SUPABASE_URL'), env('VITE_SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  })
  const { data: playerId, error } = await asPlayer.rpc('current_player_id')
  if (error) throw new HttpError(401, 'Your session expired. Reload and try again')
  if (!playerId) throw new HttpError(403, `Join the game before you ${action}`)
  return { playerId, asPlayer }
}

type Part = { text: string } | { inline_data: { mime_type: string; data: string } }

/**
 * Asks Gemini for JSON matching `schema`. `who` names the feature in user-facing errors ("The photo checker").
 * Gives up after `budgetMs` in total (a slow Gemini counts as busy). Logs only the HTTP status or the timeout on
 * failure, never the request (which can hold a player's photo or search text).
 */
export async function askGeminiJson<T>(parts: Part[], schema: object, who: string, budgetMs = GEMINI_BUDGET_MS): Promise<T> {
  const request = JSON.stringify({
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: schema },
  })
  const key = env('GEMINI_API_KEY')
  const deadline = Date.now() + budgetMs
  const timedOut = (model: string) => {
    console.error(`Gemini error timeout after ${Math.round(budgetMs / 1000)} s (${model})`)
    return new GeminiError('busy', who)
  }

  let response: Response | undefined
  let model = GEMINI_ATTEMPTS[0]
  try {
    for (const [i, next] of GEMINI_ATTEMPTS.entries()) {
      model = next
      // No time left for another try: report the last answer (or the timeout, if there was none).
      if (i > 0 && deadline - Date.now() < 2000) break
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, 1000))
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: request,
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      })
      // A bad request, bad key, or exhausted billing fails the same way on every model. Anything else (busy, retired)
      // is worth another try.
      if (response.ok || [400, 401, 402, 403].includes(response.status)) break
    }
    if (!response) throw timedOut(model)
    if (!response.ok) {
      // Google's error status (e.g. RESOURCE_EXHAUSTED) says why, without echoing the request back.
      const reason = ((await response.json().catch(() => null)) as { error?: { status?: string } } | null)?.error?.status ?? ''
      console.error(`Gemini error ${response.status} ${reason} (${model})`.replace(/\s+/g, ' '))
      // 402 is prepaid credits running out; 429 and 5xx clear up on their own.
      const busy = response.status === 429 || response.status >= 500
      throw new GeminiError(busy ? 'busy' : 'unavailable', who)
    }
  } catch (e) {
    if (e instanceof GeminiError) throw e
    if ((e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError') throw timedOut(model)
    // The network itself failed (DNS, reset): as good as busy.
    console.error(`Gemini error ${(e as Error).message} (${model})`)
    throw new GeminiError('busy', who)
  }

  // The body arrives under the same deadline.
  const result = (await response.json().catch((e: Error) => {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw timedOut(model)
    throw new GeminiError('garbled', who)
  })) as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
  const text = result.candidates?.[0]?.content?.parts?.find((part) => part.text)?.text
  if (!text) throw new GeminiError('garbled', who)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new GeminiError('garbled', who)
  }
}
