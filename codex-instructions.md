# Smartbook — Fix Instructions

Below are specific issues to fix in `server.js` and related files. Work through each one. Do not change any feature behavior or UI — these are fixes only.

---

## 1. Require the admin password from the environment — no fallback default

**File:** `server.js`

**Problem:** The current code falls back to `"smartbook-admin"` if `ADMIN_PASSWORD` is not set, which is a hardcoded credential visible in source.

**Fix:** Replace the current `ADMIN_PASSWORD` constant with a check that throws if the env var is missing:

```js
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  throw new Error("ADMIN_PASSWORD environment variable is required. Set it before starting the server.");
}
```

---

## 2. Remove the admin link from the public nav

**File:** `server.js`

**Problem:** The `renderLayout` function includes an `<a class="admin-link" href="/admin">Admin</a>` link in the header for every page, including pages served to regular users. This unnecessarily advertises the admin panel.

**Fix:** Remove the admin link from the `renderLayout` function's header HTML entirely. The admin panel is still accessible by navigating directly to `/admin` — just don't link to it from the public UI.

---

## 3. Add CSRF protection to all POST endpoints

**File:** `server.js`

**Problem:** The POST endpoints `/quiz`, `/email`, and `/admin/login` accept form submissions from any origin. A malicious page could submit these forms silently on behalf of a user.

**Fix:** Implement a simple synchronous CSRF token pattern:

- When a session is created (in `getSession`), generate and store a `csrfToken` on the session using `crypto.randomBytes(18).toString("hex")`.
- Add a hidden `<input type="hidden" name="_csrf" value="...">` field to every HTML form: the quiz form, the email form, and the admin login form.
- At the top of each POST handler (before processing any data), read `_csrf` from the parsed form body and compare it to `session.csrfToken`. If they don't match or either is missing, respond with a 403 status and a plain-text error: `"Invalid or missing CSRF token."`.

---

## 4. Add the Secure flag to the session cookie for HTTPS

**File:** `server.js`

**Problem:** The session cookie is set without the `Secure` flag, meaning it can be sent over unencrypted HTTP connections in production.

**Fix:** Add a `COOKIE_SECURE` environment variable check and conditionally append `; Secure` to the cookie string. When `NODE_ENV=production` (or `COOKIE_SECURE=true`), the Secure flag should be included:

```js
const secureCookie = process.env.NODE_ENV === "production" || process.env.COOKIE_SECURE === "true";
// then in the Set-Cookie header:
`smartbook_sid=${sessionId}; Path=/; HttpOnly; SameSite=Lax${secureCookie ? "; Secure" : ""}`
```

---

## 5. Replace synchronous file I/O with async file I/O

**File:** `server.js`

**Problem:** `loadDb()` uses `fs.readFileSync` and `saveDb()` uses `fs.writeFileSync`. These block Node's event loop on every request, causing all other requests to queue up while a read or write completes. This will make the server unresponsive under concurrent load.

**Fix:** Convert `loadDb` and `saveDb` to async functions using `fs.promises`:

```js
async function loadDb() {
  const raw = await fs.promises.readFile(DB_FILE, "utf8");
  return JSON.parse(raw);
}

async function saveDb(db) {
  await fs.promises.writeFile(DB_FILE, JSON.stringify(db, null, 2));
}
```

Update all callers of `loadDb` and `saveDb` to use `await`. These are: `createLead`, `updateLead`, `getLead`, `trackEvent`, `getFunnelSummary`, `buildCsv`, and `renderAdminDashboard`. Make each of these functions `async` and `await` the DB calls within them. Update their call sites in the request handler accordingly (already in an `async` function, so `await` will work directly).

Also update `ensureStorage` to use `fs.promises.mkdir` and `fs.promises.writeFile` with `await`, and make it `async`. Since it's called at startup (before the server listens), change the startup sequence to:

```js
ensureStorage().then(() => {
  server.listen(PORT, () => {
    console.log(`Smartbook running at http://localhost:${PORT}`);
  });
}).catch((err) => {
  console.error("Failed to initialize storage:", err);
  process.exit(1);
});
```

---

## 6. Serialize database writes to prevent race conditions

**File:** `server.js`

**Problem:** Two concurrent requests (e.g., two quiz submissions arriving at the same millisecond) will both call `loadDb()`, both read the same state, both increment `nextLeadId` to the same value, and then both call `saveDb()` — with the second write silently overwriting the first. This causes lost data and duplicate IDs.

**Fix:** Introduce a simple async write queue so that DB write operations are serialized:

```js
let dbWriteQueue = Promise.resolve();

function enqueueDbWrite(fn) {
  dbWriteQueue = dbWriteQueue.then(fn).catch((err) => {
    console.error("DB write error:", err);
  });
  return dbWriteQueue;
}
```

Wrap any function that performs a read-then-write sequence (`createLead`, `updateLead`, `trackEvent`) so the entire read+modify+write happens inside a single `enqueueDbWrite` call. This ensures no two writes can interleave.

---

## 7. Expand `.gitignore` to exclude the entire `data/` directory

**File:** `.gitignore`

**Problem:** The current `.gitignore` only excludes `data/db.json`. The `data/` directory itself and any other files that might appear in it (backups, temp files) are not covered.

**Fix:** Replace `data/db.json` with `data/` in `.gitignore`:

```
data/
```

---

## 8. Add basic rate limiting to the quiz and email POST endpoints

**File:** `server.js`

**Problem:** There is no rate limiting. A script can submit the quiz thousands of times, generating fake leads and filling the disk.

**Fix:** Add a simple in-memory IP-based rate limiter. At the top of the file, create a Map to track request counts per IP with a rolling 1-minute window:

```js
const rateLimitMap = new Map(); // ip -> { count, resetAt }
const RATE_LIMIT = 20; // max submissions per window
const RATE_WINDOW_MS = 60_000; // 1 minute

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT;
}
```

Apply it at the start of the `POST /quiz` and `POST /email` handlers:

```js
const ip = req.socket.remoteAddress || "";
if (isRateLimited(ip)) {
  sendText(res, "Too many requests. Please wait a moment and try again.", 429);
  return;
}
```

Also add a periodic cleanup so the Map doesn't grow unbounded:

```js
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, 60_000);
```

---

## Testing checklist after making changes

- Start the server **without** `ADMIN_PASSWORD` set — it should throw and refuse to start.
- Start the server **with** `ADMIN_PASSWORD=yourpassword node server.js` — it should start normally.
- Confirm the admin link no longer appears in the page header.
- Submit the quiz — the CSRF token should be validated on submit; tampering with or removing `_csrf` in the form should return a 403.
- Complete the full flow (quiz → email → results → operator click) and confirm all data saves correctly.
- Submit the quiz twice in rapid succession and confirm both leads are saved with unique IDs (no overwrite).
- Submit the quiz more than 20 times quickly from the same IP and confirm the 429 response kicks in.
