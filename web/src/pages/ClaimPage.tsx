import { useCallback } from 'react'
import { useParams, useSearchParams } from 'react-router'
import CheckInResult from '../components/CheckInResult'
import { claimDrop, getDrop } from '../lib/api'

/** Landing page for a drop's QR code: /claim/:dropId?key=<code>. */
function ClaimPage() {
  const { dropId } = useParams()
  const [params] = useSearchParams()
  const key = params.get('key')
  const checkIn = useCallback(async () => {
    const drop = await getDrop(dropId!)
    await claimDrop(dropId!, { code: key! })
    return { title: 'You’re checked in!', note: drop?.title ?? 'Enjoy it.' }
  }, [dropId, key])
  return <CheckInResult checkIn={checkIn} incomplete={!dropId || !key} />
}

export default ClaimPage
