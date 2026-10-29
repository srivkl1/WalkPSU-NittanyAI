import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { decideOrganizerRequest, getPendingOrganizerRequests } from '../lib/api'

type Pending = Awaited<ReturnType<typeof getPendingOrganizerRequests>>

/** Admins: players asking to run a club. Approving lets them see that club's dashboard. */
function OrganizerRequests() {
  const [requests, setRequests] = useState<Pending | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const load = useCallback(() => getPendingOrganizerRequests().then(setRequests, (e: Error) => toast.error('Couldn’t load requests', { description: e.message })), [])
  useEffect(() => {
    load()
  }, [load])

  async function decide(id: string, approve: boolean) {
    setBusy(id)
    try {
      const request = await decideOrganizerRequest(id, approve)
      toast(approve ? 'Approved' : 'Declined', { description: request.organization })
      await load()
    } catch (e) {
      toast.error('Couldn’t answer it', { description: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  if (requests === null) return <p className="card muted">Loading…</p>
  if (requests.length === 0) return <p className="card muted">No one is waiting.</p>
  return (
    <ul className="list organizer-requests">
      {requests.map((r) => (
        <li key={r.id} className="list-row organizer-request">
          <span className="list-row-main">
            <strong>{r.organization}</strong>
            <span className="muted footnote">
              {r.display_name}
              {r.note && ` · “${r.note}”`}
            </span>
          </span>
          <span className="organizer-request-actions">
            <button type="button" className="button" disabled={busy === r.id} onClick={() => decide(r.id, false)}>
              Decline
            </button>
            <button type="button" className="button primary" disabled={busy === r.id} onClick={() => decide(r.id, true)}>
              Approve
            </button>
          </span>
        </li>
      ))}
    </ul>
  )
}

export default OrganizerRequests
