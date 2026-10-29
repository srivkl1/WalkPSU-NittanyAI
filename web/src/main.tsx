import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { Auth0Provider } from '@auth0/auth0-react'
import './index.css'
import './styles/map.css'
import App from './App.tsx'
import { auth0Config } from './lib/auth0.ts'

const app = (
  <BrowserRouter>
    <App />
  </BrowserRouter>
)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {auth0Config ? (
      <Auth0Provider
        domain={auth0Config.domain}
        clientId={auth0Config.clientId}
        authorizationParams={{ redirect_uri: window.location.origin, audience: auth0Config.audience }}
        cacheLocation="localstorage"
        useRefreshTokens
        onRedirectCallback={(appState) => window.location.replace(appState?.returnTo ?? '/')}
      >
        {app}
      </Auth0Provider>
    ) : (
      app
    )}
  </StrictMode>,
)
