import { useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'

type LoginState = 'idle' | 'loading' | 'success' | 'error'

type LoginResponse = {
  authenticated: boolean
  token: string
}

type UserSession = {
  username: string
  token: string
}

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

function App() {
  const [loginState, setLoginState] = useState<LoginState>('idle')
  const [message, setMessage] = useState('')
  const [session, setSession] = useState<UserSession | null>(null)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const formData = new FormData(event.currentTarget)
    const login = String(formData.get('email') ?? '')
    const password = String(formData.get('password') ?? '')

    setLoginState('loading')
    setMessage('')

    try {
      const response = await fetch(`${apiUrl}/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ login, password }),
      })

      if (!response.ok) {
        throw new Error('Invalid credentials')
      }

      const data = (await response.json()) as LoginResponse

      setSession({
        username: login,
        token: data.token,
      })
      setLoginState('success')
      setMessage('Signed in')
    } catch {
      setLoginState('error')
      setMessage('Invalid email or password')
    }
  }

  function handleSignOut() {
    setSession(null)
    setLoginState('idle')
    setMessage('')
  }

  if (session) {
    return (
      <main className="page-shell">
        <section className="dashboard-panel" aria-labelledby="dashboard-title">
          <div className="dashboard-header">
            <span className="status-dot" aria-hidden="true" />
            <h1 id="dashboard-title">Dashboard</h1>
          </div>

          <div className="profile-card">
            <span className="avatar" aria-hidden="true">
              {session.username.charAt(0).toUpperCase()}
            </span>
            <div>
              <p className="profile-label">Signed in as</p>
              <p className="profile-name">{session.username}</p>
            </div>
          </div>

          <dl className="session-list">
            <div>
              <dt>Status</dt>
              <dd>Active</dd>
            </div>
            <div>
              <dt>Token</dt>
              <dd>{session.token}</dd>
            </div>
          </dl>

          <button className="secondary-button" type="button" onClick={handleSignOut}>
            Sign out
          </button>
        </section>
      </main>
    )
  }

  return (
    <main className="page-shell">
      <section className="auth-panel" aria-labelledby="login-title">
        <div className="auth-header">
          <h1 id="login-title">Sign in</h1>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
          <label htmlFor="email">
            Email
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              placeholder="name@example.com"
              required
            />
          </label>

          <label htmlFor="password">
            Password
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              placeholder="Enter your password"
              required
            />
          </label>

          <div className="form-row">
            <label className="remember" htmlFor="remember">
              <input id="remember" name="remember" type="checkbox" />
              Remember me
            </label>
          </div>

          {message && (
            <p className={`status-message ${loginState}`} role="status">
              {message}
            </p>
          )}

          <button type="submit" disabled={loginState === 'loading'}>
            {loginState === 'loading' ? 'Signing in...' : 'Continue'}
          </button>
        </form>
      </section>
    </main>
  )
}

export default App
