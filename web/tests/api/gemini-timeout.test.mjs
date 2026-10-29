// A slow Gemini must never run a function into Vercel's 60 s limit (the player then gets no answer at all). With the
// budget shortened to 3 s and each attempt to 1 s: a model that hangs (or sends a body that never ends) gives way to
// the next model, a busy or retired one does too, a bad key stops at once, everything ends inside the budget, and
// search answers with keyword matches when no model does.
import { startMockSupabase } from '../mock/supabase.mjs'

// Its own port, so it runs alongside a mock started with npm run mock.
const PORT = 54329
const MOCK = `http://localhost:${PORT}`
const BUDGET_MS = 3000
const ATTEMPT_MS = 1000
Object.assign(process.env, {
  VITE_SUPABASE_URL: MOCK,
  VITE_SUPABASE_ANON_KEY: 'mock',
  GEMINI_API_KEY: 'test-gemini-key',
  GEMINI_TIMEOUT_MS: String(BUDGET_MS),
  GEMINI_ATTEMPT_MS: String(ATTEMPT_MS),
})

let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ' :: ' + JSON.stringify(detail)?.slice(0, 400)}`)
  if (!ok) failures++
}

// Gemini stand-in. `plan` says how each call in turn behaves: 'hang' (no answer until aborted), 'slow-body' (headers
// at once, a body that never ends), an HTTP status, or 'ok' (a JSON answer). Records which model each call asked.
const realFetch = globalThis.fetch
let plan = []
let models = []
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input)
  if (!url.startsWith('https://generativelanguage.googleapis.com/')) return realFetch(input, init)
  models.push(url.match(/models\/([^:]+):/)[1])
  const step = plan[models.length - 1] ?? plan.at(-1)
  const signal = init.signal
  if (step === 'ok') return Response.json({ candidates: [{ content: { parts: [{ text: '{"answer":"ok"}' }] } }] })
  if (typeof step === 'number') return Response.json({ error: { status: step === 401 ? 'UNAUTHENTICATED' : step === 404 ? 'NOT_FOUND' : 'UNAVAILABLE' } }, { status: step })
  if (step === 'slow-body') {
    const body = new ReadableStream({ start(c) { signal.addEventListener('abort', () => c.error(signal.reason)) } })
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
}

const logged = []
const original = console.error.bind(console)
console.error = (...args) => logged.push(args.map(String).join(' '))

// AbortSignal.timeout's timer doesn't keep Node running, and a hung fetch is all that's pending here (on Vercel, the
// server keeps the process alive), so hold it open for the test.
const keepAlive = setInterval(() => {}, 1000)
const { GeminiError, askGeminiJson } = await import('../../api/_shared.ts')
async function ask(steps) {
  plan = steps
  models = []
  logged.length = 0
  const start = Date.now()
  try {
    return { value: await askGeminiJson([{ text: 'hi' }], {}, 'The event finder'), ms: Date.now() - start, models: [...models] }
  } catch (error) {
    return { error, ms: Date.now() - start, models: [...models] }
  }
}

let r = await ask(['hang', 'ok'])
check('a model that hangs gives way to the next, which answers', r.value?.answer === 'ok' && r.ms >= ATTEMPT_MS - 50 && r.ms < ATTEMPT_MS + 500, r)
check('lite first, then the full model', JSON.stringify(r.models) === '["gemini-flash-lite-latest","gemini-flash-latest"]', r.models)
check('the timeout is logged with its model (no request text)', JSON.stringify(logged) === '["Gemini error timeout after 1 s (gemini-flash-lite-latest)"]', logged)

r = await ask(['slow-body', 'ok'])
check('so does a body that never finishes', r.value?.answer === 'ok' && r.ms < ATTEMPT_MS + 500, r)

r = await ask([503, 404, 'ok'])
check('busy and retired models move on to the next', r.value?.answer === 'ok' && r.models.length === 3, r)
check('each failure logged with its status and model', JSON.stringify(logged) === '["Gemini error 503 UNAVAILABLE (gemini-flash-lite-latest)","Gemini error 404 NOT_FOUND (gemini-flash-latest)"]', logged)

r = await ask(['hang'])
check('when every model hangs, it fails as busy', r.error instanceof GeminiError && r.error.kind === 'busy', r)
check('after trying every model, inside the budget', r.ms < BUDGET_MS + 300 && r.models.length === 3, { ms: r.ms, models: r.models })

r = await ask([503])
check('when every model is busy, it fails as busy, quickly', r.error?.kind === 'busy' && r.models.length === 3 && r.ms < 500, { ms: r.ms, models: r.models })

r = await ask([401])
check('a bad key stops at once (every model would refuse it)', r.error?.kind === 'unavailable' && r.models.length === 1, { models: r.models })

// End to end: search answers with keyword matches instead of timing out.
const mock = await startMockSupabase({ port: PORT })
try {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const token = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'ana', role: 'authenticated' })}.mock`
  await realFetch(`${MOCK}/rest/v1/players`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: 'mock', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ display_name: 'Ana' }),
  })
  plan = ['hang']
  models = []
  const { POST } = await import('../../api/search-events.ts')
  const start = Date.now()
  const res = await POST(new Request('http://localhost/api/search-events', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ query: 'book club' }) }))
  const body = await res.json()
  const ms = Date.now() - start
  check('search falls back to keyword matches when Gemini hangs', res.status === 200 && body.mode === 'keyword', body)
  check('well inside Vercel’s limit', ms < BUDGET_MS + 2000, ms)
} finally {
  mock.close()
  console.error = original
  clearInterval(keepAlive)
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll Gemini timeout checks passed')
process.exit(failures ? 1 : 0)
