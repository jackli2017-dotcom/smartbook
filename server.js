const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  throw new Error(
    "ADMIN_PASSWORD environment variable is required. Set it before starting the server."
  );
}
const SESSION_SECRET = process.env.SESSION_SECRET || ADMIN_PASSWORD;
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const DB_FILE = path.join(DATA_DIR, "db.json");
const SECURE_COOKIE =
  process.env.NODE_ENV === "production" || process.env.COOKIE_SECURE === "true";

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

const rateLimitMap = new Map();
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;

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

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, RATE_WINDOW_MS);

// ---------------------------------------------------------------------------
// DB write queue - serialises read-modify-write cycles
// ---------------------------------------------------------------------------

let dbWriteQueue = Promise.resolve();

function enqueueDbWrite(fn) {
  const task = dbWriteQueue.then(fn);
  dbWriteQueue = task.catch(() => {});
  return task;
}

// ---------------------------------------------------------------------------
// Storage (async)
// ---------------------------------------------------------------------------

async function ensureStorage() {
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.promises.access(DB_FILE);
  } catch (_) {
    await fs.promises.writeFile(
      DB_FILE,
      JSON.stringify(
        { nextLeadId: 1, nextEventId: 1, leads: [], events: [] },
        null,
        2
      )
    );
  }
}

async function loadDb() {
  const raw = await fs.promises.readFile(DB_FILE, "utf8");
  return JSON.parse(raw);
}

async function saveDb(db) {
  const tempFile = `${DB_FILE}.tmp`;
  await fs.promises.writeFile(tempFile, JSON.stringify(db, null, 2));
  await fs.promises.rename(tempFile, DB_FILE);
}

// ---------------------------------------------------------------------------
// Operator catalog
// ---------------------------------------------------------------------------

const operatorCatalog = {
  fanduel: {
    name: "FanDuel",
    url: "https://www.fanduel.com/",
    blurb:
      "The most polished betting app on the market, with sharp odds on mainstream sports."
  },
  draftkings: {
    name: "DraftKings",
    url: "https://sportsbook.draftkings.com/",
    blurb:
      "The widest market selection of any major book, with the best same-game parlay builder."
  },
  betmgm: {
    name: "BetMGM",
    url: "https://sports.betmgm.com/",
    blurb:
      "Strong straight-bet pricing and a built-in casino - one app for both."
  },
  caesars: {
    name: "Caesars",
    url: "https://www.caesars.com/sportsbook-and-casino",
    blurb:
      "The biggest rewards program in sports betting, backed by a legacy casino brand."
  },
  fanatics: {
    name: "Fanatics Sportsbook",
    url: "https://sportsbook.fanatics.com/",
    blurb:
      "A stripped-down app focused on earning rewards every time you bet."
  },
  kalshi: {
    name: "Kalshi",
    url: "https://kalshi.com/",
    blurb:
      "A federally regulated prediction market where you trade on real-world outcomes — politics, finance, sports, and more."
  },
  polymarket: {
    name: "Polymarket",
    url: "https://polymarket.com/",
    blurb:
      "A crypto-native prediction market with broad event coverage for users who want pure outcome trading."
  },
  bet365: {
    name: "Bet365",
    url: "https://www.bet365.com/",
    blurb:
      "One of the world's largest sportsbooks with sharp lines, deep markets, and fast payouts."
  }
};

// ---------------------------------------------------------------------------
// Recommendations by segment
// ---------------------------------------------------------------------------

const recommendationsBySegment = {
  prediction: [
    {
      slug: "kalshi",
      reason:
        "The clearest first step if you want to trade outcomes directly without a traditional sportsbook flow."
    },
    {
      slug: "draftkings",
      reason:
        "The best add-on if you also want full sportsbook coverage for sports and props."
    },
    {
      slug: "polymarket",
      reason:
        "A strong second prediction-market option if you want broader event coverage and more outcome variety."
    }
  ],
  casual: [
    {
      slug: "fanduel",
      reason:
        "Fast to open, fast to bet — fits a weekend routine without demanding your attention."
    },
    {
      slug: "betmgm",
      reason:
        "A practical all-in-one pick if you want sports and casino access in a single account."
    },
    {
      slug: "caesars",
      reason:
        "Worth comparing if ongoing rewards matter and you want extra value from lighter betting."
    }
  ],
  high_value: [
    {
      slug: "draftkings",
      reason:
        "Top-tier promos and the deepest market selection — maximises value for active, high-intent bettors."
    },
    {
      slug: "fanduel",
      reason:
        "The sharpest mainstream book with fast bet placement — a must-have second account for line shopping."
    },
    {
      slug: "betmgm",
      reason:
        "A useful third option to compare prices and keep more than one solid book in rotation."
    }
  ],
  sharp: [
    {
      slug: "betmgm",
      reason:
        "The best first stop here if you care about cleaner pricing, faster execution, and a more serious betting setup."
    },
    {
      slug: "draftkings",
      reason:
        "A strong comparison book for line shopping and broader alt-line coverage."
    },
    {
      slug: "fanduel",
      reason:
        "Another smart account to keep open when you want one more clean price-check before placing a bet."
    }
  ]
};

// ---------------------------------------------------------------------------
// Segment copy — headlines + intros for results page
// ---------------------------------------------------------------------------

const segmentCopy = {
  prediction: {
    headline: "Your best fit is a prediction-market route",
    intro:
      "Based on your answers, prediction markets look like the fastest path to a better fit. These picks make it easier to trade outcomes directly and start with platforms that match how you actually want to bet."
  },
  casual: {
    headline: "3 sportsbooks that keep it simple",
    intro:
      "You bet on your own schedule without overthinking it. These books are clean, reliable, and won't waste your time."
  },
  high_value: {
    headline: "3 sportsbooks built for high-value bettors",
    intro:
      "Your profile points to a bettor who's serious about value. These books give you the best combination of promos, market depth, and line quality to maximize every session."
  },
  sharp: {
    headline: "3 sportsbooks for sharp bettors",
    intro:
      "You look more value-driven and experienced than the average bettor. These books are the best fit for stronger pricing, cleaner execution, and longer-term use."
  }
};

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

const questions = [
  {
    key: "market_type",
    label: "What type of platform are you looking for?",
    type: "radio",
    options: [
      { value: "sportsbook", label: "Traditional sportsbook" },
      { value: "prediction", label: "Prediction market" },
      { value: "both", label: "Open to both" },
      { value: "unsure", label: "Not sure yet" }
    ]
  },
  {
    key: "interest",
    label: "What are you most interested in betting on?",
    type: "radio",
    options: [
      { value: "sports", label: "Sports" },
      { value: "politics", label: "Politics & elections" },
      { value: "finance", label: "Finance & stocks" },
      { value: "mixed", label: "Mix of everything" }
    ]
  },
  {
    key: "experience",
    label: "How experienced are you?",
    type: "radio",
    options: [
      { value: "new", label: "Brand new" },
      { value: "casual", label: "Some experience" },
      { value: "regular", label: "Very experienced" }
    ]
  },
  {
    key: "intent",
    label: "What is your main goal?",
    type: "radio",
    options: [
      { value: "profit", label: "Make money consistently" },
      { value: "fun", label: "Have fun and stay engaged" },
      { value: "opinion", label: "Back my opinion on outcomes" },
      { value: "try", label: "Just exploring options" }
    ]
  },
  {
    key: "state",
    label: "What state are you in?",
    type: "select",
    options: []
  }
];

const US_STATES = [
  "Alabama",
  "Alaska",
  "Arizona",
  "Arkansas",
  "California",
  "Colorado",
  "Connecticut",
  "Delaware",
  "District of Columbia",
  "Florida",
  "Georgia",
  "Hawaii",
  "Idaho",
  "Illinois",
  "Indiana",
  "Iowa",
  "Kansas",
  "Kentucky",
  "Louisiana",
  "Maine",
  "Maryland",
  "Massachusetts",
  "Michigan",
  "Minnesota",
  "Mississippi",
  "Missouri",
  "Montana",
  "Nebraska",
  "Nevada",
  "New Hampshire",
  "New Jersey",
  "New Mexico",
  "New York",
  "North Carolina",
  "North Dakota",
  "Ohio",
  "Oklahoma",
  "Oregon",
  "Pennsylvania",
  "Rhode Island",
  "South Carolina",
  "South Dakota",
  "Tennessee",
  "Texas",
  "Utah",
  "Vermont",
  "Virginia",
  "Washington",
  "West Virginia",
  "Wisconsin",
  "Wyoming"
];

const STATES_WITH_LEGAL_ONLINE_SPORTSBOOK = new Set([
  "Arizona",
  "Colorado",
  "Connecticut",
  "Illinois",
  "Indiana",
  "Iowa",
  "Kansas",
  "Kentucky",
  "Louisiana",
  "Maine",
  "Maryland",
  "Massachusetts",
  "Michigan",
  "New Hampshire",
  "New Jersey",
  "New York",
  "North Carolina",
  "Ohio",
  "Oregon",
  "Pennsylvania",
  "Rhode Island",
  "Tennessee",
  "Vermont",
  "Virginia",
  "West Virginia",
  "Wyoming",
  "District of Columbia"
]);

questions.find((question) => question.key === "state").options = US_STATES;

function isSportsbookLegal(state) {
  return STATES_WITH_LEGAL_ONLINE_SPORTSBOOK.has(state);
}

// ---------------------------------------------------------------------------
// Option helpers — questions may use {value, label} objects or plain strings
// ---------------------------------------------------------------------------

function getOptionValue(opt) {
  return typeof opt === "object" && opt !== null ? opt.value : opt;
}

function getOptionLabel(opt) {
  return typeof opt === "object" && opt !== null ? opt.label : opt;
}

const utmKeys = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content"
];

// ---------------------------------------------------------------------------
// LTV scoring, segmentation, and routing
// ---------------------------------------------------------------------------

function computeLTV({ intent, experience, market_type }) {
  let score = 0;
  if (intent === "profit") score += 2;
  else if (intent === "fun") score += 1;

  if (experience === "casual") score += 1;
  else if (experience === "regular") score += 2;

  if (market_type === "prediction" || market_type === "both") score += 1;

  return score;
}

function assignSegment({
  intent,
  interest,
  experience,
  ltv_score,
  market_type
}) {
  if (market_type === "sportsbook") {
    if (ltv_score >= 4 && experience === "regular" && intent === "profit") {
      return "sharp";
    }
    if (ltv_score >= 3) {
      return "high_value";
    }
    return "casual";
  }

  if (market_type === "prediction") {
    return "prediction";
  }

  if (
    market_type === "both" &&
    (interest === "politics" || interest === "finance" || intent === "opinion")
  ) {
    return "prediction";
  }

  if (
    market_type === "unsure" &&
    (intent === "opinion" || interest === "politics" || interest === "finance")
  ) {
    return "prediction";
  }

  if (ltv_score >= 4 && experience === "regular" && intent === "profit") {
    return "sharp";
  }

  if (ltv_score >= 3) {
    return "high_value";
  }

  return "casual";
}

function routeUser(segment, { interest, market_type } = {}) {
  let route;
  switch (segment) {
    case "prediction":
      route = {
        primary_route: "kalshi",
        secondary_route:
          interest === "sports" || interest === "mixed" ? "draftkings" : "polymarket"
      };
      break;
    case "sharp":
      route = { primary_route: "betmgm", secondary_route: "draftkings" };
      break;
    case "high_value":
      route = { primary_route: "draftkings", secondary_route: "fanduel" };
      break;
    case "casual":
      route = { primary_route: "fanduel", secondary_route: "draftkings" };
      break;
    default:
      route = { primary_route: "fanduel", secondary_route: "draftkings" };
      break;
  }

  if (market_type === "both" && segment !== "prediction") {
    route.secondary_route = "kalshi";
  }

  return route;
}

function determineSegment(answers) {
  const ltv_score = computeLTV({
    intent: answers.intent,
    experience: answers.experience,
    market_type: answers.market_type
  });
  return assignSegment({
    intent: answers.intent,
    interest: answers.interest,
    experience: answers.experience,
    ltv_score,
    market_type: answers.market_type
  });
}

function determineRoutingProfile(answers) {
  const ltv_score = computeLTV({
    intent: answers.intent,
    experience: answers.experience,
    market_type: answers.market_type
  });
  const segment = assignSegment({
    intent: answers.intent,
    interest: answers.interest,
    experience: answers.experience,
    ltv_score,
    market_type: answers.market_type
  });
  return { ltv_score, segment };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  return raw.split(";").reduce((acc, part) => {
    const [key, ...rest] = part.trim().split("=");
    if (!key) return acc;
    acc[key] = decodeURIComponent(rest.join("=") || "");
    return acc;
  }, {});
}

function toBase64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(input) {
  const normalized = String(input || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, "base64").toString("utf8");
}

function signValue(value) {
  return crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(value)
    .digest("base64url");
}

function defaultSession() {
  return {
    csrfToken: crypto.randomBytes(18).toString("hex"),
    quizAnswers: {},
    quizStarted: false,
    resultsTrackedForLeadId: null,
    currentLeadId: null,
    utms: {},
    isAdmin: false
  };
}

function loadSessionFromCookie(req) {
  const cookies = parseCookies(req);
  const raw = cookies.smartbook_session;
  if (!raw) return defaultSession();

  const [payload, signature] = raw.split(".");
  if (!payload || !signature || signValue(payload) !== signature) {
    return defaultSession();
  }

  try {
    const session = JSON.parse(fromBase64Url(payload));
    return {
      ...defaultSession(),
      ...session,
      quizAnswers: session.quizAnswers || {},
      utms: session.utms || {}
    };
  } catch (_) {
    return defaultSession();
  }
}

function serializeSessionCookie(session) {
  const payload = toBase64Url(
    JSON.stringify({
      csrfToken: session.csrfToken,
      quizAnswers: session.quizAnswers || {},
      quizStarted: Boolean(session.quizStarted),
      resultsTrackedForLeadId: session.resultsTrackedForLeadId || null,
      currentLeadId: session.currentLeadId || null,
      utms: session.utms || {},
      isAdmin: Boolean(session.isAdmin)
    })
  );
  const signature = signValue(payload);
  const secure = SECURE_COOKIE ? "; Secure" : "";
  return `smartbook_session=${payload}.${signature}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`;
}

function getSession(req, res) {
  const session = loadSessionFromCookie(req);
  const originalWriteHead = res.writeHead.bind(res);
  const originalEnd = res.end.bind(res);

  res.writeHead = function patchedWriteHead(...args) {
    if (!res.getHeader("Set-Cookie")) {
      res.setHeader("Set-Cookie", serializeSessionCookie(session));
    }
    return originalWriteHead(...args);
  };

  res.end = function patchedEnd(...args) {
    if (!res.headersSent && !res.getHeader("Set-Cookie")) {
      res.setHeader("Set-Cookie", serializeSessionCookie(session));
    }
    return originalEnd(...args);
  };

  return session;
}

function csrfField(session) {
  return `<input type="hidden" name="_csrf" value="${escapeHtml(
    session.csrfToken
  )}" />`;
}

function validateCsrf(form, session) {
  return form._csrf && session.csrfToken && form._csrf === session.csrfToken;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > 1_000_000) reject(new Error("Request body too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function parseForm(body) {
  const params = new URLSearchParams(body);
  return Object.fromEntries(params.entries());
}

function pickUtms(searchParams) {
  const utms = {};
  for (const key of utmKeys) {
    const value = (searchParams.get(key) || "").trim();
    if (value) utms[key] = value;
  }
  return utms;
}

function rememberUtms(session, searchParams) {
  const incoming = pickUtms(searchParams);
  if (Object.keys(incoming).length > 0) {
    session.utms = { ...(session.utms || {}), ...incoming };
  }
}

function redirect(res, location) {
  res.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store"
  });
  res.end();
}

function sendHtml(res, html, statusCode = 200) {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  });
  res.end(html);
}

function sendText(
  res,
  text,
  statusCode = 200,
  contentType = "text/plain; charset=utf-8"
) {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(text);
}

function sendFile(res, filePath) {
  if (!fs.existsSync(filePath)) {
    sendText(res, "Not found", 404);
    return;
  }
  const ext = path.extname(filePath);
  const types = {
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml"
  };
  res.writeHead(200, {
    "Content-Type": types[ext] || "application/octet-stream"
  });
  fs.createReadStream(filePath).pipe(res);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function formatField(value, fallback = "None") {
  const text = String(value || "").trim();
  return text || fallback;
}

function getLeadAnswer(lead, key, fallback = "") {
  if (lead && lead[key] != null && lead[key] !== "") return lead[key];
  if (lead && lead.answers && lead.answers[key] != null && lead.answers[key] !== "") {
    return lead.answers[key];
  }
  return fallback;
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "";
}

// ---------------------------------------------------------------------------
// DB mutations (all queued for serialisation)
// ---------------------------------------------------------------------------

async function trackEvent(type, leadId, metadata = {}) {
  return enqueueDbWrite(async () => {
    const db = await loadDb();
    db.events.push({
      id: db.nextEventId++,
      type,
      leadId: leadId || null,
      metadata,
      createdAt: new Date().toISOString()
    });
    await saveDb(db);
  });
}

async function createLead(answers) {
  return enqueueDbWrite(async () => {
    const db = await loadDb();
    const { utms = {}, ...answerValues } = answers;
    const createdAt = new Date().toISOString();
    const ltv_score = computeLTV({
      intent: answers.intent,
      experience: answers.experience,
      market_type: answers.market_type
    });
    const segment = assignSegment({
      intent: answers.intent,
      interest: answers.interest,
      experience: answers.experience,
      ltv_score,
      market_type: answers.market_type
    });
    const { primary_route, secondary_route } = routeUser(segment, {
      interest: answers.interest,
      market_type: answers.market_type
    });
    const lead = {
      id: db.nextLeadId++,
      user_id: crypto.randomUUID(),
      email: "",
      created_at: createdAt,
      intent: answers.intent,
      experience: answers.experience,
      frequency: answers.frequency || "occasional",
      bet_type: answers.bet_type || "unsure",
      interest: answers.interest,
      market_type: answers.market_type,
      state: answers.state || "",
      state_override: Boolean(answers.state_override),
      segment,
      ltv_score,
      primary_route,
      secondary_route,
      clicked_primary: false,
      clicked_secondary: false,
      answers: answerValues,
      utms,
      clickedOperators: [],
      createdAt
    };
    db.leads.push(lead);
    db.events.push({
      id: db.nextEventId++,
      type: "quiz_complete",
      leadId: lead.id,
      metadata: { segment },
      createdAt: new Date().toISOString()
    });
    await saveDb(db);
    return lead;
  });
}

async function updateLead(leadId, updater) {
  return enqueueDbWrite(async () => {
    const db = await loadDb();
    const lead = db.leads.find((item) => item.id === leadId);
    if (!lead) return null;
    updater(lead);
    await saveDb(db);
    return lead;
  });
}

async function getLead(leadId) {
  const db = await loadDb();
  return db.leads.find((item) => item.id === leadId) || null;
}

async function requireLead(session, res) {
  if (!session.currentLeadId) {
    redirect(res, "/quiz/1");
    return null;
  }
  const lead = await getLead(session.currentLeadId);
  if (!lead) {
    redirect(res, "/quiz/1");
    return null;
  }
  return lead;
}

// ---------------------------------------------------------------------------
// Personalised results copy
// ---------------------------------------------------------------------------

function getLeadPreferences(lead) {
  const details = [];
  const marketType = getLeadAnswer(lead, "market_type");
  const interest = getLeadAnswer(lead, "interest");
  const experience = getLeadAnswer(lead, "experience");
  const intent = getLeadAnswer(lead, "intent");
  const state = getLeadAnswer(lead, "state");

  if (marketType === "prediction") details.push("a prediction-market-first mindset");
  else if (marketType === "both") details.push("keeping both sportsbooks and prediction markets open");

  if (interest === "sports") details.push("sports-focused betting");
  else if (interest === "politics") details.push("politics and election markets");
  else if (interest === "finance") details.push("finance and macro outcome markets");

  if (experience === "new") details.push("a beginner-friendly setup");
  else if (experience === "regular") details.push("an experienced betting profile");

  if (intent === "profit") details.push("a value-first approach");
  else if (intent === "fun") details.push("a lighter, entertainment-first style");

  if (state) details.push(`being located in ${state}`);

  return details.slice(0, 2);
}

function buildRecommendationCopy(lead, operator, baseReason) {
  const snippets = [];
  const experience = getLeadAnswer(lead, "experience");
  const intent = getLeadAnswer(lead, "intent");
  const interest = getLeadAnswer(lead, "interest");
  const marketType = getLeadAnswer(lead, "market_type");
  const state = getLeadAnswer(lead, "state");
  const stateOverride = Boolean(lead.state_override);

  if (experience === "new") {
    snippets.push("Your answers suggest you want a smoother first-time experience.");
  }
  if (intent === "profit" && ["draftkings", "betmgm", "bet365"].includes(operator.slug)) {
    snippets.push("That matches a more value-driven approach where pricing and staying power matter.");
  }
  if (intent === "opinion" && operator.slug === "kalshi") {
    snippets.push("Kalshi is built for taking a clear position on what you think happens next.");
  }
  if (interest === "politics" && operator.slug === "kalshi") {
    snippets.push("It covers political and election markets in a way no traditional sportsbook does.");
  }
  if (interest === "finance" && operator.slug === "kalshi") {
    snippets.push("Finance and economic outcome markets are a Kalshi specialty.");
  }
  if (marketType === "prediction" && operator.slug === "kalshi") {
    snippets.push("You said you want a prediction market specifically, and this is the cleanest regulated fit.");
  }
  if (marketType === "both" && operator.slug === "kalshi") {
    snippets.push("Because you are open to both, this gives you a prediction-market lane alongside a regular sportsbook.");
  }
  if (operator.slug === "polymarket") {
    snippets.push("It is worth opening if you want another outcome-trading option before deciding where to start.");
  }
  if (interest === "sports" && operator.slug === "draftkings") {
    snippets.push("It is a strong click if you want deeper sports markets and broader game coverage right away.");
  }
  if (interest === "sports" && operator.slug === "fanduel") {
    snippets.push("It is one of the fastest mainstream apps to get through if you want to start betting quickly.");
  }
  if (stateOverride && operator.slug === "kalshi") {
    snippets.push(`Because online sportsbooks are limited in ${state}, this is the most accessible fit right now.`);
  }
  if (state && !stateOverride && ["fanduel", "draftkings", "betmgm"].includes(operator.slug)) {
    snippets.push(`Assuming standard availability in ${state}, this should be a straightforward option to try.`);
  }

  return [baseReason, ...snippets].slice(0, 3);
}

// ---------------------------------------------------------------------------
// Admin helpers
// ---------------------------------------------------------------------------

function isAdmin(session) {
  return session && session.isAdmin;
}

async function buildCsv() {
  const db = await loadDb();
  const headers = [
    "id",
    "email",
    "segment",
    "user_id",
    "market_type",
    "state",
    "state_override",
    "primary_route",
    "secondary_route",
    "clicked_primary",
    "clicked_secondary",
    "ltv_score",
    "intent",
    "experience",
    "frequency",
    "bet_type",
    "interest",
    "topPriority",
    "startingDeposit",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "clickedOperators",
    "createdAt"
  ];

  const quote = (v) => '"' + String(v || "").replace(/"/g, '""') + '"';
  const lines = [
    headers.join(","),
    ...db.leads.map((lead) =>
      [
        lead.id,
        lead.email,
        lead.segment,
        lead.user_id || "",
        getLeadAnswer(lead, "market_type", ""),
        getLeadAnswer(lead, "state", ""),
        lead.state_override === true ? "true" : "false",
        lead.primary_route || "",
        lead.secondary_route || "",
        lead.clicked_primary === true ? "true" : "false",
        lead.clicked_secondary === true ? "true" : "false",
        lead.ltv_score != null ? lead.ltv_score : "",
        getLeadAnswer(lead, "intent", ""),
        getLeadAnswer(lead, "experience", ""),
        getLeadAnswer(lead, "frequency", ""),
        getLeadAnswer(lead, "bet_type", ""),
        getLeadAnswer(lead, "interest", ""),
        getLeadAnswer(lead, "topPriority", ""),
        getLeadAnswer(lead, "startingDeposit", ""),
        formatField(lead.utms?.utm_source, ""),
        formatField(lead.utms?.utm_medium, ""),
        formatField(lead.utms?.utm_campaign, ""),
        formatField(lead.utms?.utm_term, ""),
        formatField(lead.utms?.utm_content, ""),
        (Array.isArray(lead.clickedOperators) ? lead.clickedOperators : [])
          .map((slug) => operatorCatalog[slug]?.name || slug)
          .join("|"),
        lead.createdAt || lead.created_at || ""
      ]
        .map(quote)
        .join(",")
    )
  ];

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// HTML renderers
// ---------------------------------------------------------------------------

function renderLayout(title, content) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)} | Smartbook</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <a class="brand" href="/">Smartbook</a>
    </header>
    ${content}
  </div>
</body>
</html>`;
}

function renderLandingPage() {
  return renderLayout(
    "Smartbook",
    `<main class="hero">
      <section class="hero-card">
        <span class="eyebrow">Sportsbook quiz</span>
        <h1>Find the best sportsbook for you in 60 seconds</h1>
        <p>Answer a few quick questions, unlock tailored recommendations, and compare the books that fit your style.</p>
        <div class="hero-actions">
          <a class="button button-primary" href="/start">Start Quiz</a>
        </div>
      </section>
    </main>`
  );
}

function renderQuizStep(step, session) {
  const question = questions[step - 1];
  const answers = session.quizAnswers || {};
  const shouldAskState =
    step === 5 ||
    (answers.market_type &&
      answers.interest &&
      answers.experience &&
      answers.intent &&
      determineSegment(answers) !== "prediction");
  const total = shouldAskState ? 5 : 4;
  const percent = Math.round((step / total) * 100);
  const currentValue = answers[question.key] || "";
  const isLast = step === total;

  let optionsHtml;
  if (question.type === "select") {
    optionsHtml = `<select id="${question.key}" name="${question.key}" required>
      <option value="">Select one</option>
      ${question.options
        .map(
          (opt) => {
            const val = getOptionValue(opt);
            const lbl = getOptionLabel(opt);
            return `<option value="${escapeHtml(val)}" ${
              currentValue === val ? "selected" : ""
            }>${escapeHtml(lbl)}</option>`;
          }
        )
        .join("")}
    </select>`;
  } else {
    optionsHtml = `<div class="option-list">
      ${question.options
        .map(
          (opt) => {
            const val = getOptionValue(opt);
            const lbl = getOptionLabel(opt);
            return `<label class="option-pill">
            <input type="radio" name="${question.key}" value="${escapeHtml(val)}" ${currentValue === val ? "checked" : ""} required />
            <span>${escapeHtml(lbl)}</span>
          </label>`;
          }
        )
        .join("")}
    </div>`;
  }

  return renderLayout(
    `Question ${step}`,
    `<main class="content-stack narrow">
      <section class="progress-wrap" aria-label="Progress">
        <div class="progress-meta">
          <span class="eyebrow">Question ${step} of ${total}</span>
        </div>
        <div class="progress-track">
          <span class="progress-fill" style="width: ${percent}%"></span>
        </div>
      </section>
      <form method="POST" action="/quiz/${step}" class="stack-form">
        ${csrfField(session)}
        <section class="question-card">
          <span class="question-number">Question ${step}</span>
          <strong>${escapeHtml(question.label)}</strong>
          ${optionsHtml}
        </section>
        <div class="quiz-nav">
          ${
            step > 1
              ? `<a class="button button-secondary" href="/quiz/${
                  step - 1
                }">Back</a>`
              : "<span></span>"
          }
          <button class="button button-primary" type="submit">${
            isLast ? "See my results" : "Continue"
          }</button>
        </div>
      </form>
    </main>`
  );
}

function renderEmailPage(session, error = "") {
  return renderLayout(
    "Almost there",
    `<main class="content-stack narrow">
      <section class="progress-wrap" aria-label="Progress">
        <div class="progress-meta">
          <span class="eyebrow">Almost there</span>
        </div>
        <div class="progress-track">
          <span class="progress-fill" style="width: 90%"></span>
        </div>
      </section>
      <section class="page-intro">
        <h1>Your results are ready</h1>
        <p>We matched you with your best-fit operators based on your answers. Enter your email to unlock your personalised picks.</p>
      </section>
      ${error ? `<p class="notice notice-error">${escapeHtml(error)}</p>` : ""}
      <form method="POST" action="/email" class="stack-form">
        ${csrfField(session)}
        <section class="question-card">
          <label for="email"><strong>Email address</strong></label>
          <input
            id="email"
            name="email"
            type="email"
            placeholder="you@example.com"
            autocomplete="email"
            inputmode="email"
            required
          />
        </section>
        <button class="button button-primary button-wide" type="submit">See my results</button>
      </form>
    </main>`
  );
}

function renderAnalyzingPage() {
  return renderLayout(
    "Analyzing",
    `<main class="content-stack narrow">
      <section class="progress-wrap" aria-label="Progress">
        <div class="progress-meta">
          <span class="eyebrow">Analyzing</span>
        </div>
        <div class="progress-track">
          <span class="progress-fill" style="width: 95%"></span>
        </div>
      </section>
      <section class="analysis-card">
        <div class="analysis-orb" aria-hidden="true">
          <span></span><span></span><span></span>
        </div>
        <span class="eyebrow">Analyzing</span>
        <h1>Matching your betting profile...</h1>
        <p>Comparing your answers across goals, betting style, and preferences to find the best-fit books.</p>
        <div class="analysis-meter" aria-hidden="true">
          <span class="analysis-meter-bar"></span>
        </div>
      </section>
      <script>
        window.setTimeout(function () {
          window.location.href = "/results";
        }, 1100);
      </script>
    </main>`
  );
}

function renderResultsPage(lead) {
  const segmentRecommendations =
    recommendationsBySegment[lead.segment] || recommendationsBySegment.casual;
  const copy = segmentCopy[lead.segment] || segmentCopy.casual;
  const primaryRoute = lead.primary_route || null;
  const secondaryRoute = lead.secondary_route || null;
  const orderedSlugs = [];

  if (primaryRoute && operatorCatalog[primaryRoute]) orderedSlugs.push(primaryRoute);
  if (
    secondaryRoute &&
    operatorCatalog[secondaryRoute] &&
    !orderedSlugs.includes(secondaryRoute)
  ) {
    orderedSlugs.push(secondaryRoute);
  }
  for (const item of segmentRecommendations) {
    if (!orderedSlugs.includes(item.slug) && operatorCatalog[item.slug]) {
      orderedSlugs.push(item.slug);
    }
  }

  const recommendationLimit =
    lead.segment === "prediction" && !secondaryRoute
      ? 1
      : secondaryRoute
        ? 3
        : 2;
  const recommendations = orderedSlugs.slice(0, recommendationLimit).map((slug) => {
    const base =
      segmentRecommendations.find((item) => item.slug === slug) || {
        slug,
        reason: operatorCatalog[slug]?.blurb || ""
      };
    return base;
  });

  const cards = recommendations
    .map((item, index) => {
      const operator = { ...operatorCatalog[item.slug], slug: item.slug };
      const personalizedLines = buildRecommendationCopy(
        lead,
        operator,
        item.reason
      )
        .map((line) => `<li>${escapeHtml(line)}</li>`)
        .join("");

      const isBestMatch = index === 0;
      const ctaText = isBestMatch
        ? `Open ${operator.name}`
        : `Compare ${operator.name} now`;
      const cardClass = isBestMatch
        ? "result-card result-card-featured"
        : "result-card";
      const badge = isBestMatch
        ? '<span class="best-match-badge">Best match</span>'
        : "";
      const btnClass = isBestMatch ? "button-primary" : "button-secondary";

      return `<article class="${cardClass}">
        <div class="result-copy">
          ${badge}
          <h2>${escapeHtml(operator.name)}</h2>
          <ul class="result-points">${personalizedLines}</ul>
          <p class="muted">${escapeHtml(operator.blurb)}</p>
        </div>
        <a class="button ${btnClass}" href="/out/${item.slug}">${escapeHtml(
        ctaText
      )}</a>
      </article>`;
    })
    .join("");

  return renderLayout(
    "Your results",
    `<main class="content-stack">
      <section class="progress-wrap" aria-label="Progress">
        <div class="progress-meta">
          <span class="eyebrow">Your results</span>
        </div>
        <div class="progress-track">
          <span class="progress-fill" style="width: 100%"></span>
        </div>
      </section>
      <section class="page-intro">
        <h1>${escapeHtml(copy.headline)}</h1>
        <p>${escapeHtml(copy.intro)}</p>
      </section>
      ${
        lead.state_override
          ? `<p class="notice">Online sportsbooks appear limited in ${escapeHtml(
              getLeadAnswer(lead, "state", "your state")
            )}, so we prioritized prediction-market options that should be more accessible.</p>`
          : ""
      }
      <section class="results-grid">
        ${cards}
      </section>
      <div class="retake-wrap">
        <a class="retake-link" href="/start">Retake quiz</a>
      </div>
    </main>`
  );
}

function renderAdminLogin(session, error = "") {
  return renderLayout(
    "Admin Login",
    `<main class="content-stack narrow">
      <section class="page-intro">
        <span class="eyebrow">Admin</span>
        <h1>Dashboard access</h1>
        <p>Enter the admin password to review leads and export data.</p>
      </section>
      ${error ? `<p class="notice notice-error">${escapeHtml(error)}</p>` : ""}
      <form method="POST" action="/admin/login" class="stack-form">
        ${csrfField(session)}
        <section class="question-card">
          <label for="password"><strong>Password</strong></label>
          <input id="password" name="password" type="password" autocomplete="current-password" required />
        </section>
        <button class="button button-primary button-wide" type="submit">Enter dashboard</button>
      </form>
    </main>`
  );
}

async function renderAdminDashboard() {
  const db = await loadDb();

  const starts = db.events.filter((e) => e.type === "quiz_start").length;
  const completions = db.events.filter(
    (e) => e.type === "quiz_complete"
  ).length;
  const emailSubmits = db.events.filter(
    (e) => e.type === "email_submit"
  ).length;
  const resultsViews = db.events.filter(
    (e) => e.type === "results_view"
  ).length;
  const operatorClicks = db.events.filter(
    (e) => e.type === "operator_click"
  ).length;

  const funnelSteps = [
    { label: "Quiz starts", value: starts },
    { label: "Completions", value: completions },
    { label: "Email submits", value: emailSubmits },
    { label: "Results views", value: resultsViews },
    { label: "Operator clicks", value: operatorClicks }
  ];

  const funnel = funnelSteps.map((step, i) => {
    if (i === 0) return { ...step, conversion: "100%" };
    const prior = funnelSteps[i - 1].value;
    const pct =
      prior > 0 ? `${((step.value / prior) * 100).toFixed(1)}%` : "0.0%";
    return { ...step, conversion: pct };
  });

  const rows = db.leads
    .slice()
    .sort(
      (a, b) =>
        new Date(b.createdAt || b.created_at || 0) -
        new Date(a.createdAt || a.created_at || 0)
    )
    .map((lead) => {
      const legacyClicks = Array.isArray(lead.clickedOperators)
        ? lead.clickedOperators
        : [];
      const clicked = legacyClicks.length
        ? legacyClicks
            .map((slug) => operatorCatalog[slug]?.name || slug)
            .join(", ")
        : "None";
      const utmSource = lead.utms?.utm_source || "Direct";
      const marketType = getLeadAnswer(lead, "market_type", "-");
      const state = getLeadAnswer(lead, "state", "");
      const primaryRoute = lead.primary_route || "-";
      const metaBadges = [
        `market: ${marketType}`,
        state ? `state: ${state}` : "",
        lead.state_override ? "override" : "",
        `route: ${primaryRoute}`,
        lead.clicked_primary ? "clicked primary" : "",
        lead.clicked_secondary ? "clicked secondary" : ""
      ]
        .filter(Boolean)
        .join(" ");
      return `<tr>
        <td>${lead.id}</td>
        <td>${escapeHtml(lead.email || "Pending")}</td>
        <td>${escapeHtml(lead.segment || "")} <span>${escapeHtml(metaBadges)}</span></td>
        <td>${lead.ltv_score != null ? lead.ltv_score : "-"}</td>
        <td>${escapeHtml(getLeadAnswer(lead, "intent", ""))}</td>
        <td>${escapeHtml(getLeadAnswer(lead, "experience", ""))}</td>
        <td>${escapeHtml(getLeadAnswer(lead, "interest", ""))}</td>
        <td>${escapeHtml(state || "-")}</td>
        <td>${escapeHtml(utmSource)}</td>
        <td>${escapeHtml(clicked)}</td>
        <td>${escapeHtml(
          new Date(lead.createdAt || lead.created_at || Date.now()).toLocaleString()
        )}</td>
      </tr>`;
    })
    .join("");

  const stats = {
    leads: db.leads.length,
    emails: db.leads.filter((l) => l.email).length,
    clicks: db.events.filter((e) => e.type === "operator_click").length
  };

  return renderLayout(
    "Admin Dashboard",
    `<main class="content-stack">
      <section class="page-intro">
        <span class="eyebrow">Admin</span>
        <h1>Smartbook dashboard</h1>
        <p>Track quiz completions, email captures, and operator clicks.</p>
      </section>
      <section class="stats-grid">
        <article class="stat-card"><span>Total users</span><strong>${stats.leads}</strong></article>
        <article class="stat-card"><span>Emails captured</span><strong>${stats.emails}</strong></article>
        <article class="stat-card"><span>Operator clicks</span><strong>${stats.clicks}</strong></article>
      </section>
      <section class="funnel-card">
        <div class="section-head">
          <h2>Funnel summary</h2>
          <p>Stage-by-stage conversion from the current event log.</p>
        </div>
        <div class="funnel-grid">
          ${funnel
            .map(
              (s) => `<article class="funnel-step">
                <span>${escapeHtml(s.label)}</span>
                <strong>${s.value}</strong>
                <em>${escapeHtml(s.conversion)} from prior stage</em>
              </article>`
            )
            .join("")}
        </div>
      </section>
      <div class="table-actions">
        <a class="button button-secondary" href="/admin/export.csv">Export CSV</a>
        <a class="button button-secondary" href="/admin/logout">Log out</a>
      </div>
      <section class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Email</th>
              <th>Segment</th>
              <th>LTV</th>
              <th>Intent</th>
              <th>Experience</th>
              <th>Interest</th>
              <th>State</th>
              <th>UTM source</th>
              <th>Clicked operator</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            ${
              rows ||
              '<tr><td colspan="11">No users yet. Funnel metrics will populate as traffic arrives.</td></tr>'
            }
          </tbody>
        </table>
      </section>
    </main>`
  );
}

function renderNotFound() {
  return renderLayout(
    "Not Found",
    `<main class="content-stack narrow">
      <section class="page-intro">
        <span class="eyebrow">404</span>
        <h1>Page not found</h1>
        <p>The page you're looking for doesn't exist.</p>
        <a class="button button-primary" href="/">Back home</a>
      </section>
    </main>`
  );
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const session = getSession(req, res);
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;
  rememberUtms(session, parsedUrl.searchParams);

  try {
    // ---- static assets ----

    if (pathname === "/styles.css") {
      sendFile(res, path.join(PUBLIC_DIR, "styles.css"));
      return;
    }

    if (pathname.startsWith("/public/")) {
      sendText(res, "Not found", 404);
      return;
    }

    if (req.method === "GET" && pathname === "/health") {
      sendText(
        res,
        JSON.stringify({
          ok: true,
          service: "smartbook",
          timestamp: new Date().toISOString()
        }),
        200,
        "application/json; charset=utf-8"
      );
      return;
    }

    // ---- landing ----

    if (req.method === "GET" && pathname === "/") {
      sendHtml(res, renderLandingPage());
      return;
    }

    // ---- quiz start (reset) ----

    if (req.method === "GET" && pathname === "/start") {
      session.currentLeadId = null;
      session.quizStarted = false;
      session.quizAnswers = {};
      session.resultsTrackedForLeadId = null;
      redirect(res, "/quiz/1");
      return;
    }

    // ---- quiz redirect ----

    if (req.method === "GET" && pathname === "/quiz") {
      redirect(res, "/quiz/1");
      return;
    }

    // ---- quiz step routes ----

    const quizMatch = pathname.match(/^\/quiz\/(\d+)$/);
    if (quizMatch) {
      const step = parseInt(quizMatch[1]);

      if (step < 1 || step > questions.length) {
        redirect(res, "/quiz/1");
        return;
      }

      const answers = session.quizAnswers || {};
      const answeredFirstFour =
        answers.market_type &&
        answers.interest &&
        answers.experience &&
        answers.intent;
      const preliminarySegment = answeredFirstFour
        ? determineSegment(answers)
        : null;
      const shouldAskState = preliminarySegment !== "prediction";
      const maxStep = shouldAskState ? 5 : 4;

      if (step > maxStep) {
        redirect(res, `/quiz/${maxStep}`);
        return;
      }

      for (let i = 0; i < Math.min(step - 1, 4); i++) {
        if (!answers[questions[i].key]) {
          redirect(res, `/quiz/${i + 1}`);
          return;
        }
      }
      if (step === 5 && !shouldAskState) {
        redirect(res, "/quiz/4");
        return;
      }

      if (req.method === "GET") {
        if (!session.quizStarted) {
          session.quizStarted = true;
          await trackEvent("quiz_start", null, {});
        }
        sendHtml(res, renderQuizStep(step, session));
        return;
      }

      if (req.method === "POST") {
        const ip = getClientIp(req);
        if (isRateLimited(ip)) {
          sendText(
            res,
            "Too many requests. Please wait and try again.",
            429
          );
          return;
        }

        const form = parseForm(await readBody(req));
        if (!validateCsrf(form, session)) {
          sendText(res, "Invalid or missing CSRF token.", 403);
          return;
        }

        const question = questions[step - 1];
        const answer = (form[question.key] || "").trim();
        const isValidAnswer = question.options.map(getOptionValue).includes(answer);
        if (!answer || !isValidAnswer) {
          sendHtml(res, renderQuizStep(step, session), 400);
          return;
        }

        if (!session.quizAnswers) session.quizAnswers = {};
        session.quizAnswers[question.key] = answer;

        if (step < 4) {
          redirect(res, `/quiz/${step + 1}`);
          return;
        }

        if (step === 4) {
          const routingProfile = determineRoutingProfile(session.quizAnswers);
          if (routingProfile.segment === "prediction") {
            const lead = await createLead({
              ...session.quizAnswers,
              utms: session.utms || {}
            });
            session.currentLeadId = lead.id;
            session.resultsTrackedForLeadId = null;
            redirect(res, "/email");
            return;
          }
          redirect(res, "/quiz/5");
          return;
        }

        const state = session.quizAnswers.state;
        const routingProfile = determineRoutingProfile(session.quizAnswers);
        const stateOverride = !isSportsbookLegal(state);
        const leadAnswers = {
          ...session.quizAnswers,
          state_override: stateOverride,
          utms: session.utms || {}
        };
        if (stateOverride) {
          leadAnswers.market_type = "prediction";
        }

        const lead = await createLead(leadAnswers);
        if (stateOverride) {
          await updateLead(lead.id, (entry) => {
            entry.segment = "prediction";
            entry.market_type = session.quizAnswers.market_type;
            entry.answers.market_type = session.quizAnswers.market_type;
            entry.state_override = true;
            entry.ltv_score = routingProfile.ltv_score;
            const reroute = routeUser("prediction", {
              interest: session.quizAnswers.interest,
              market_type: session.quizAnswers.market_type
            });
            entry.primary_route = reroute.primary_route;
            entry.secondary_route = reroute.secondary_route;
          });
          await trackEvent("state_override", lead.id, {
            state,
            market_type: session.quizAnswers.market_type,
            interest: session.quizAnswers.interest,
            preliminary_segment: routingProfile.segment
          });
        }

        session.currentLeadId = lead.id;
        session.resultsTrackedForLeadId = null;
        redirect(res, "/email");
        return;
      }
    }

    // ---- email gate ----

    if (req.method === "GET" && pathname === "/email") {
      const lead = await requireLead(session, res);
      if (!lead) return;
      if (lead.email) {
        redirect(res, "/results");
        return;
      }
      sendHtml(res, renderEmailPage(session));
      return;
    }

    if (req.method === "POST" && pathname === "/email") {
      const ip = getClientIp(req);
      if (isRateLimited(ip)) {
        sendText(res, "Too many requests. Please wait and try again.", 429);
        return;
      }

      const lead = await requireLead(session, res);
      if (!lead) return;

      const form = parseForm(await readBody(req));
      if (!validateCsrf(form, session)) {
        sendText(res, "Invalid or missing CSRF token.", 403);
        return;
      }

      const email = (form.email || "").trim();
      const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

      if (!validEmail) {
        sendHtml(
          res,
          renderEmailPage(session, "Please enter a valid email address."),
          400
        );
        return;
      }

      await updateLead(lead.id, (entry) => {
        entry.email = normalizeEmail(email);
      });
      await trackEvent("email_submit", lead.id, {
        email: normalizeEmail(email)
      });
      redirect(res, "/analyzing");
      return;
    }

    // ---- analyzing interstitial ----

    if (req.method === "GET" && pathname === "/analyzing") {
      const lead = await requireLead(session, res);
      if (!lead) return;
      if (!lead.email) {
        redirect(res, "/email");
        return;
      }
      sendHtml(res, renderAnalyzingPage());
      return;
    }

    // ---- results ----

    if (req.method === "GET" && pathname === "/results") {
      const lead = await requireLead(session, res);
      if (!lead) return;
      if (!lead.email) {
        redirect(res, "/email");
        return;
      }
      if (session.resultsTrackedForLeadId !== lead.id) {
        session.resultsTrackedForLeadId = lead.id;
        await trackEvent("results_view", lead.id, { segment: lead.segment });
      }
      sendHtml(res, renderResultsPage(lead));
      return;
    }

    // ---- outbound click ----

    if (req.method === "GET" && pathname.startsWith("/out/")) {
      const lead = await requireLead(session, res);
      if (!lead) return;
      if (!lead.email) {
        redirect(res, "/email");
        return;
      }

      const slug = pathname.split("/").pop();
      const operator = operatorCatalog[slug];
      if (!operator) {
        sendHtml(res, renderNotFound(), 404);
        return;
      }

      await updateLead(lead.id, (entry) => {
        if (!Array.isArray(entry.clickedOperators)) {
          entry.clickedOperators = [];
        }
        if (!entry.clickedOperators.includes(slug)) {
          entry.clickedOperators.push(slug);
        }
        if (slug === entry.primary_route) entry.clicked_primary = true;
        if (slug === entry.secondary_route) entry.clicked_secondary = true;
      });
      const routePosition =
        slug === lead.primary_route
          ? "primary"
          : slug === lead.secondary_route
            ? "secondary"
            : "other";
      await trackEvent("operator_click", lead.id, {
        operator: slug,
        route_position: routePosition
      });
      redirect(res, operator.url);
      return;
    }

    // ---- admin ----

    if (req.method === "GET" && pathname === "/admin") {
      if (isAdmin(session)) {
        sendHtml(res, await renderAdminDashboard());
      } else {
        sendHtml(res, renderAdminLogin(session));
      }
      return;
    }

    if (req.method === "POST" && pathname === "/admin/login") {
      const form = parseForm(await readBody(req));
      if (!validateCsrf(form, session)) {
        sendText(res, "Invalid or missing CSRF token.", 403);
        return;
      }
      if ((form.password || "") !== ADMIN_PASSWORD) {
        sendHtml(
          res,
          renderAdminLogin(session, "Incorrect password."),
          401
        );
        return;
      }
      session.isAdmin = true;
      redirect(res, "/admin");
      return;
    }

    if (req.method === "GET" && pathname === "/admin/logout") {
      session.isAdmin = false;
      redirect(res, "/admin");
      return;
    }

    if (req.method === "GET" && pathname === "/admin/export.csv") {
      if (!isAdmin(session)) {
        redirect(res, "/admin");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="smartbook-leads.csv"'
      });
      res.end(await buildCsv());
      return;
    }

    // ---- fallback ----

    sendHtml(res, renderNotFound(), 404);
  } catch (error) {
    console.error("Server error:", error);
    sendHtml(
      res,
      renderLayout(
        "Error",
        `<main class="content-stack narrow">
          <section class="page-intro">
            <span class="eyebrow">Error</span>
            <h1>Something went wrong</h1>
            <p>${escapeHtml(error.message || "Unknown server error.")}</p>
          </section>
        </main>`
      ),
      500
    );
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

ensureStorage()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Smartbook running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialise storage:", err);
    process.exit(1);
  });
