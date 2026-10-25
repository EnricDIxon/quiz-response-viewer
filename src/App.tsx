import { useEffect, useMemo, useState } from 'react'
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams,
} from 'react-router-dom'
import Papa from 'papaparse'
import readXlsxFile from 'read-excel-file/browser'
import './App.css'

type Role = 'admin' | 'user'

type User = {
  id: string
  name: string
  email: string
  role: Role
  hasPassword?: boolean
}

type QuestionResult = {
  questionNumber: number
  questionText: string
  options: string[]
  correctAnswers: string[]
  selectedAnswer: string
  pointsEarned: number | null
  feedback: string
  isCorrect: boolean | null
}

type Attempt = {
  id: string
  importId: string
  quizId: string
  quizName: string
  userId: string
  email: string
  submittedAt: string
  totalScore: number | null
  maxScore: number | null
  percentage: number | null
  questions: QuestionResult[]
  sourceRow?: number
}

type ImportHistory = {
  id: string
  fileName: string
  quizName: string
  importedAt: string
  processed: number
  skipped: number
  errors: number
}

type ImportPreview = {
  id: string
  fileName: string
  quizName: string
  headers: string[]
  attempts: Attempt[]
  rows: Record<string, string>[]
  validRows: number
  anonymousRows: number
  unmatchedRows: number
  malformedRows: number
  errors: string[]
}

type AdminOverview = {
  counts: { users: number; quizzes: number; attempts: number }
  imports: ImportHistory[]
}

const MAX_FILE_SIZE = 10 * 1024 * 1024
const MAX_IMPORT_ROWS = 500

class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' })
  const result = (await response.json().catch(() => ({}))) as { error?: string } & T
  if (!response.ok) throw new ApiError(result.error ?? `Request failed (${response.status}).`, response.status)
  return result
}

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_/\\-]+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return null
  const parsed = Number(trimmed.replace(/,/g, ''))
  return Number.isFinite(parsed) ? parsed : null
}

function parseSpreadsheetDate(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(
      value.getUTCFullYear(),
      value.getUTCMonth(),
      value.getUTCDate(),
      value.getUTCHours(),
      value.getUTCMinutes(),
      value.getUTCSeconds(),
    ).toISOString()
  }
  const text = String(value ?? '').trim()
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text)
  if (match) {
    const [, month, day, yearText, hour, minute, second = '0'] = match
    const year = Number(yearText) < 100 ? 2000 + Number(yearText) : Number(yearText)
    const date = new Date(year, Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString()
}

function findEmailColumn(headers: string[]): number {
  return headers.findIndex((header) =>
    ['email', 'email address', 'participant email', 'user email'].includes(normalizeHeader(header)),
  )
}

async function readWorkbook(file: File): Promise<{ headers: string[]; rows: unknown[][]; hash: string }> {
  const extension = file.name.toLowerCase().split('.').pop()
  if (!['csv', 'xlsx'].includes(extension ?? '')) throw new Error('Choose a CSV or XLSX file.')
  if (file.size === 0 || file.size > MAX_FILE_SIZE) {
    throw new Error('The file must be non-empty and no larger than 10 MB.')
  }
  const buffer = await file.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  let matrix: unknown[][]
  if (extension === 'csv') {
    const parsed = Papa.parse<unknown[]>(new TextDecoder().decode(buffer), {
      skipEmptyLines: 'greedy',
      dynamicTyping: false,
    })
    if (parsed.errors.length) throw new Error(`Could not parse CSV: ${parsed.errors[0].message}`)
    matrix = parsed.data
  } else {
    const sheets = await readXlsxFile(buffer)
    if (!sheets.length) throw new Error('The workbook does not contain a worksheet.')
    matrix = sheets[0].data.map((row) => [...row])
  }
  if (matrix.length === 0) throw new Error('The file is empty.')
  if (matrix.length - 1 > MAX_IMPORT_ROWS) {
    throw new Error(`The file exceeds the ${MAX_IMPORT_ROWS} response row limit.`)
  }
  const headers = matrix[0].map((cell) => String(cell ?? '').trim())
  if (!headers.some(Boolean)) throw new Error('The first row must contain column headings.')
  return { headers, rows: matrix.slice(1), hash }
}

async function previewResponseFile(file: File, quizName: string, maxScore: number, users: User[]): Promise<ImportPreview> {
  const { headers, rows, hash } = await readWorkbook(file)
  const emailColumn = findEmailColumn(headers)
  if (emailColumn < 0) throw new Error('A required Email column was not found.')
  const normalizedHeaders = headers.map(normalizeHeader)
  const questionColumns = headers.flatMap((header, index) => {
    const normalized = normalizedHeaders[index]
    if (!normalized || normalized.startsWith('points ') || normalized.startsWith('feedback ')) return []
    if (
      ['id', 'start time', 'completion time', 'email', 'name', 'total points', 'quiz feedback', 'last modified time'].includes(
        normalized,
      )
    ) return []
    return [{
      header,
      answerColumn: index,
      pointsColumn: normalizedHeaders.findIndex((candidate) => candidate === `points ${normalized}`),
      feedbackColumn: normalizedHeaders.findIndex((candidate) => candidate === `feedback ${normalized}`),
    }]
  })
  if (!questionColumns.length) throw new Error('No question columns were found in the workbook.')

  const usersByEmail = new Map(users.map((user) => [normalizeEmail(user.email), user]))
  const accepted: { user: User; row: unknown[]; sourceRow: number }[] = []
  const inferenceRows: unknown[][] = []
  const errors: string[] = []
  let anonymousRows = 0
  let unmatchedRows = 0
  let malformedRows = 0
  rows.forEach((row, index) => {
    if (!row.some((cell) => String(cell ?? '').trim())) return
    const email = normalizeEmail(String(row[emailColumn] ?? ''))
    if (!email || email === 'anonymous') {
      anonymousRows += 1
      inferenceRows.push(row)
      return
    }
    if (!isValidEmail(email)) {
      malformedRows += 1
      errors.push(`Row ${index + 2}: missing or invalid email; response was not imported.`)
      return
    }
    const user = usersByEmail.get(email)
    if (!user) {
      unmatchedRows += 1
      errors.push(`Row ${index + 2}: ${email} is not in the approved user list.`)
      return
    }
    accepted.push({ user, row, sourceRow: index + 2 })
    inferenceRows.push(row)
  })

  const options = questionColumns.map(({ answerColumn }) => [
    ...new Set(inferenceRows.map((row) => String(row[answerColumn] ?? '').trim()).filter(Boolean)),
  ])
  const correctAnswers = questionColumns.map(({ answerColumn, pointsColumn }) => {
    if (pointsColumn < 0) return []
    return [...new Set(
      inferenceRows
        .filter((row) => (parseNumber(row[pointsColumn]) ?? 0) > 0)
        .map((row) => String(row[answerColumn] ?? '').trim())
        .filter(Boolean),
    )]
  })
  const totalPointsColumn = normalizedHeaders.indexOf('total points')
  const submittedColumn = normalizedHeaders.findIndex((header) =>
    ['completion time', 'submitted at', 'submission time'].includes(header),
  )
  const attempts: Attempt[] = accepted.map(({ user, row, sourceRow }) => {
    const totalScore = totalPointsColumn < 0 ? null : parseNumber(row[totalPointsColumn])
    return {
      id: '',
      importId: hash,
      quizId: '',
      quizName: quizName.trim(),
      userId: user.id,
      email: user.email,
      sourceRow,
      submittedAt: parseSpreadsheetDate(submittedColumn < 0 ? '' : row[submittedColumn]),
      totalScore,
      maxScore,
      percentage: totalScore === null ? null : (totalScore / maxScore) * 100,
      questions: questionColumns.map(({ header, answerColumn, pointsColumn, feedbackColumn }, index) => {
        const selectedAnswer = String(row[answerColumn] ?? '').trim()
        const pointsEarned = pointsColumn < 0 ? null : parseNumber(row[pointsColumn])
        return {
          questionNumber: index + 1,
          questionText: header,
          options: options[index],
          correctAnswers: correctAnswers[index],
          selectedAnswer,
          pointsEarned,
          feedback: feedbackColumn < 0 ? '' : String(row[feedbackColumn] ?? '').trim(),
          isCorrect: pointsEarned === null ? null : pointsEarned > 0,
        }
      }),
    }
  })
  const previewRows = accepted.slice(0, 8).map(({ row }) =>
    Object.fromEntries(headers.map((header, index) => [header, String(row[index] ?? '')])),
  )
  return {
    id: hash,
    fileName: file.name,
    quizName: quizName.trim(),
    headers,
    attempts,
    rows: previewRows,
    validRows: accepted.length,
    anonymousRows,
    unmatchedRows,
    malformedRows,
    errors: errors.length
      ? errors.slice(0, 8)
      : ['No malformed or unregistered rows found. Anonymous rows are excluded separately.'],
  }
}

async function previewEmailList(file: File): Promise<{ emails: string[]; errors: string[] }> {
  const { headers, rows } = await readWorkbook(file)
  const emailColumn = findEmailColumn(headers)
  if (emailColumn < 0) throw new Error('The email list must include an Email column.')
  const emails = new Set<string>()
  const errors: string[] = []
  rows.forEach((row, index) => {
    const email = normalizeEmail(String(row[emailColumn] ?? ''))
    if (!email || email === 'anonymous') return
    if (!isValidEmail(email)) {
      errors.push(`Row ${index + 2}: invalid email was ignored.`)
      return
    }
    emails.add(email)
  })
  return { emails: [...emails], errors: errors.slice(0, 8) }
}

function displayDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value || 'Date unavailable' : date.toLocaleString()
}

function formatScore(attempt: Pick<Attempt, 'totalScore' | 'maxScore'>): string {
  if (attempt.totalScore === null) return 'Score unavailable'
  return attempt.maxScore === null
    ? `${attempt.totalScore} points`
    : `${attempt.totalScore} / ${attempt.maxScore} points`
}

function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [setupRequired, setSetupRequired] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    api<{ user: User | null; setupRequired: boolean }>('/api/session')
      .then((result) => {
        if (!active) return
        setCurrentUser(result.user)
        setSetupRequired(result.setupRequired)
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Could not reach the application server.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [])

  const login = async (email: string, password: string) => {
    const result = await api<{ user: User }>('/api/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    setCurrentUser(result.user)
    setError(null)
    return result.user
  }

  const register = async (name: string, email: string, password: string) => {
    const result = await api<{ user: User }>('/api/register', {
      method: 'POST',
      body: JSON.stringify({ name, email, password }),
    })
    setCurrentUser(result.user)
    setError(null)
    return result.user
  }

  const logout = async () => {
    try {
      await api('/api/logout', { method: 'POST', body: '{}' })
    } finally {
      setCurrentUser(null)
    }
  }

  const finishSetup = async (secret: string, name: string, email: string, password: string) => {
    await api('/api/setup', {
      method: 'POST',
      body: JSON.stringify({ secret, name, email, password }),
    })
    setSetupRequired(false)
    const result = await api<{ user: User }>('/api/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    setCurrentUser(result.user)
  }

  if (loading) return <div className="auth-shell"><div className="empty-state">Connecting to the shared database…</div></div>
  if (error && !currentUser && !setupRequired) {
    return <div className="auth-shell"><div className="auth-card"><p className="error-banner" role="alert">{error}</p><p>Start the Cloudflare Worker and confirm that the D1 database is configured.</p></div></div>
  }
  if (setupRequired && !currentUser) {
    return <InitialSetupPage onSetup={finishSetup} />
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/login"
          element={currentUser ? <Navigate to={currentUser.role === 'admin' ? '/admin' : '/dashboard'} replace /> : <LoginPage onLogin={login} />}
        />
        <Route
          path="/register"
          element={currentUser ? <Navigate to={currentUser.role === 'admin' ? '/admin' : '/dashboard'} replace /> : <RegisterPage onRegister={register} />}
        />
        <Route
          path="/dashboard"
          element={currentUser ? <ProtectedLayout currentUser={currentUser} onLogout={() => void logout()}><DashboardPage currentUser={currentUser} /></ProtectedLayout> : <Navigate to="/login" replace />}
        />
        <Route
          path="/attempt/:attemptId"
          element={currentUser ? <ProtectedLayout currentUser={currentUser} onLogout={() => void logout()}><AttemptDetailPage currentUser={currentUser} /></ProtectedLayout> : <Navigate to="/login" replace />}
        />
        <Route
          path="/admin"
          element={currentUser?.role === 'admin' ? <ProtectedLayout currentUser={currentUser} onLogout={() => void logout()}><AdminPage /></ProtectedLayout> : <Navigate to={currentUser ? '/dashboard' : '/login'} replace />}
        />
        <Route path="*" element={<Navigate to={currentUser ? (currentUser.role === 'admin' ? '/admin' : '/dashboard') : '/login'} replace />} />
      </Routes>
    </BrowserRouter>
  )
}

function InitialSetupPage({ onSetup }: { onSetup: (secret: string, name: string, email: string, password: string) => Promise<void> }) {
  const [secret, setSecret] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await onSetup(secret, name, email, password)
    } catch (setupError) {
      setError(setupError instanceof Error ? setupError.message : 'Could not set up the administrator.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="auth-shell">
      <div className="auth-card">
        <p className="eyebrow">One-time setup</p>
        <h1>Create administrator</h1>
        <p>The first admin account is stored in the shared database. Use the bootstrap secret configured for this Worker.</p>
        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          <label>Bootstrap secret<input type="password" required value={secret} onChange={(event) => setSecret(event.target.value)} /></label>
          <label>Name<input required value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>Email<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label>Password (12+ characters)<input type="password" minLength={12} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          {error ? <p className="error-banner" role="alert">{error}</p> : null}
          <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Setting up…' : 'Create administrator'}</button>
        </form>
      </div>
    </div>
  )
}

function LoginPage({ onLogin }: { onLogin: (email: string, password: string) => Promise<User> }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const user = await onLogin(email, password)
      navigate(user.role === 'admin' ? '/admin' : '/dashboard')
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : 'Could not sign in.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="auth-shell"><div className="auth-card">
      <div className="auth-header"><p className="eyebrow">Quiz response viewer</p><h1>User sign in</h1><p>Sign in with the approved email and password for your account.</p></div>
      <form className="auth-form" onSubmit={(event) => void submit(event)}>
        <label>Login email<input type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        {error ? <p className="error-banner" role="alert">{error}</p> : null}
        <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Checking…' : 'Sign in'}</button>
      </form>
      <p className="auth-switch">Approved by your administrator? <Link to="/register">Set up your password</Link></p>
    </div></div>
  )
}

function RegisterPage({ onRegister }: { onRegister: (name: string, email: string, password: string) => Promise<User> }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const user = await onRegister(name, email, password)
      navigate(user.role === 'admin' ? '/admin' : '/dashboard')
    } catch (registrationError) {
      setError(registrationError instanceof Error ? registrationError.message : 'Could not set up your account.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="auth-shell"><div className="auth-card">
      <div className="auth-header"><p className="eyebrow">Quiz response viewer</p><h1>Set up your account</h1><p>Use the email address your administrator approved, then choose your own password.</p></div>
      <form className="auth-form" onSubmit={(event) => void submit(event)}>
        <label>Your name<input autoComplete="name" required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>Approved email<input type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label>Create password (8+ characters)<input type="password" autoComplete="new-password" minLength={8} maxLength={128} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        {error ? <p className="error-banner" role="alert">{error}</p> : null}
        <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Creating account…' : 'Create account'}</button>
      </form>
      <p className="auth-switch">Already set up your password? <Link to="/login">Sign in</Link></p>
    </div></div>
  )
}

function ProtectedLayout({ currentUser, onLogout, children }: { currentUser: User; onLogout: () => void; children: React.ReactNode }) {
  const navigate = useNavigate()
  return (
    <div className="app-shell">
      <header className="topbar">
        <div><p className="eyebrow">Answer viewer</p><h2>{currentUser.name}</h2></div>
        <nav className="topbar-nav">
          {currentUser.role === 'admin' ? <Link to="/admin">Admin dashboard</Link> : null}
          <Link to="/dashboard">My responses</Link>
          <button type="button" className="ghost-button" onClick={() => { onLogout(); navigate('/login') }}>Log out</button>
        </nav>
      </header>
      <main className="main-content">{children}</main>
    </div>
  )
}

function DashboardPage({ currentUser }: { currentUser: User }) {
  const [attempts, setAttempts] = useState<Attempt[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    api<{ attempts: Attempt[] }>('/api/attempts')
      .then((result) => { if (active) setAttempts(result.attempts) })
      .catch((loadError: unknown) => { if (active) setError(loadError instanceof Error ? loadError.message : 'Could not load test responses.') })
    return () => { active = false }
  }, [])
  const scored = attempts.filter((attempt) => attempt.percentage !== null)
  const average = scored.length ? `${Math.round(scored.reduce((sum, attempt) => sum + (attempt.percentage ?? 0), 0) / scored.length)}%` : '—'
  return (
    <section className="page-section">
      <div className="page-header"><div><p className="eyebrow">Overview</p><h1>My test responses</h1></div></div>
      {error ? <p className="error-banner" role="alert">{error}</p> : null}
      <div className="stats-grid">
        <StatCard label="Test responses" value={String(attempts.length)} tone="blue" />
        <StatCard label="Average percentage" value={average} tone="green" />
        <StatCard label="Most recent test" value={attempts[0] ? displayDate(attempts[0].submittedAt) : 'No data'} tone="purple" />
      </div>
      <div className="attempt-list">
        {attempts.length ? attempts.map((attempt) => (
          <Link to={`/attempt/${encodeURIComponent(attempt.id)}`} key={attempt.id} className="attempt-card">
            <div><p className="eyebrow">{attempt.quizName}</p><h3>{displayDate(attempt.submittedAt)}</h3></div>
            <div className="attempt-meta"><span>{formatScore(attempt)}</span><span>{attempt.questions.length} questions</span></div>
          </Link>
        )) : <div className="empty-state">{error ? 'Response list could not be loaded.' : `No quiz responses are associated with ${currentUser.email}.`}</div>}
      </div>
    </section>
  )
}

function AttemptDetailPage({ currentUser }: { currentUser: User }) {
  const { attemptId } = useParams()
  const navigate = useNavigate()
  const [attempts, setAttempts] = useState<Attempt[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    api<{ attempts: Attempt[] }>('/api/attempts')
      .then((result) => { if (active) setAttempts(result.attempts) })
      .catch((loadError: unknown) => { if (active) setError(loadError instanceof Error ? loadError.message : 'Could not load response.') })
    return () => { active = false }
  }, [])
  const attempt = attempts.find((item) => item.id === attemptId && item.userId === currentUser.id)
  if (error) return <section className="page-section"><p className="error-banner" role="alert">{error}</p></section>
  if (!attempt) return <section className="page-section"><div className="empty-state">This response is not available to your account.</div></section>
  const counts = attempt.questions.reduce(
    (value, question) => {
      if (!question.selectedAnswer) value.unanswered += 1
      else if (question.isCorrect === true) value.correct += 1
      else if (question.isCorrect === false) value.incorrect += 1
      return value
    },
    { correct: 0, incorrect: 0, unanswered: 0 },
  )
  return (
    <section className="page-section">
      <div className="page-header">
        <div><p className="eyebrow">Test response</p><h1>{attempt.quizName}</h1></div>
        <label className="field-label response-picker">Choose a test response
          <select value={attempt.id} onChange={(event) => navigate(`/attempt/${encodeURIComponent(event.target.value)}`)}>
            {attempts.map((item) => <option value={item.id} key={item.id}>{item.quizName} — {displayDate(item.submittedAt)}</option>)}
          </select>
        </label>
      </div>
      <div className="summary-banner">
        <div><span>Submitted</span><strong>{displayDate(attempt.submittedAt)}</strong></div>
        <div><span>Score</span><strong>{attempt.totalScore === null ? 'Not available' : formatScore(attempt)}</strong></div>
        <div><span>Correct</span><strong>{counts.correct}</strong></div>
        <div><span>Incorrect</span><strong>{counts.incorrect}</strong></div>
        <div><span>Unanswered</span><strong>{counts.unanswered}</strong></div>
      </div>
      <div className="question-stack">
        {attempt.questions.map((question) => (
          <article key={question.questionNumber} className={`question-card ${question.isCorrect === true ? 'correct' : question.isCorrect === false ? 'incorrect' : ''}`}>
            <div className="question-head">
              <span className="question-pill">Question {question.questionNumber}</span>
              <span className={`status-badge ${question.isCorrect === true ? 'pass' : question.isCorrect === false ? 'fail' : ''}`}>
                {question.isCorrect === true ? 'Correct' : question.isCorrect === false ? 'Incorrect' : 'Not graded'}
              </span>
            </div>
            <h3>{question.questionText}</h3>
            {question.options.length ? <ul className="option-list">{question.options.map((option) => {
              const isCorrectOption = question.correctAnswers.includes(option)
              const isSelected = question.selectedAnswer === option
              const className = isCorrectOption ? 'answer-correct' : isSelected && question.isCorrect === false ? 'answer-wrong' : ''
              return <li key={`${question.questionNumber}-${option}`} className={className}><span>{option}</span>{isCorrectOption ? <em>Correct answer</em> : null}{isSelected ? <em>Your answer</em> : null}</li>
            })}</ul> : <p className="not-available">Answer options not available in imported responses</p>}
            <div className="answer-details">
              <div><span>Correct answer(s)</span><strong>{question.correctAnswers.length ? question.correctAnswers.join(', ') : 'Not available in imported data'}</strong></div>
              <div><span>Your answer</span><strong>{question.selectedAnswer || 'Not answered'}</strong></div>
              <div><span>Points earned</span><strong>{question.pointsEarned ?? 'Not available'}</strong></div>
            </div>
            {question.feedback ? <p className="feedback">Feedback: {question.feedback}</p> : null}
          </article>
        ))}
      </div>
      <Link to="/dashboard" className="ghost-button inline-link">Back to my responses</Link>
    </section>
  )
}

function AdminPage() {
  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [users, setUsers] = useState<User[]>([])
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [selectedQuiz, setSelectedQuiz] = useState('')
  const [maxScore, setMaxScore] = useState('')
  const [searchEmail, setSearchEmail] = useState('')
  const [inspectUserId, setInspectUserId] = useState('')
  const [inspection, setInspection] = useState<Attempt[]>([])
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [email, setEmail] = useState('')

  const refresh = async () => {
    const [nextOverview, nextUsers] = await Promise.all([
      api<AdminOverview>('/api/admin/overview'),
      api<{ users: User[] }>(`/api/admin/users?query=${encodeURIComponent(normalizeEmail(searchEmail))}`),
    ])
    setOverview(nextOverview)
    setUsers(nextUsers.users)
  }
  useEffect(() => {
    let active = true
    Promise.all([api<AdminOverview>('/api/admin/overview'), api<{ users: User[] }>('/api/admin/users')])
      .then(([nextOverview, nextUsers]) => {
        if (active) { setOverview(nextOverview); setUsers(nextUsers.users) }
      })
      .catch((loadError: unknown) => { if (active) setError(loadError instanceof Error ? loadError.message : 'Could not load admin data.') })
    return () => { active = false }
  }, [])
  useEffect(() => {
    const timer = window.setTimeout(() => {
      api<{ users: User[] }>(`/api/admin/users?query=${encodeURIComponent(normalizeEmail(searchEmail))}`)
        .then((result) => setUsers(result.users))
        .catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : 'Could not search users.'))
    }, 200)
    return () => window.clearTimeout(timer)
  }, [searchEmail])

  const approveEmail = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const result = await api<{ added: boolean }>('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({ email }),
      })
      setEmail('')
      setMessage(result.added ? 'Email approved. The user can now set up their own password.' : 'This email is already approved.')
      await refresh()
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : 'Could not approve this email.')
    } finally { setBusy(false) }
  }

  const addEmailList = async (file: File) => {
    setError(null)
    try {
      const result = await previewEmailList(file)
      const response = await api<{ added: number }>('/api/admin/approved-emails', {
        method: 'POST',
        body: JSON.stringify({ emails: result.emails }),
      })
      setMessage(`${response.added} approved email${response.added === 1 ? '' : 's'} added. Users can set their own passwords from the sign-in page.`)
      if (result.errors.length) setError(result.errors.join(' '))
      await refresh()
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Could not import the email list.')
    }
  }

  const prepareResponseFile = async (file: File) => {
    setError(null)
    setMessage(null)
    if (!selectedQuiz.trim()) { setError('Enter a quiz name before choosing the response file.'); return }
    const parsedMaxScore = Number(maxScore)
    if (!maxScore.trim() || !Number.isFinite(parsedMaxScore) || parsedMaxScore <= 0) {
      setError('Enter a total marks value greater than zero before choosing the response file.')
      return
    }
    try {
      const result = await previewResponseFile(file, selectedQuiz, parsedMaxScore, users)
      setPreview(result)
      if (!result.validRows) setMessage('No response rows match approved user emails. Nothing can be imported.')
    } catch (uploadError) {
      setPreview(null)
      setError(uploadError instanceof Error ? uploadError.message : 'Could not read the response file.')
    }
  }

  const confirmImport = async () => {
    if (!preview || !preview.attempts.length) return
    if (!window.confirm(`Import ${preview.attempts.length} matched response(s) into the shared database?`)) return
    setBusy(true)
    setError(null)
    try {
      const result = await api<{ imported: number; skipped: number }>('/api/admin/imports', {
        method: 'POST',
        body: JSON.stringify({
          id: preview.id,
          fileName: preview.fileName,
          quizName: preview.quizName,
          skipped: preview.anonymousRows + preview.unmatchedRows + preview.malformedRows,
          errors: preview.unmatchedRows + preview.malformedRows,
          attempts: preview.attempts,
        }),
      })
      setMessage(`${result.imported} response(s) saved to the shared database.`)
      setPreview(null)
      await refresh()
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Could not import responses.')
    } finally { setBusy(false) }
  }

  const inspectUser = async (userId: string) => {
    setInspectUserId(userId)
    setError(null)
    try {
      const result = await api<{ attempts: Attempt[] }>(`/api/admin/users/${encodeURIComponent(userId)}/attempts`)
      setInspection(result.attempts)
    } catch (inspectionError) {
      setError(inspectionError instanceof Error ? inspectionError.message : 'Could not inspect this user.')
    }
  }

  const removeImport = async (importId: string) => {
    if (!window.confirm('Remove this import and every attempt it added? This cannot be undone.')) return
    setError(null)
    try {
      await api(`/api/admin/imports/${encodeURIComponent(importId)}`, { method: 'DELETE' })
      setMessage('Import and its attempts were removed from the database.')
      await refresh()
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : 'Could not remove the import.')
    }
  }

  const downloadEmails = () => {
    const csv = Papa.unparse({ fields: ['Email', 'Name'], data: users.map((user) => [user.email, user.name]) })
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'approved-email-list.csv'
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  const filteredUsers = useMemo(() => users, [users])

  return (
    <section className="page-section">
      <div className="page-header"><div><p className="eyebrow">Administrator controls</p><h1>Admin overview</h1></div></div>
      <div className="stats-grid">
        <StatCard label="Registered users" value={String(overview?.counts.users ?? '—')} tone="blue" />
        <StatCard label="Imported quizzes" value={String(overview?.counts.quizzes ?? '—')} tone="green" />
        <StatCard label="Response records" value={String(overview?.counts.attempts ?? '—')} tone="purple" />
        <StatCard label="Import batches" value={String(overview?.imports.length ?? '—')} tone="orange" />
      </div>
      {message ? <p className="success-banner" role="status">{message}</p> : null}
      {error ? <p className="error-banner" role="alert">{error}</p> : null}

      <div className="admin-grid">
        <div className="panel">
          <div className="panel-header"><h3>Add approved emails</h3><button type="button" className="ghost-button small" onClick={downloadEmails}>Download approved-email-list.csv</button></div>
          <p>Import a CSV/XLSX with an Email column. Valid addresses are saved in the shared D1 registry.</p>
          <label className="file-picker"><span>Choose approved email list</span><input type="file" accept=".csv,.xlsx" onChange={(event) => { const file = event.target.files?.[0]; if (file) void addEmailList(file); event.currentTarget.value = '' }} /></label>
          <hr />
          <div className="panel-header"><h3>Approve a user email</h3></div>
          <p>Users create their own password after their email has been approved.</p>
          <form className="auth-form" onSubmit={(event) => void approveEmail(event)}>
            <label className="field-label">User email<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
            <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Approving…' : 'Approve email'}</button>
          </form>
        </div>

        <div className="panel">
          <div className="panel-header"><h3>Users</h3></div>
          <label className="field-label">Search by email<input value={searchEmail} onChange={(event) => setSearchEmail(event.target.value)} placeholder="search@example.com" /></label>
          <div className="users-list-scroll" aria-label="Approved users">
            <ul className="search-list">{filteredUsers.map((user) => (
              <li key={user.id}>
                <div className="user-list-info"><strong>{user.name}</strong><small>{user.email}</small></div>
                <div className="user-list-actions">
                  <span
                    className={`role-indicator ${user.role === 'admin' ? 'admin' : user.hasPassword ? 'user' : 'unregistered'}`}
                    role="img"
                    aria-label={user.role === 'admin' ? 'Admin' : user.hasPassword ? 'User' : 'Unregister User'}
                    title={user.role === 'admin' ? 'Admin' : user.hasPassword ? 'User' : 'Unregister User'}
                  />
                  <button type="button" className="ghost-button small inspect-button" onClick={() => void inspectUser(user.id)}>Inspect</button>
                </div>
              </li>
            ))}</ul>
          </div>
          {inspectUserId ? <div className="user-inspection">
            <h4>Responses for {users.find((user) => user.id === inspectUserId)?.email}</h4>
            {inspection.length ? inspection.map((attempt) => <p key={attempt.id}>{attempt.quizName} — {displayDate(attempt.submittedAt)} — {formatScore(attempt)}</p>) : <p>No responses.</p>}
          </div> : null}
        </div>
      </div>

      <div className="panel">
        <div className="panel-header"><h3>Import quiz responses</h3></div>
        <p>Only registered, non-anonymous emails are stored as attempts. All saved attempts and inferred correct answers are shared through D1.</p>
        <div className="upload-controls">
          <label className="field-label">Quiz name<input value={selectedQuiz} onChange={(event) => setSelectedQuiz(event.target.value)} placeholder="Quiz name" /></label>
          <label className="field-label">Total marks (out of)<input type="number" min="0.01" step="any" required value={maxScore} onChange={(event) => { setMaxScore(event.target.value); setPreview(null) }} placeholder="e.g. 50" /></label>
          <label className="file-picker"><span>Choose response CSV/XLSX file</span><input type="file" accept=".csv,.xlsx" onChange={(event) => { const file = event.target.files?.[0]; if (file) void prepareResponseFile(file); event.currentTarget.value = '' }} /></label>
        </div>
        {preview ? <div className="preview-box">
          <div className="preview-header"><div><h4>{preview.fileName}</h4><p>{preview.validRows} matched response(s) ready · Scores are out of {maxScore} marks</p></div><button type="button" className="primary-button" disabled={!preview.validRows || busy} onClick={() => void confirmImport()}>{busy ? 'Saving…' : 'Confirm import'}</button></div>
          <div className="summary-row"><span>Matched</span><strong>{preview.validRows}</strong><span>Anonymous</span><strong>{preview.anonymousRows}</strong><span>Unmatched</span><strong>{preview.unmatchedRows}</strong><span>Invalid</span><strong>{preview.malformedRows}</strong></div>
          <div className="validation-list">{preview.errors.map((item) => <p key={item}>{item}</p>)}</div>
          <div className="table-wrap"><table><thead><tr>{preview.headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{preview.rows.map((row, index) => <tr key={`${preview.id}-${index}`}>{preview.headers.map((header) => <td key={`${index}-${header}`}>{row[header]}</td>)}</tr>)}</tbody></table></div>
        </div> : <div className="empty-state small">Preview and confirm a response file. Duplicate imports are rejected by the shared database.</div>}
      </div>

      <div className="panel">
        <div className="panel-header"><h3>Recent imports</h3></div>
        <div className="import-list">{overview?.imports.length ? overview.imports.map((entry) => (
          <div key={entry.id} className="import-item">
            <div><strong>{entry.quizName}</strong><small>{entry.fileName} · {displayDate(entry.importedAt)}</small></div>
            <div className="import-stats"><span>{entry.processed} imported</span><span>{entry.skipped} excluded</span><span>{entry.errors} errors</span></div>
            <button type="button" className="ghost-button small" onClick={() => void removeImport(entry.id)}>Remove import</button>
          </div>
        )) : <div className="empty-state">{overview ? 'No imports yet.' : 'Loading imports…'}</div>}</div>
      </div>
    </section>
  )
}

function StatCard({ label, value, tone }: { label: string; value: string; tone: 'blue' | 'green' | 'purple' | 'orange' }) {
  return <div className={`stat-card ${tone}`}><span>{label}</span><strong>{value}</strong></div>
}

export default App
