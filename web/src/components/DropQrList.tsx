import { QRCodeSVG } from 'qrcode.react'
import { useState } from 'react'
import { claimUrl } from '../lib/api'
import { DROP_TYPES } from '../lib/campus'
import type { DropRow } from '../lib/database.types'
import { useClaimCodes } from '../lib/hooks'
import { ChevronIcon, QrIcon } from './icons'

/** Active drops with a scannable QR code each, for checking in where GPS is unreliable (indoors). */
function DropQrList({ drops, buildingName }: { drops: DropRow[]; buildingName: (num: string) => string | undefined }) {
  const { data: codes, error, refresh } = useClaimCodes()
  const [openId, setOpenId] = useState<string | null>(null)

  if (drops.length === 0) return <p className="card muted">No active drops.</p>

  const place = (drop: DropRow) => {
    const name = drop.building_num && (buildingName(drop.building_num) ?? drop.building_num)
    return name && name !== drop.title ? ` · ${name}` : ''
  }

  return (
    <>
      {error && <p className="error">{error}</p>}
      <ul className="list qr-list">
        {drops.map((drop) => {
          const code = codes.get(drop.id)
          const open = openId === drop.id
          return (
            <li key={drop.id} className="qr-row">
              <button
                type="button"
                className="list-row qr-toggle"
                onClick={() => {
                  if (!open && !code) refresh()
                  setOpenId(open ? null : drop.id)
                }}
                aria-expanded={open}
              >
                <QrIcon className="muted" size={22} />
                <span className="list-row-main">
                  <strong className="truncate">{drop.title}</strong>
                  <span className="muted footnote">
                    {DROP_TYPES[drop.type].label}
                    {place(drop)}
                  </span>
                </span>
                <span className="visually-hidden">{open ? 'Hide QR' : 'Show QR'}</span>
                <ChevronIcon className="chevron" />
              </button>
              {open &&
                (code ? (
                  <div className="qr-code">
                    <QRCodeSVG value={claimUrl(drop.id, code)} size={240} marginSize={2} />
                    <span className="muted">Scan with your phone camera to check in</span>
                  </div>
                ) : (
                  <p className="list-row muted">Loading code…</p>
                ))}
            </li>
          )
        })}
      </ul>
    </>
  )
}

export default DropQrList
