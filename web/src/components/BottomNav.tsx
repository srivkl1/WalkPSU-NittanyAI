import type { CSSProperties } from 'react'
import { NavLink, useLocation } from 'react-router'
import { useMyClubs } from '../lib/hooks'
import { useReadySession } from '../session/session'
import { ChartIcon, MapIcon, PersonIcon } from './icons'

const MAP = { to: '/', label: 'Map', Icon: MapIcon }
const CLUBS = { to: '/clubs', label: 'Clubs', Icon: ChartIcon }
const PROFILE = { to: '/profile', label: 'Profile', Icon: PersonIcon }

function BottomNav() {
  const { pathname } = useLocation()
  const { player, isAdmin } = useReadySession()
  const { data } = useMyClubs(player.id)
  // Clubs is for organizers (and admins); everyone else has just the map and their profile.
  const tabs = isAdmin || data.clubs.length > 0 ? [MAP, CLUBS, PROFILE] : [MAP, PROFILE]
  // A club's dashboard (/clubs/…) still lights the Clubs tab.
  const index = tabs.findIndex((tab) => tab.to === pathname || (tab.to !== '/' && pathname.startsWith(`${tab.to}/`)))
  return (
    <nav className="bottom-nav" style={{ '--tabs': tabs.length } as CSSProperties}>
      {/* A pill slides between tabs; it hides on screens outside the tabs (admin, claim). */}
      <span className="bottom-nav-indicator" style={{ '--tab': Math.max(index, 0) } as CSSProperties} data-hidden={index < 0 || undefined} aria-hidden />
      {tabs.map(({ to, label, Icon }) => (
        <NavLink key={to} to={to} end={to === '/'} className="bottom-nav-tab">
          <Icon size={24} />
          {label}
        </NavLink>
      ))}
    </nav>
  )
}

export default BottomNav
