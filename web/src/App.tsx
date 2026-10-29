import type { CSSProperties } from 'react'
import { Route, Routes } from 'react-router'
import { Toaster } from 'sonner'
import BottomNav from './components/BottomNav'
import DropAlerts from './components/DropAlerts'
import AdminPage from './pages/AdminPage'
import ClaimPage from './pages/ClaimPage'
import ClubDashboardPage from './pages/ClubDashboardPage'
import ClubsPage from './pages/ClubsPage'
import EventCheckinPage from './pages/EventCheckinPage'
import JoinScreen from './pages/JoinScreen'
import MapPage from './pages/MapPage'
import ProfilePage from './pages/ProfilePage'
import { DiscoveryProvider } from './session/DiscoveryProvider'
import { PresenceProvider } from './session/PresenceProvider'
import { TrailProvider } from './session/TrailProvider'
import { useSession } from './session/session'
import { SessionProvider } from './session/SessionProvider'

// Sonner reads these on the toaster; pointing them at our tokens makes toasts match the app.
const TOAST_THEME = {
  '--normal-bg': 'var(--material-strong)',
  '--normal-border': 'var(--material-edge)',
  '--normal-text': 'var(--text)',
  '--border-radius': '18px',
} as CSSProperties

function Screens() {
  const session = useSession()
  if (session.status !== 'ready') return <JoinScreen />

  return (
    <PresenceProvider>
      <TrailProvider>
        <DiscoveryProvider>
          <div className="app" data-chrome="tabs">
            <main className="app-main">
              <Routes>
                <Route path="/" element={<MapPage />} />
                <Route path="/clubs" element={<ClubsPage />} />
                <Route path="/clubs/:organization" element={<ClubDashboardPage />} />
                <Route path="/profile" element={<ProfilePage />} />
                <Route path="/admin" element={<AdminPage />} />
                <Route path="/claim/:dropId" element={<ClaimPage />} />
                <Route path="/checkin/:eventId" element={<EventCheckinPage />} />
              </Routes>
            </main>
            <BottomNav />
            <DropAlerts />
          </div>
        </DiscoveryProvider>
      </TrailProvider>
    </PresenceProvider>
  )
}

function App() {
  return (
    <SessionProvider>
      <Screens />
      <Toaster
        position="top-center"
        theme="light"
        gap={8}
        mobileOffset={{ top: 'calc(env(safe-area-inset-top, 0px) + 8px)', left: 12, right: 12 }}
        toastOptions={{ className: 'toast' }}
        style={TOAST_THEME}
      />
    </SessionProvider>
  )
}

export default App
