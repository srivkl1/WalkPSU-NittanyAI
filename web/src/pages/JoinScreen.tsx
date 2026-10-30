import { useState, type FormEvent } from 'react'
import { PinIcon } from '../components/icons'
import { auth0Config } from '../lib/auth0'
import { useSession } from '../session/session'

function JoinScreen() {
  const session = useSession()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function runAuth(action: (() => void) | (() => Promise<void>)) {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Authentication failed. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  if (session.status === 'loading') {
    return (
      <div className="center-screen" role="status">
        <span className="spinner" aria-hidden />
        <span className="muted">Loading your session…</span>
      </div>
    )
  }
  if (session.status === 'error') {
    const { signOut } = session
    return (
      <div className="onboard">
        <div className="onboard-hero">
          <h1>Couldn’t finish signing in</h1>
          <p className="error" role="alert">{session.message}</p>
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        <div className="onboard-actions">
          <button className="button primary" onClick={() => window.location.reload()}>Try again</button>
          {signOut && <button className="button plain" disabled={busy} onClick={() => void runAuth(signOut)}>Log out</button>}
        </div>
      </div>
    )
  }
  if (session.status === 'signed-out') {
    return (
      <div className="onboard">
        <Hero subtitle="See what’s on across campus, check in when you get there, and help your club grow." />
        <div className="onboard-actions">
          <button className="button primary" disabled={busy} onClick={() => void runAuth(session.signUp ?? session.signIn)}>
            Create an account
          </button>
          <button className="button" disabled={busy} onClick={() => void runAuth(session.signIn)}>
            Log in
          </button>
          {busy && <p className="muted footnote" role="status">Opening secure sign-in…</p>}
          {error && <p className="error footnote" role="alert">{error}</p>}
          <p className="muted footnote">Secure sign-in with Auth0. Choose your display name after signing in.</p>
        </div>
      </div>
    )
  }
  if (session.status !== 'joining') return null
  const { join } = session

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await join(name.trim())
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <form className="onboard" onSubmit={submit}>
      <Hero
        subtitle={
          auth0Config
            ? 'You’re signed in. Pick a display name and you’ll get your own map color.'
            : 'Guest progress belongs to this browser. Account sign-in arrives when Auth0 is configured.'
        }
      />
      <div className="onboard-actions">
        <label className="field">
          {auth0Config ? 'Choose your name' : 'Your name'}
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            minLength={1}
            maxLength={32}
            autoComplete="nickname"
            autoCapitalize="words"
            enterKeyHint="go"
            placeholder="What should we call you?"
            required
            disabled={busy}
          />
        </label>
        {error && <p className="error footnote" role="alert">{error}</p>}
        <button className="button primary" disabled={busy || !name.trim()}>
          {busy ? 'Joining…' : 'Start playing'}
        </button>
        <button type="button" className="button plain" disabled={busy} onClick={() => void runAuth(session.signOut)}>
          {auth0Config ? 'Log out / use another account' : 'Reset guest session'}
        </button>
      </div>
    </form>
  )
}

function Hero({ subtitle }: { subtitle: string }) {
  return (
    <div className="onboard-hero">
      <span className="app-mark">
        <PinIcon size={44} strokeWidth={2.2} />
      </span>
      <h1>WalkPSU</h1>
      <p className="muted">{subtitle}</p>
    </div>
  )
}

export default JoinScreen
