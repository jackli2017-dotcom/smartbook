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
  }
};

// ---------------------------------------------------------------------------
// Recommendations by segment
// ---------------------------------------------------------------------------

const recommendationsBySegment = {
  Beginner: [
    {
      slug: "fanduel",
      reason:
        "The app is the easiest to learn - most new bettors place their first bet here."
    },
    {
      slug: "fanatics",
      reason:
        "Earn rewards from your very first wager, with no learning curve to slow you down."
    },
    {
      slug: "betmgm",
      reason:
        "Try slots or table games alongside sports if you want variety while you're learning."
    }
  ],
  Casual: [
    {
      slug: "fanduel",
      reason:
        "Fast to open, fast to bet - fits a weekend routine without demanding your attention."
    },
    {
      slug: "betmgm",
      reason:
        "One app for sports and casino means fewer accounts to manage."
    },
    {
      slug: "caesars",
      reason:
        "Caesars Rewards points stack up even from casual play, which other books do not match."
    }
  ],
  Frequent: [
    {
      slug: "draftkings",
      reason:
        "More markets per game than any competitor - you will not run out of angles."
    },
    {
      slug: "fanduel",
      reason:
        "Fastest bet placement flow of the major books, built for volume."
    },
    {
      slug: "betmgm",
      reason:
        "A useful second book for line-shopping when DraftKings or FanDuel odds are off."
    }
  ],
  "Parlay-heavy": [
    {
      slug: "draftkings",
      reason:
        "The deepest same-game parlay builder - more legs, more props, more combinations."
    },
    {
      slug: "fanduel",
      reason:
        "The cleanest bet slip for stacking parlays quickly without mistakes."
    },
    {
      slug: "caesars",
      reason:
        "Parlay-specific promos show up often, which can add edge on top of your picks."
    }
  ],
  Advanced: [
    {
      slug: "draftkings",
      reason:
        "Widest market variety — alt lines, player props, and game props others don't carry."
    },
    {
      slug: "betmgm",
      reason:
        "Consistently competitive odds on straight bets, useful for line-shopping rotation."
    },
    {
      slug: "fanduel",
      reason:
        "Reliable as a daily secondary book - sharp product, few outages, fast payouts."
    }
  ]
};

// ---------------------------------------------------------------------------
// Segment copy — headlines + intros for results page
// ---------------------------------------------------------------------------

const segmentCopy = {
  Beginner: {
    headline: "3 sportsbooks built for new bettors",
    intro:
      "You're just getting started. These books make it easy to learn the ropes, deposit small, and bet without feeling overwhelmed."
  },
  Casual: {
    headline: "3 sportsbooks that keep it simple",
    intro:
      "You bet on your own schedule without overthinking it. These books are clean, reliable, and won't waste your time."
  },
  Frequent: {
    headline: "3 sportsbooks for your daily action",
    intro:
      "You're in the app most days and need speed, depth, and a product that holds up under heavy use."
  },
  "Parlay-heavy": {
    headline: "3 sportsbooks built for parlay bettors",
    intro:
      "You build combos and same-game parlays regularly. These books have the best builders and the deepest parlay markets."
  },
  Advanced: {
    headline: "3 sportsbooks for experienced bettors",
    intro:
      "You shop lines, rotate books, and know what you want. These give you the market depth and control to bet your way."
  }
};

// ---------------------------------------------------------------------------
// Questions — 8 total
// ---------------------------------------------------------------------------

const questions = [
  {
    key: "mainGoal",
    label: "What are you mainly looking for in a sportsbook?",
    type: "radio",
    options: [
      "Get the biggest bonus",
      "Find the easiest app to use",
      "Get the best odds",
      "Bet on specific sports/events"
    ]
  },
  {
    key: "sportsbookExperience",
    label: "Have you used a sportsbook before?",
    type: "radio",
    options: [
      "No, I’m new",
      "Yes, but not often",
      "Yes, regularly"
    ]
  },
  {
    key: "betFrequency",
    label: "How often do you plan to bet?",
    type: "radio",
    options: [
      "Occasionally (few times a month)",
      "Weekly",
      "Multiple times per week"
    ]
  },
  {
    key: "betPreference",
    label: "What type of bets do you usually prefer?",
    type: "radio",
    options: [
      "Parlays / Same Game Parlays",
      "Straight bets",
      "Live betting",
      "Not sure yet"
    ]
  },
  {
    key: "topPriority",
    label: "What matters most to you?",
    type: "radio",
    options: [
      "Bonuses & promotions",
      "Best odds",
      "Ease of use",
      "Fast withdrawals"
    ]
  },
  {
    key: "startingDeposit",
    label: "How much would you likely deposit to start?",
    type: "radio",
    options: ["Under $50", "$50–$200", "$200+"]
  },
  {
    key: "crossSellInterest",
    label: "Would you also be interested in casino or DFS offers?",
    type: "radio",
    options: ["Yes", "Maybe", "No"]
  },
  {
    key: "state",
    label: "What state are you in?",
    type: "select",
    options: []
  }
];

const stateOptions = [
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

questions[7].options = stateOptions;

const utmKeys = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content"
];

// ---------------------------------------------------------------------------
// Segment scoring
// ---------------------------------------------------------------------------

function determineSegment(answers) {
  const score = {
    Beginner: 0,
    Casual: 0,
    Frequent: 0,
    "Parlay-heavy": 0,
    Advanced: 0
  };

  const add = (seg, v) => {
    score[seg] += v;
  };

  if (answers.sportsbookExperience === "No, I’m new") {
    add("Beginner", 5);
    add("Casual", 2);
  }
  if (answers.sportsbookExperience === "Yes, but not often") {
    add("Casual", 4);
    add("Beginner", 1);
  }
  if (answers.sportsbookExperience === "Yes, regularly") {
    add("Frequent", 3);
    add("Advanced", 2);
    add("Advanced", 2);
  }

  if (answers.betFrequency === "Occasionally (few times a month)") {
    add("Beginner", 2);
    add("Casual", 4);
  }
  if (answers.betFrequency === "Weekly") {
    add("Casual", 2);
    add("Frequent", 2);
  }
  if (answers.betFrequency === "Multiple times per week") {
    add("Frequent", 4);
    add("Advanced", 3);
  }

  if (answers.betPreference === "Parlays / Same Game Parlays") {
    add("Parlay-heavy", 5);
  }
  if (answers.betPreference === "Straight bets") {
    add("Advanced", 3);
    add("Frequent", 1);
  }
  if (answers.betPreference === "Live betting") {
    add("Frequent", 2);
    add("Advanced", 2);
  }
  if (answers.betPreference === "Not sure yet") {
    add("Beginner", 2);
    add("Casual", 1);
  }

  if (answers.mainGoal === "Find the easiest app to use") {
    add("Beginner", 3);
    add("Casual", 2);
  }
  if (answers.mainGoal === "Get the biggest bonus") {
    add("Casual", 2);
    add("Beginner", 1);
  }
  if (answers.mainGoal === "Get the best odds") {
    add("Advanced", 3);
    add("Frequent", 2);
  }
  if (answers.mainGoal === "Bet on specific sports/events") {
    add("Frequent", 2);
    add("Advanced", 1);
  }

  if (answers.topPriority === "Ease of use") {
    add("Beginner", 2);
    add("Casual", 2);
  }
  if (answers.topPriority === "Best odds") {
    add("Advanced", 3);
    add("Frequent", 1);
  }
  if (answers.topPriority === "Bonuses & promotions") {
    add("Casual", 2);
    add("Parlay-heavy", 1);
  }
  if (answers.topPriority === "Fast withdrawals") {
    add("Frequent", 2);
    add("Advanced", 1);
  }

  if (answers.startingDeposit === "Under $50") {
    add("Beginner", 2);
    add("Casual", 1);
  }
  if (answers.startingDeposit === "$50–$200") {
    add("Casual", 2);
    add("Frequent", 1);
  }
  if (answers.startingDeposit === "$200+") {
    add("Advanced", 3);
    add("Frequent", 2);
  }

  if (answers.betPreference === "Parlays / Same Game Parlays") {
    add("Parlay-heavy", 6);
  }
  if (answers.betPreference === "Straight bets") {
    add("Advanced", 2);
    add("Frequent", 1);
  }

  if (answers.crossSellInterest === "Yes") {
    add("Casual", 2);
  }
  if (answers.crossSellInterest === "Maybe") {
    add("Casual", 1);
  }

  return Object.entries(score).sort((a, b) => b[1] - a[1])[0][0];
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
    const segment = determineSegment(answers);
    const lead = {
      id: db.nextLeadId++,
      email: "",
      segment,
      answers: answerValues,
      utms,
      clickedOperators: [],
      createdAt: new Date().toISOString()
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
  if (lead.answers.betFrequency) {
    details.push(lead.answers.betFrequency.toLowerCase());
  }
  if (lead.answers.betPreference === "Parlays / Same Game Parlays") {
    details.push("a parlay-first style");
  } else if (lead.answers.betPreference === "Straight bets") {
    details.push("a straight-bet lean");
  }
  if (lead.answers.topPriority) {
    details.push(`${lead.answers.topPriority.toLowerCase()} as your top priority`);
  }
  return details.slice(0, 2);
}

function buildRecommendationCopy(lead, operator, baseReason) {
  const snippets = [];

  if (lead.segment === "Beginner") {
    snippets.push("You wanted a simpler path into betting.");
  }
  if (lead.answers.sportsbookExperience === "No, I’m new") {
    snippets.push("Your answers suggest you want a smoother first-time experience.");
  }
  if (lead.segment === "Parlay-heavy") {
    snippets.push(
      "Your answers pointed strongly toward parlay-driven betting."
    );
  }
  if (
    lead.answers.mainGoal === "Find the easiest app to use" ||
    lead.answers.topPriority === "Ease of use"
  ) {
    snippets.push(
      `${operator.name} is a good fit if ease of use matters most.`
    );
  }
  if (
    lead.answers.mainGoal === "Get the best odds" ||
    lead.answers.topPriority === "Best odds"
  ) {
    snippets.push(
      `${operator.name} fits better if you're focused on stronger odds and long-term value.`
    );
  }
  if (
    lead.answers.crossSellInterest === "Yes" &&
    ["betmgm", "caesars"].includes(operator.slug)
  ) {
    snippets.push(
      "It also lines up with your interest in casino or DFS-style offers in the same ecosystem."
    );
  }
  if (
    lead.answers.betPreference === "Parlays / Same Game Parlays" &&
    ["draftkings", "fanduel"].includes(operator.slug)
  ) {
    snippets.push("That fits the way you said you like to build parlays.");
  }
  if (
    lead.answers.betPreference === "Straight bets" &&
    operator.slug === "betmgm"
  ) {
    snippets.push(
      "That makes it a useful option if you lean toward straighter, cleaner card building."
    );
  }
  if (lead.answers.startingDeposit === "Under $50") {
    snippets.push(
      "It feels approachable if you're starting with a smaller bankroll."
    );
  }
  if (lead.answers.betFrequency === "Multiple times per week") {
    snippets.push(
      "It can hold up better if you're planning to bet regularly."
    );
  }
  if (lead.answers.mainGoal === "Get the biggest bonus") {
    snippets.push("That lines up with trying to maximize signup value right away.");
  }
  if (lead.answers.mainGoal === "Bet on specific sports/events") {
    snippets.push("It works better if you're targeting specific sports or event types.");
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
    "state",
    "mainGoal",
    "sportsbookExperience",
    "betFrequency",
    "betPreference",
    "topPriority",
    "startingDeposit",
    "crossSellInterest",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "clickedOperators",
    "createdAt"
  ];

  const quote = (v) => `"${String(v || "").replace(/"/g, '""')}"`;
  const lines = [
    headers.join(","),
    ...db.leads.map((lead) =>
      [
        lead.id,
        lead.email,
        lead.segment,
        lead.answers.state,
        lead.answers.mainGoal,
        lead.answers.sportsbookExperience,
        lead.answers.betFrequency,
        lead.answers.betPreference,
        lead.answers.topPriority,
        lead.answers.startingDeposit,
        lead.answers.crossSellInterest,
        formatField(lead.utms?.utm_source, ""),
        formatField(lead.utms?.utm_medium, ""),
        formatField(lead.utms?.utm_campaign, ""),
        formatField(lead.utms?.utm_term, ""),
        formatField(lead.utms?.utm_content, ""),
        lead.clickedOperators
          .map((slug) => operatorCatalog[slug]?.name || slug)
          .join("|"),
        lead.createdAt
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
  const total = questions.length;
  const percent = Math.round((step / total) * 100);
  const currentValue = (session.quizAnswers || {})[question.key] || "";
  const isLast = step === total;

  let optionsHtml;
  if (question.type === "select") {
    optionsHtml = `<select id="${question.key}" name="${question.key}" required>
      <option value="">Select one</option>
      ${question.options
        .map(
          (opt) =>
            `<option value="${escapeHtml(opt)}" ${
              currentValue === opt ? "selected" : ""
            }>${escapeHtml(opt)}</option>`
        )
        .join("")}
    </select>`;
  } else {
    optionsHtml = `<div class="option-list">
      ${question.options
        .map(
          (opt) => `<label class="option-pill">
            <input type="radio" name="${question.key}" value="${escapeHtml(
            opt
          )}" ${currentValue === opt ? "checked" : ""} required />
            <span>${escapeHtml(opt)}</span>
          </label>`
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

function renderQuizMessage(session) {
  const isNew = (session.quizAnswers || {}).sportsbookExperience === "No, I’m new";
  const copy = isNew
    ? "Got it - we'll focus on the easiest apps with the best signup bonuses."
    : "Perfect - we'll prioritize odds, speed, and stronger long-term options.";

  return renderLayout(
    "Quick note",
    `<main class="content-stack narrow">
      <section class="progress-wrap" aria-label="Progress">
        <div class="progress-meta">
          <span class="eyebrow">Question 2 of 8</span>
        </div>
        <div class="progress-track">
          <span class="progress-fill" style="width: 25%"></span>
        </div>
      </section>
      <section class="question-card quiz-message-card">
        <span class="question-number">Quick note</span>
        <strong>${escapeHtml(copy)}</strong>
      </section>
      <div class="quiz-nav">
        <a class="button button-secondary" href="/quiz/2">Back</a>
        <a class="button button-primary" href="/quiz/3">Continue</a>
      </div>
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
        <p>We matched you with 3 sportsbooks based on your answers. Enter your email to see your personalised picks.</p>
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
  const recommendations =
    recommendationsBySegment[lead.segment] || recommendationsBySegment.Casual;
  const copy = segmentCopy[lead.segment] || segmentCopy.Casual;

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
        ? `See ${operator.name}'s sign-up offer`
        : `Compare ${operator.name}`;
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
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((lead) => {
      const clicked = lead.clickedOperators.length
        ? lead.clickedOperators
            .map((slug) => operatorCatalog[slug]?.name || slug)
            .join(", ")
        : "None";
      const utmSource = lead.utms?.utm_source || "Direct";
      return `<tr>
        <td>${lead.id}</td>
        <td>${escapeHtml(lead.email || "Pending")}</td>
        <td>${escapeHtml(lead.segment)}</td>
        <td>${escapeHtml(lead.answers.state || "")}</td>
        <td>${escapeHtml(utmSource)}</td>
        <td>${escapeHtml(clicked)}</td>
        <td>${escapeHtml(new Date(lead.createdAt).toLocaleString())}</td>
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
              <th>State</th>
              <th>UTM source</th>
              <th>Clicked operator</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            ${
              rows ||
              '<tr><td colspan="7">No users yet. Funnel metrics will populate as traffic arrives.</td></tr>'
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

    if (req.method === "GET" && pathname === "/quiz/message") {
      const answers = session.quizAnswers || {};
      if (!answers[questions[0].key]) {
        redirect(res, "/quiz/1");
        return;
      }
      if (!answers[questions[1].key]) {
        redirect(res, "/quiz/2");
        return;
      }
      sendHtml(res, renderQuizMessage(session));
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

      // Ensure all prior steps are answered
      const answers = session.quizAnswers || {};
      for (let i = 0; i < step - 1; i++) {
        if (!answers[questions[i].key]) {
          redirect(res, `/quiz/${i + 1}`);
          return;
        }
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
        const isValidAnswer = question.options.includes(answer);
        if (!answer || !isValidAnswer) {
          sendHtml(res, renderQuizStep(step, session), 400);
          return;
        }

        if (!session.quizAnswers) session.quizAnswers = {};
        session.quizAnswers[question.key] = answer;

        if (step < questions.length) {
          if (step === 2) {
            redirect(res, "/quiz/message");
          } else {
            redirect(res, `/quiz/${step + 1}`);
          }
        } else {
          // Last step — create lead and move to email gate
          const lead = await createLead({
            ...session.quizAnswers,
            utms: session.utms || {}
          });
          session.currentLeadId = lead.id;
          session.resultsTrackedForLeadId = null;
          redirect(res, "/email");
        }
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
        if (!entry.clickedOperators.includes(slug)) {
          entry.clickedOperators.push(slug);
        }
      });
      await trackEvent("operator_click", lead.id, { operator: slug });
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
