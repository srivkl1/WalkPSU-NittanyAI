// A slow Gemini must never run a function into Vercel's 60 s limit (the player then gets no answer at all). With the
// time budget shortened to 1.5 s: a hanging Gemini fails as "busy" within the budget, retries stop when time runs out,
// a body that never finishes counts too, and search answers with keyword matches instead.
import { startMockSupabase } from '../mock/supabase.mjs'

// Its own port, so it runs alongside a mock started with npm run mock.
const PORT = 54329
const MOCK = `http://localhost:${PORT}`
const BUDGET_MS = 1500
Object.assign(process.env, { VITE_SUPABASE_URL: MOCK, VITE_SUPABASE_ANON_KEY: 'mock', GEMINI_API_KEY: 'test-gemini-key', GEMINI_TIMEOUT_MS: String(BUDGET_MS) })

let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ' :: ' + JSON.stringify(detail)?.slice(0, 400)}`)
  if (!ok) failures++
}

// Gemini stand-in. 'hang': never answers until the request is aborted. 'slow-body': headers at once, a body that never ends.
const realFetch = globalThis.fetch
let mode = 'hang'
let calls = 0
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input)
  if (!url.startsWith('https://generativelanguage.googleapis.com/')) return realFetch(input, init)
  calls++
  const signal = init.signal
  if (mode === '503') return new Response('{"error":{"status":"UNAVAILABLE"}}', { status: 503 })
  if (mode === 'slow-body') {
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
async function timed(run) {
  const start = Date.now()
  try {
    return { value: await run(), ms: Date.now() - start }
  } catch (error) {
    return { error, ms: Date.now() - start }
  }
}

let r = await timed(() => askGeminiJson([{ text: 'hi' }], {}, 'The event finder'))
check('a hanging Gemini fails as busy', r.error instanceof GeminiError && r.error.kind === 'busy', r)
check('within the budget', r.ms >= BUDGET_MS - 50 && r.ms < BUDGET_MS + 500, r.ms)
check('and logs the timeout (no request text)', logged.some((l) => /^Gemini error timeout after 2 s \(gemini-flash-latest\)$/.test(l)), logged)
check('no retry after the time is used up', calls === 1, calls)

mode = 'slow-body'
calls = 0
r = await timed(() => askGeminiJson([{ text: 'hi' }], {}, 'The event finder'))
check('a body that never finishes also fails as busy within the budget', r.error?.kind === 'busy' && r.ms < BUDGET_MS + 500, r)

mode = '503'
calls = 0
r = await timed(() => askGeminiJson([{ text: 'hi' }], {}, 'The event finder'))
check('busy answers stop retrying once too little time is left', r.error?.kind === 'busy' && calls === 1 && r.ms < BUDGET_MS, { calls, ms: r.ms })
check('the log names the status and model', logged.some((l) => l === 'Gemini error 503 UNAVAILABLE (gemini-flash-latest)'), logged)

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
  mode = 'hang'
  const { POST } = await import('../../api/search-events.ts')
  r = await timed(async () => {
    const res = await POST(new Request('http://localhost/api/search-events', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ query: 'book club' }) }))
    return { status: res.status, body: await res.json() }
  })
  check('search falls back to keyword matches when Gemini hangs', r.value?.status === 200 && r.value.body.mode === 'keyword', r.value)
  check('well inside Vercel’s limit', r.ms < BUDGET_MS + 2000, r.ms)
} finally {
  mock.close()
  console.error = original
  clearInterval(keepAlive)
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll Gemini timeout checks passed')
process.exit(failures ? 1 : 0)
