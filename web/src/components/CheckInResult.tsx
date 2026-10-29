import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { CheckIcon, CrossIcon } from './icons'

type Result = { status: 'checking' } | { status: 'done'; title: string; note: string } | { status: 'failed'; message: string }

/**
 * The screen behind a QR code: runs `checkIn` once and shows how it went. `checkIn` resolves to what to say on success
 * ({ title, note }); a thrown error's message is shown as the reason it failed.
 */
function CheckInResult({ checkIn, incomplete }: { checkIn: () => Promise<{ title: string; note: string }>; incomplete: boolean }) {
  const [result, setResult] = useState<Result>(incomplete ? { status: 'failed', message: 'This QR link is incomplete.' } : { status: 'checking' })
  const attempted = useRef(false)

  useEffect(() => {
    // StrictMode runs effects twice; a second check-in would fail and overwrite the success.
    if (incomplete || attempted.current) return
    attempted.current = true
    checkIn().then(
      (done) => setResult({ status: 'done', ...done }),
      (e: Error) => setResult({ status: 'failed', message: e.message }),
    )
  }, [checkIn, incomplete])

  return (
    <section className="center-screen">
      {result.status === 'checking' && (
        <>
          <span className="result-badge">
            <span className="spinner" aria-hidden />
          </span>
          <h1>Checking in…</h1>
        </>
      )}
      {result.status === 'done' && (
        <>
          <span className="result-badge" data-tone="success">
            <CheckIcon size={44} />
          </span>
          <h1>{result.title}</h1>
          <p className="muted">{result.note}</p>
        </>
      )}
      {result.status === 'failed' && (
        <>
          <span className="result-badge" data-tone="error">
            <CrossIcon size={40} />
          </span>
          <h1>Couldn’t check in</h1>
          <p className="muted">{result.message}</p>
        </>
      )}
      <Link className="button primary" to="/">
        Back to map
      </Link>
    </section>
  )
}

export default CheckInResult
