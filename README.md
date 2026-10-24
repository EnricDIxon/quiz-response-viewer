# Quiz Response Viewer

Quiz Response Viewer is a React application served by a Cloudflare Worker. The Worker provides authentication and authorization, and Cloudflare D1 stores users, password credentials, sessions, quizzes, imports, and response attempts. A hosted D1 database lets multiple people use the same data from different devices.

## Requirements

- Node.js and npm
- A Cloudflare account for a shared deployment
- Wrangler authentication (`npx wrangler login`) for creating and deploying remote resources

## Local development

1. Install dependencies:

   ```powershell
   npm install
   ```

2. Apply the schema to the local Wrangler D1 database:

   ```powershell
   npm run db:migrate:local
   ```

3. Create a local `.dev.vars` file with a private bootstrap secret:

   ```text
   BOOTSTRAP_SECRET=replace-with-a-long-random-secret
   ```

   Do not commit this file. It is ignored by Git.

4. Start the Worker and frontend:

   ```powershell
   npm run dev
   ```

   Open the local address printed by Wrangler. Local D1 data is stored on this development machine and is not shared with other devices.

## Shared Cloudflare deployment

1. Authenticate with Cloudflare and create a D1 database:

   ```powershell
   npx wrangler login
   npm run db:create
   ```

   If you already created the `response_viewer` database in the Cloudflare dashboard, use that database's ID in `wrangler.toml` instead of creating another one. The configured name and ID must refer to the same database.

2. Apply the schema to the remote database:

   ```powershell
   npm run db:migrate:remote
   ```

3. Set a unique bootstrap secret in Cloudflare. Wrangler prompts for the value:

   ```powershell
   npx wrangler secret put BOOTSTRAP_SECRET
   ```

4. Build and deploy:

   ```powershell
   npm run deploy
   ```

5. Open the deployed application and complete the one-time administrator setup using the same bootstrap secret. Choose a strong administrator password. The bootstrap endpoint can only create the initial admin; it is unavailable once an administrator exists.

The deployed Worker and its D1 binding are the shared service. Do not use the local Wrangler database when expecting cross-device or simultaneous access. Back up and manage the remote database through Cloudflare's D1 tools.

### Source control and deployments

The source repository is [EnricDIxon/quiz-response-viewer](https://github.com/EnricDIxon/quiz-response-viewer). GitHub is used for source control and backup; it is not currently connected to automatic Cloudflare builds. To publish changes, commit and push them to GitHub, then deploy to Cloudflare with `npm run deploy` from the project directory. Runtime secrets such as `BOOTSTRAP_SECRET` remain configured in Cloudflare and must not be committed to GitHub. Apply future D1 schema migrations to the remote database before deploying code that depends on them.

## Accounts and password storage

- Administrators can approve accounts individually or import an email list with an `Email` column. Users then open the app's **Set up your password** page, enter their approved email and name, and choose their own password. Registration is only allowed once for an approved email.
- Users sign in through the separate **User sign in** page after setting up their password.
- Users authenticate with their approved email and password. Email addresses are normalized to lowercase.
- User profile records and password credentials are stored separately in D1. Passwords are never stored in plaintext: the Worker uses salted PBKDF2-SHA-256 with 100,000 iterations, the maximum supported by the Workers Web Crypto runtime.
- Session tokens are random, held in `HttpOnly`, `SameSite=Strict` cookies, and stored in D1 only as SHA-256 digests. Sessions expire after seven days. Login failures are rate-limited.
- API routes enforce authentication, administrator permissions, and attempt ownership on the server.
- Set `BOOTSTRAP_SECRET` as a Wrangler secret in production. It is not a frontend setting.

## Response spreadsheets

- CSV and XLSX files are parsed in the browser. The first row is treated as the header row; the importer recognizes email, question, points, feedback, total-score, and completion-time columns.
- Files are limited to 10 MB and 500 response rows. The Worker independently validates imported data before saving it.
- Blank, malformed, anonymous, and unapproved email rows are not saved as attempts. Anonymous responses can still contribute observed answer options and positive-point answer-key inference for the import.
- Options are inferred from responses. An answer with points greater than zero is considered correct. A correct option is highlighted in green; a selected incorrect answer is highlighted in red.
- Each accepted response is saved as an attempt. A SHA-256 fingerprint prevents importing the same file twice. Administrators can inspect users' attempts and remove an import with its attempts.
- Total points are retained; a maximum score or percentage is not fabricated when the source file does not provide one.

## Database contents

The D1 schema is in `migrations/0001_initial.sql`. It includes users, separate credentials, sessions, quizzes, import batches, attempts, and login rate limits. Each attempt stores a JSON snapshot of its questions, observed options, inferred correct answers, selected answers, points, and feedback. This keeps each imported response reviewable as it was imported without requiring a separate questions table.

The database is hosted for a deployed app; it is not a `.db` file copied between browsers. Existing browser-local data from the earlier prototype is not migrated automatically.

## Checks

```powershell
npm run build
npm run lint
```
