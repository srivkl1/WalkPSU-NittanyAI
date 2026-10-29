import { useCallback } from 'react'
import { useParams, useSearchParams } from 'react-router'
import CheckInResult from '../components/CheckInResult'
import { checkInEvent } from '../lib/api'

/** Landing page for an event's door QR code (on its club's dashboard): /checkin/:eventId?key=<code>. */
function EventCheckinPage() {
  const { eventId } = useParams()
  const [params] = useSearchParams()
  const key = params.get('key')
  const checkIn = useCallback(async () => {
    const first = await checkInEvent(eventId!, { code: key! })
    return first ? { title: 'You’re checked in!', note: 'Thanks for coming. The club can see how many people came, never who.' } : { title: 'Already checked in', note: 'You’re all set for this event.' }
  }, [eventId, key])
  return <CheckInResult checkIn={checkIn} incomplete={!eventId || !key} />
}

export default EventCheckinPage
