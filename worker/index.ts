interface Env {
  DB: D1Database
  ASSETS: Fetcher
  BOOTSTRAP_SECRET?: string
  ENVIRONMENT?: string
}

interface PublicUser {
  id: string
  name: string
  email: string
  role: 'admin' | 'user'
}

interface StoredAttempt {
  id: string
  import_id: string
  quiz_id: string
  quiz_name: string
  user_id: string
  email: string
  submitted_at: string
  total_score: number | null
  questions_json: string
}

interface IncomingQuestion {
  questionNumber: number
  questionText: string
  options: string[]
  correctAnswers: string[]
  selectedAnswer: string
  pointsEarned: number | null
  feedback: string
  isCorrect: boolean | null
}

interface IncomingAttempt {
  email: string
  sourceRow: number
  submittedAt: string
  totalScore: number | null
  questions: IncomingQuestion[]
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

const SESSION_SECONDS = 7 * 24 * 60 * 60
const MAX_BODY_BYTES = 8 * 1024 * 1024
const MAX_IMPORT_ATTEMPTS = 500
const MAX_QUESTIONS_PER_ATTEMPT = 100
const PASSWORD_ITERATIONS = 100_000

function json(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  headers.set('Cache-Control', 'no-store')
  return new Response(JSON.stringify(data), { status, headers })
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(bytes.length)
  new Uint8Array(result).set(bytes)
  return result
}

async function derivePassword(password: string, suppliedSalt?: Uint8Array) {
  const salt = suppliedSalt ?? crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: asArrayBuffer(salt), iterations: PASSWORD_ITERATIONS },
    key,
    256,
  )
  return { salt: encodeBase64(salt), passwordHash: encodeBase64(new Uint8Array(bits)) }
}

async function verifyPassword(password: string, salt: string, expectedHash: string): Promise<boolean> {
  const derived = await derivePassword(password, decodeBase64(salt))
  const actualBytes = decodeBase64(derived.passwordHash)
  const expectedBytes = decodeBase64(expectedHash)
  if (actualBytes.length !== expectedBytes.length) return false
  let difference = 0
  for (let index = 0; index < actualBytes.length; index += 1) {
    difference |= actualBytes[index] ^ expectedBytes[index]
  }
  return difference === 0
}

function cookieValue(request: Request, name: string): string | null {
  const cookies = request.headers.get('Cookie') ?? ''
  for (const segment of cookies.split(';')) {
    const [key, ...value] = segment.trim().split('=')
    if (key === name) return value.join('=') || null
  }
  return null
}

function sessionCookie(token: string, request: Request): string {
  const secure = new URL(request.url).protocol === 'https:'
  return `quiz_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}${secure ? '; Secure' : ''}`
}

function clearedSessionCookie(request: Request): string {
  const secure = new URL(request.url).protocol === 'https:'
  return `quiz_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`
}

function requireSameOrigin(request: Request): void {
  const origin = request.headers.get('Origin')
  if (!origin || origin !== new URL(request.url).origin) {
    throw new HttpError(403, 'Cross-origin requests are not allowed.')
  }
}

async function readJson<T>(request: Request): Promise<T> {
  const contentLength = Number(request.headers.get('Content-Length') ?? 0)
  if (contentLength > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large.')
  const text = await request.text()
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    throw new HttpError(413, 'Request body is too large.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new HttpError(400, 'Request body must contain valid JSON.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'Request body must be a JSON object.')
  }
  return parsed as T
}

async function currentUser(request: Request, env: Env): Promise<PublicUser | null> {
  const token = cookieValue(request, 'quiz_session')
  if (!token) return null
  const tokenHash = await sha256(token)
  const result = await env.DB.prepare(
    `SELECT users.id, users.name, users.email, users.role, sessions.expires_at
     FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ?`,
  )
    .bind(tokenHash)
    .first<PublicUser & { expires_at: number }>()
  if (!result) return null
  if (result.expires_at <= Math.floor(Date.now() / 1000)) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run()
    return null
  }
  return { id: result.id, name: result.name, email: result.email, role: result.role }
}

function requireAdmin(user: PublicUser | null): PublicUser {
  if (!user) throw new HttpError(401, 'Please sign in.')
  if (user.role !== 'admin') throw new HttpError(403, 'Administrator access is required.')
  return user
}

async function requireUser(user: PublicUser | null): Promise<PublicUser> {
  if (!user) throw new HttpError(401, 'Please sign in.')
  return user
}

async function isBootstrapSecretValid(supplied: string, expected: string): Promise<boolean> {
  const actualDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(supplied))
  const expectedDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(expected))
  const actual = new Uint8Array(actualDigest)
  const wanted = new Uint8Array(expectedDigest)
  let difference = 0
  for (let index = 0; index < actual.length; index += 1) difference |= actual[index] ^ wanted[index]
  return difference === 0
}

async function setupAdmin(request: Request, env: Env): Promise<Response> {
  requireSameOrigin(request)
  if (!env.BOOTSTRAP_SECRET) throw new HttpError(503, 'Administrator setup is not configured.')
  const body = await readJson<{ secret?: string; email?: string; name?: string; password?: string }>(request)
  if (
    typeof body.secret !== 'string' ||
    !(await isBootstrapSecretValid(body.secret, env.BOOTSTRAP_SECRET))
  ) {
    throw new HttpError(403, 'The setup secret is incorrect.')
  }
  const existingAdmin = await env.DB.prepare(
    "SELECT id FROM users WHERE role = 'admin' LIMIT 1",
  ).first<{ id: string }>()
  if (existingAdmin) throw new HttpError(409, 'Initial administrator setup has already been completed.')

  const email = normalizeEmail(typeof body.email === 'string' ? body.email : '')
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  if (!validEmail(email) || !name || password.length < 12 || password.length > 128) {
    throw new HttpError(400, 'Provide a valid email, a name, and a password between 12 and 128 characters.')
  }
  const userId = crypto.randomUUID()
  const { salt, passwordHash } = await derivePassword(password)
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, 'admin')").bind(
        userId,
        email,
        name,
      ),
      env.DB.prepare('INSERT INTO credentials (user_id, salt, password_hash) VALUES (?, ?, ?)').bind(
        userId,
        salt,
        passwordHash,
      ),
    ])
  } catch {
    throw new HttpError(409, 'Administrator setup could not be completed; another setup may have just finished.')
  }
  return json({ ok: true }, 201)
}

async function login(request: Request, env: Env): Promise<Response> {
  requireSameOrigin(request)
  const body = await readJson<{ email?: string; password?: string }>(request)
  const email = normalizeEmail(typeof body.email === 'string' ? body.email : '')
  const password = typeof body.password === 'string' ? body.password : ''
  if (!validEmail(email) || !password || password.length > 128) {
    throw new HttpError(400, 'Enter a valid email and password.')
  }

  const emailKey = await sha256(email)
  const now = Math.floor(Date.now() / 1000)
  const limit = await env.DB.prepare(
    'SELECT failures, window_started, blocked_until FROM login_rate_limits WHERE email_key = ?',
  )
    .bind(emailKey)
    .first<{ failures: number; window_started: number; blocked_until: number }>()
  if (limit && limit.blocked_until > now && limit.failures >= 5) {
    throw new HttpError(429, 'Too many unsuccessful sign-in attempts. Try again later.')
  }

  const account = await env.DB.prepare(
    `SELECT users.id, users.name, users.email, users.role,
            credentials.salt, credentials.password_hash
     FROM users JOIN credentials ON credentials.user_id = users.id
     WHERE users.email = ?`,
  )
    .bind(email)
    .first<PublicUser & { salt: string; password_hash: string }>()
  const verified =
    account !== null && (await verifyPassword(password, account.salt, account.password_hash))
  if (!verified || !account) {
    await env.DB.prepare(
      `INSERT INTO login_rate_limits (email_key, failures, window_started, blocked_until)
       VALUES (?, 1, ?, 0)
       ON CONFLICT(email_key) DO UPDATE SET
         failures = CASE WHEN login_rate_limits.window_started <= ? THEN 1
                         ELSE login_rate_limits.failures + 1 END,
         window_started = CASE WHEN login_rate_limits.window_started <= ? THEN ?
                               ELSE login_rate_limits.window_started END,
         blocked_until = CASE
           WHEN (CASE WHEN login_rate_limits.window_started <= ? THEN 1
                      ELSE login_rate_limits.failures + 1 END) >= 5 THEN ?
           ELSE 0 END`,
    )
      .bind(emailKey, now, now - 15 * 60, now - 15 * 60, now, now - 15 * 60, now + 15 * 60)
      .run()
    throw new HttpError(401, 'Invalid email or password.')
  }

  await env.DB.prepare('DELETE FROM login_rate_limits WHERE email_key = ?').bind(emailKey).run()
  const token = randomToken()
  const expiresAt = now + SESSION_SECONDS
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
  )
    .bind(await sha256(token), account.id, expiresAt, now)
    .run()
  return json(
    { user: { id: account.id, name: account.name, email: account.email, role: account.role } },
    200,
    { 'Set-Cookie': sessionCookie(token, request) },
  )
}

async function registerUser(request: Request, env: Env): Promise<Response> {
  requireSameOrigin(request)
  const body = await readJson<{ email?: string; name?: string; password?: string }>(request)
  const email = normalizeEmail(typeof body.email === 'string' ? body.email : '')
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  if (!validEmail(email) || !name || name.length > 100 || password.length < 8 || password.length > 128) {
    throw new HttpError(400, 'Provide a valid email, a name, and a password between 8 and 128 characters.')
  }

  const user = await env.DB.prepare(
    `SELECT users.id, users.role
     FROM users
     LEFT JOIN credentials ON credentials.user_id = users.id
     WHERE users.email = ? AND credentials.user_id IS NULL`,
  )
    .bind(email)
    .first<{ id: string; role: 'admin' | 'user' }>()
  if (!user || user.role !== 'user') {
    throw new HttpError(409, 'This email is not approved for registration or its account is already set up. Contact your administrator.')
  }

  const { salt, passwordHash } = await derivePassword(password)
  const credential = await env.DB.prepare(
    `INSERT OR IGNORE INTO credentials (user_id, salt, password_hash)
     SELECT id, ?, ? FROM users WHERE id = ? AND role = 'user'
       AND NOT EXISTS (SELECT 1 FROM credentials WHERE user_id = ?)`,
  )
    .bind(salt, passwordHash, user.id, user.id)
    .run()
  if (credential.meta.changes !== 1) {
    throw new HttpError(409, 'This email is not approved for registration or its account is already set up. Contact your administrator.')
  }

  const token = randomToken()
  const now = Math.floor(Date.now() / 1000)
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind(name, user.id),
    env.DB.prepare(
      'INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
    ).bind(await sha256(token), user.id, now + SESSION_SECONDS, now),
  ])

  return json(
    { user: { id: user.id, name, email, role: 'user' } },
    201,
    { 'Set-Cookie': sessionCookie(token, request) },
  )
}

async function logout(request: Request, env: Env): Promise<Response> {
  requireSameOrigin(request)
  const token = cookieValue(request, 'quiz_session')
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run()
  return json({ ok: true }, 200, { 'Set-Cookie': clearedSessionCookie(request) })
}

async function listAttempts(user: PublicUser, env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT attempts.id, attempts.import_id, attempts.quiz_id, quizzes.name AS quiz_name,
            attempts.user_id, users.email, attempts.submitted_at, attempts.total_score,
            attempts.questions_json
     FROM attempts
     JOIN users ON users.id = attempts.user_id
     JOIN quizzes ON quizzes.id = attempts.quiz_id
     WHERE attempts.user_id = ?
     ORDER BY attempts.submitted_at DESC, attempts.created_at DESC
     LIMIT 1000`,
  )
    .bind(user.id)
    .all<StoredAttempt>()
  return json({ attempts: results.map(mapAttempt) })
}

function mapAttempt(row: StoredAttempt) {
  let questions: unknown
  try {
    questions = JSON.parse(row.questions_json)
  } catch {
    throw new HttpError(500, 'A saved response record is invalid.')
  }
  return {
    id: row.id,
    importId: row.import_id,
    quizId: row.quiz_id,
    quizName: row.quiz_name,
    userId: row.user_id,
    email: row.email,
    submittedAt: row.submitted_at,
    totalScore: row.total_score,
    maxScore: null,
    percentage: null,
    questions,
  }
}

async function adminOverview(env: Env): Promise<Response> {
  const [users, quizzes, attempts, imports] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS count FROM users').first<{ count: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM quizzes').first<{ count: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM attempts').first<{ count: number }>(),
    env.DB.prepare(
      `SELECT import_batches.id, import_batches.file_name, quizzes.name AS quiz_name,
              import_batches.imported_at, import_batches.imported_count,
              import_batches.skipped_count, import_batches.error_count
       FROM import_batches JOIN quizzes ON quizzes.id = import_batches.quiz_id
       ORDER BY import_batches.imported_at DESC LIMIT 50`,
    ).all(),
  ])
  return json({
    counts: { users: users?.count ?? 0, quizzes: quizzes?.count ?? 0, attempts: attempts?.count ?? 0 },
    imports: (imports.results ?? []).map((row) => ({
      id: row.id,
      fileName: row.file_name,
      quizName: row.quiz_name,
      importedAt: row.imported_at,
      processed: row.imported_count,
      skipped: row.skipped_count,
      errors: row.error_count,
    })),
  })
}

async function listUsers(request: Request, env: Env): Promise<Response> {
  const search = normalizeEmail(new URL(request.url).searchParams.get('query') ?? '')
  const { results } = await env.DB.prepare(
    `SELECT users.id, users.name, users.email, users.role,
            EXISTS(SELECT 1 FROM credentials WHERE credentials.user_id = users.id) AS has_password,
            (SELECT COUNT(*) FROM attempts WHERE attempts.user_id = users.id) AS attempt_count
     FROM users
     WHERE (? = '' OR instr(users.email, ?) > 0)
     ORDER BY users.email LIMIT 500`,
  )
    .bind(search, search)
    .all()
  return json({
    users: results.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      hasPassword: Boolean(row.has_password),
      attemptCount: row.attempt_count,
    })),
  })
}

async function createOrUpdateUser(request: Request, env: Env): Promise<Response> {
  requireSameOrigin(request)
  const body = await readJson<{ email?: string }>(request)
  const email = normalizeEmail(typeof body.email === 'string' ? body.email : '')
  if (!validEmail(email)) {
    throw new HttpError(400, 'Provide a valid email address.')
  }
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO users (id, email, name, role)
     VALUES (?, ?, ?, 'user')`,
  )
    .bind(crypto.randomUUID(), email, email.split('@')[0])
    .run()
  return json({ added: result.meta.changes === 1 }, result.meta.changes === 1 ? 201 : 200)
}

async function importApprovedEmails(request: Request, env: Env): Promise<Response> {
  requireSameOrigin(request)
  const body = await readJson<{ emails?: unknown }>(request)
  if (!Array.isArray(body.emails) || body.emails.length > 500) {
    throw new HttpError(400, 'Provide no more than 500 email addresses.')
  }
  const emails = [...new Set(body.emails
    .filter((email): email is string => typeof email === 'string')
    .map(normalizeEmail)
    .filter(validEmail))]
  if (emails.length === 0) return json({ added: 0 })

  const existingRows = await env.DB.prepare(
    `SELECT email FROM users WHERE email IN (${emails.map(() => '?').join(',')})`,
  )
    .bind(...emails)
    .all<{ email: string }>()
  const existing = new Set(existingRows.results.map((row) => row.email))
  const newEmails = emails.filter((email) => !existing.has(email))
  let added = 0
  for (let index = 0; index < newEmails.length; index += 100) {
    const batch = newEmails.slice(index, index + 100).map((email) =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO users (id, email, name, role) VALUES (?, ?, ?, 'user')",
      ).bind(crypto.randomUUID(), email, email.split('@')[0]),
    )
    const results = await env.DB.batch(batch)
    added += results.reduce((count, result) => count + result.meta.changes, 0)
  }
  return json({ added })
}

async function inspectUserAttempts(env: Env, userId: string): Promise<Response> {
  const user = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first<{ id: string }>()
  if (!user) throw new HttpError(404, 'User not found.')
  const { results } = await env.DB.prepare(
    `SELECT attempts.id, attempts.import_id, attempts.quiz_id, quizzes.name AS quiz_name,
            attempts.user_id, users.email, attempts.submitted_at, attempts.total_score,
            attempts.questions_json
     FROM attempts
     JOIN users ON users.id = attempts.user_id
     JOIN quizzes ON quizzes.id = attempts.quiz_id
     WHERE attempts.user_id = ?
     ORDER BY attempts.submitted_at DESC LIMIT 1000`,
  )
    .bind(userId)
    .all<StoredAttempt>()
  return json({ attempts: results.map(mapAttempt) })
}

function validateQuestion(value: unknown, index: number): IncomingQuestion {
  if (!value || typeof value !== 'object') throw new HttpError(400, 'An imported question is malformed.')
  const question = value as Record<string, unknown>
  const text = typeof question.questionText === 'string' ? question.questionText.trim() : ''
  const number = Number(question.questionNumber)
  if (!text || text.length > 2000 || !Number.isInteger(number) || number !== index + 1) {
    throw new HttpError(400, 'Question text or numbering is invalid.')
  }
  const options = question.options
  const correctAnswers = question.correctAnswers
  if (
    !Array.isArray(options) ||
    options.length > 200 ||
    !options.every((option) => typeof option === 'string' && option.length <= 1000) ||
    !Array.isArray(correctAnswers) ||
    !correctAnswers.every(
      (answer) => typeof answer === 'string' && options.includes(answer),
    )
  ) {
    throw new HttpError(400, 'Question options or answer key is invalid.')
  }
  const selectedAnswer = typeof question.selectedAnswer === 'string' ? question.selectedAnswer : ''
  const feedback = typeof question.feedback === 'string' ? question.feedback : ''
  const pointsEarned = question.pointsEarned === null ? null : Number(question.pointsEarned)
  if (
    selectedAnswer.length > 2000 ||
    feedback.length > 5000 ||
    (pointsEarned !== null && !Number.isFinite(pointsEarned))
  ) {
    throw new HttpError(400, 'Question response data is invalid.')
  }
  return {
    questionNumber: number,
    questionText: text,
    options: [...new Set(options as string[])],
    correctAnswers: [...new Set(correctAnswers as string[])],
    selectedAnswer,
    pointsEarned,
    feedback,
    isCorrect: pointsEarned === null ? null : pointsEarned > 0,
  }
}

async function createImport(request: Request, env: Env, admin: PublicUser): Promise<Response> {
  requireSameOrigin(request)
  const body = await readJson<{
    id?: string
    fileName?: string
    quizName?: string
    skipped?: number
    errors?: number
    attempts?: unknown
  }>(request)
  const fileHash = typeof body.id === 'string' ? body.id : ''
  const fileName = typeof body.fileName === 'string' ? body.fileName.trim() : ''
  const quizName = typeof body.quizName === 'string' ? body.quizName.trim() : ''
  if (!/^[a-f0-9]{64}$/.test(fileHash) || !fileName || fileName.length > 255 || !quizName || quizName.length > 200) {
    throw new HttpError(400, 'Import file or quiz details are invalid.')
  }
  if (!Array.isArray(body.attempts) || body.attempts.length === 0 || body.attempts.length > MAX_IMPORT_ATTEMPTS) {
    throw new HttpError(400, `An import must contain between 1 and ${MAX_IMPORT_ATTEMPTS} matched response rows.`)
  }

  const attempts = body.attempts.map((value): IncomingAttempt => {
    if (!value || typeof value !== 'object') throw new HttpError(400, 'An imported response row is malformed.')
    const row = value as Record<string, unknown>
    const email = normalizeEmail(typeof row.email === 'string' ? row.email : '')
    const sourceRow = Number(row.sourceRow)
    const submittedAt = typeof row.submittedAt === 'string' ? row.submittedAt : ''
    const date = submittedAt ? new Date(submittedAt) : null
    const totalScore = row.totalScore === null ? null : Number(row.totalScore)
    if (
      !validEmail(email) ||
      !Number.isInteger(sourceRow) ||
      sourceRow < 2 ||
      (date !== null && Number.isNaN(date.getTime())) ||
      (totalScore !== null && !Number.isFinite(totalScore)) ||
      !Array.isArray(row.questions) ||
      row.questions.length === 0 ||
      row.questions.length > MAX_QUESTIONS_PER_ATTEMPT
    ) {
      throw new HttpError(400, 'An imported response row contains invalid data.')
    }
    return {
      email,
      sourceRow,
      submittedAt: date?.toISOString() ?? '',
      totalScore,
      questions: row.questions.map(validateQuestion),
    }
  })
  if (new Set(attempts.map((attempt) => attempt.sourceRow)).size !== attempts.length) {
    throw new HttpError(400, 'The import contains duplicate source rows.')
  }

  const initialQuizId = crypto.randomUUID()
  await env.DB.prepare('INSERT OR IGNORE INTO quizzes (id, name) VALUES (?, ?)').bind(initialQuizId, quizName).run()
  const quiz = await env.DB.prepare('SELECT id FROM quizzes WHERE name = ?').bind(quizName).first<{ id: string }>()
  if (!quiz) throw new HttpError(500, 'Could not save the quiz record.')
  const quizId = quiz.id
  const importId = crypto.randomUUID()
  const skipped = Math.max(0, Math.min(100_000, Number(body.skipped) || 0))
  const errors = Math.max(0, Math.min(100_000, Number(body.errors) || 0))
  const serialized = JSON.stringify(attempts.map((attempt) => ({
    ...attempt,
    id: `${fileHash}-${attempt.sourceRow}`,
  })))
  const eligible = await env.DB.prepare(
    `SELECT COUNT(*) AS count
     FROM json_each(?) AS input
     JOIN users ON users.email = json_extract(input.value, '$.email') AND users.role = 'user'`,
  )
    .bind(serialized)
    .first<{ count: number }>()
  const importedCount = eligible?.count ?? 0
  if (importedCount === 0) throw new HttpError(400, 'No response emails match approved user accounts.')

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO import_batches
         (id, quiz_id, file_name, file_hash, imported_by, imported_count, skipped_count, error_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(importId, quizId, fileName, fileHash, admin.id, importedCount, skipped, errors),
      env.DB.prepare(
        `INSERT INTO attempts
         (id, import_id, quiz_id, user_id, source_row, submitted_at, total_score, questions_json)
         SELECT
           json_extract(input.value, '$.id'),
           ?,
           ?,
           users.id,
           json_extract(input.value, '$.sourceRow'),
           json_extract(input.value, '$.submittedAt'),
           json_extract(input.value, '$.totalScore'),
           json_extract(input.value, '$.questions')
         FROM json_each(?) AS input
         JOIN users ON users.email = json_extract(input.value, '$.email') AND users.role = 'user'`,
      ).bind(importId, quizId, serialized),
    ])
  } catch (importError) {
    const existingImport = await env.DB.prepare('SELECT id FROM import_batches WHERE file_hash = ?')
      .bind(fileHash)
      .first<{ id: string }>()
    if (existingImport) throw new HttpError(409, 'This exact response file has already been imported.')
    throw importError
  }
  return json({ imported: importedCount, skipped, errors }, 201)
}

async function deleteImport(request: Request, env: Env, id: string): Promise<Response> {
  requireSameOrigin(request)
  const result = await env.DB.prepare('DELETE FROM import_batches WHERE id = ?').bind(id).run()
  if (result.meta.changes === 0) throw new HttpError(404, 'Import not found.')
  return json({ ok: true })
}

async function routeApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  const method = request.method.toUpperCase()

  if (path === '/api/session' && method === 'GET') {
    const user = await currentUser(request, env)
    const admin = await env.DB.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").first()
    return json({ user, setupRequired: !admin })
  }
  if (path === '/api/setup' && method === 'POST') return setupAdmin(request, env)
  if (path === '/api/login' && method === 'POST') return login(request, env)
  if (path === '/api/register' && method === 'POST') return registerUser(request, env)
  if (path === '/api/logout' && method === 'POST') return logout(request, env)

  const user = await currentUser(request, env)
  if (path === '/api/attempts' && method === 'GET') return listAttempts(await requireUser(user), env)
  if (path === '/api/admin/overview' && method === 'GET') {
    requireAdmin(user)
    return adminOverview(env)
  }
  if (path === '/api/admin/users' && method === 'GET') {
    requireAdmin(user)
    return listUsers(request, env)
  }
  if (path === '/api/admin/users' && method === 'POST') {
    requireAdmin(user)
    return createOrUpdateUser(request, env)
  }
  if (path === '/api/admin/approved-emails' && method === 'POST') {
    requireAdmin(user)
    return importApprovedEmails(request, env)
  }
  if (path === '/api/admin/imports' && method === 'POST') {
    return createImport(request, env, requireAdmin(user))
  }
  const userAttemptsMatch = /^\/api\/admin\/users\/([0-9a-f-]+)\/attempts$/i.exec(path)
  if (userAttemptsMatch && method === 'GET') {
    requireAdmin(user)
    return inspectUserAttempts(env, userAttemptsMatch[1])
  }
  const importMatch = /^\/api\/admin\/imports\/([0-9a-f-]+)$/i.exec(path)
  if (importMatch && method === 'DELETE') {
    requireAdmin(user)
    return deleteImport(request, env, importMatch[1])
  }
  throw new HttpError(404, 'API endpoint not found.')
}

function securityHeaders(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  headers.set('X-Frame-Options', 'DENY')
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const response = new URL(request.url).pathname.startsWith('/api/')
        ? await routeApi(request, env)
        : await env.ASSETS.fetch(request)
      return securityHeaders(response)
    } catch (error) {
      if (error instanceof HttpError) return securityHeaders(json({ error: error.message }, error.status))
      console.error('Unhandled request error.', error)
      return securityHeaders(json({ error: 'The request could not be completed.' }, 500))
    }
  },
}
