import express from "express";
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const app = express();
const port = Number(process.env.PORT || 3000);
const apiToken = process.env.CRAWLER_API_TOKEN || "";
const publicBaseUrl = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const artifactsDir = path.resolve("artifacts");
const jobs = new Map();
const jobTimeoutMs = Number(process.env.CRAWLER_JOB_TIMEOUT_MS || 20 * 60 * 1000);
const WORKER_VERSION = "2026-06-25.4-diagnostics";
const DEFAULT_USER_AGENT = process.env.CRAWLER_USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

app.use(express.json({ limit: "2mb" }));
app.use("/artifacts", express.static(artifactsDir));

app.get("/health", (req, res) => {
  res.json({ ok: true, version: WORKER_VERSION, jobs: jobs.size, publicBaseUrl, artifactsDir });
});

app.get("/version", (req, res) => {
  res.json({ ok: true, version: WORKER_VERSION });
});

app.post("/jobs", requireToken, async (req, res) => {
  const payload = req.body || {};
  if (!payload.jobId || !payload.site || !payload.callbackUrl || !payload.callbackToken) {
    return res.status(400).json({ ok: false, error: "Missing jobId, site, callbackUrl, or callbackToken" });
  }

  const workerJobId = crypto.randomUUID();
  jobs.set(workerJobId, { status: "queued", site: payload.site?.name || "unknown", createdAt: new Date().toISOString() });
  res.status(202).json({ ok: true, workerJobId, workerVersion: WORKER_VERSION });

  runJobWithTimeout(workerJobId, payload).catch(async (error) => {
    const failure = await writeFailureArtifact(payload, error);
    jobs.set(workerJobId, { status: "failed", error: String(error?.stack || error) });
    await postCallback(payload, {
      status: "failed",
      error: String(error?.message || error),
      artifactUrl: failure.artifactUrl,
      workerVersion: WORKER_VERSION,
      diagnostics: failure.diagnostics
    });
  });
});

app.get("/jobs/:id", requireToken, (req, res) => {
  res.json(jobs.get(req.params.id) || { status: "unknown" });
});

function requireToken(req, res, next) {
  if (!apiToken) {
    return res.status(500).json({ ok: false, error: "CRAWLER_API_TOKEN is not configured" });
  }
  const header = req.get("authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "");
  const tokenBuffer = Buffer.from(token);
  const expectedBuffer = Buffer.from(apiToken);
  if (tokenBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(tokenBuffer, expectedBuffer)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

async function runJobWithTimeout(workerJobId, payload) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      jobs.set(workerJobId, {
        status: "timed_out",
        site: payload.site?.name || "unknown",
        error: `Worker timeout after ${Math.round(jobTimeoutMs / 60000)} minutes`,
        finishedAt: new Date().toISOString()
      });
      reject(new Error(`Worker timeout after ${Math.round(jobTimeoutMs / 60000)} minutes`));
    }, jobTimeoutMs);
  });

  try {
    await Promise.race([runJob(workerJobId, payload), timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function runJob(workerJobId, payload) {
  const diagnostics = createDiagnostics(payload, workerJobId);
  addDiagnostic(diagnostics, "job_started", {
    site: payload.site?.name || "",
    baseUrl: payload.site?.baseUrl || "",
    maxPages: payload.job?.maxPages || 25
  });
  jobs.set(workerJobId, { status: "running", site: payload.site.name, startedAt: new Date().toISOString(), version: WORKER_VERSION });
  await fs.mkdir(artifactsDir, { recursive: true });
  const jobDir = path.join(artifactsDir, String(payload.jobId));
  await fs.mkdir(jobDir, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--no-sandbox"
    ]
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    userAgent: DEFAULT_USER_AGENT,
    locale: "nl-NL",
    timezoneId: "Europe/Amsterdam",
    ignoreHTTPSErrors: true,
    colorScheme: "light",
    extraHTTPHeaders: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7",
      "DNT": "1",
      "Upgrade-Insecure-Requests": "1"
    },
    recordVideo: { dir: jobDir, size: { width: 1440, height: 1000 } }
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await context.newPage();
  page.on("response", (response) => {
    const request = response.request();
    if (request.resourceType() === "document") {
      addDiagnostic(diagnostics, "document_response", {
        url: response.url(),
        status: response.status(),
        server: response.headers()["server"] || "",
        contentType: response.headers()["content-type"] || ""
      });
    }
  });
  page.on("requestfailed", (request) => {
    addDiagnostic(diagnostics, "request_failed", {
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      errorText: request.failure()?.errorText || ""
    });
  });
  const steps = [];
  const visited = new Set();
  const queue = [];
  const allowedHosts = normalizeHosts(payload.site.allowedHosts, payload.site.baseUrl);
  const maxPages = clamp(Number(payload.job?.maxPages || 25), 1, 100);
  const allowPurchases = Boolean(payload.site.allowPurchases && payload.job?.allowPurchases);

  try {
    await login(page, payload.site, steps);
    for (const candidate of buildStartUrls(payload.site)) {
      const absolute = safeUrl(candidate, payload.site.baseUrl);
      if (absolute && isAllowedUrl(absolute, allowedHosts) && !queue.includes(absolute)) {
        queue.push(absolute);
      }
    }

    while (queue.length && visited.size < maxPages) {
      const url = queue.shift();
      if (!url || visited.has(url) || !isAllowedUrl(url, allowedHosts)) continue;

      addDiagnostic(diagnostics, "navigate_start", { url });
      const response = await gotoPage(page, url);
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      const finalUrl = normalizeUrlForVisit(page.url() || url);
      visited.add(finalUrl || url);

      const pageInfo = await inspectPage(page);
      pageInfo.status = response?.status() || 0;
      pageInfo.finalUrl = page.url() || url;
      pageInfo.accessProblem = detectAccessProblem(pageInfo);
      const screenshotName = `${String(visited.size).padStart(3, "0")}.png`;
      await page.screenshot({ path: path.join(jobDir, screenshotName), fullPage: true }).catch(() => {});
      addDiagnostic(diagnostics, "page_inspected", {
        url,
        finalUrl: pageInfo.finalUrl,
        status: pageInfo.status,
        title: pageInfo.title,
        accessProblem: pageInfo.accessProblem,
        headings: pageInfo.headings.length,
        links: pageInfo.links.length,
        buttons: pageInfo.buttons.length,
        forms: pageInfo.forms.length,
        screenshot: artifactUrl(payload.jobId, screenshotName)
      });
      steps.push({
        type: "page",
        url,
        finalUrl: pageInfo.finalUrl,
        status: pageInfo.status,
        accessProblem: pageInfo.accessProblem,
        title: pageInfo.title,
        headings: pageInfo.headings,
        screenshot: artifactUrl(payload.jobId, screenshotName),
        buttons: pageInfo.buttons,
        forms: pageInfo.forms,
        metaDescription: pageInfo.metaDescription,
        textSample: pageInfo.textSample
      });

      if (pageInfo.accessProblem) {
        continue;
      }

      for (const link of pageInfo.links) {
        const absolute = safeUrl(link, url);
        const normalized = normalizeUrlForVisit(absolute);
        if (absolute && isAllowedUrl(absolute, allowedHosts) && !visited.has(normalized) && queue.length < maxPages * 4) {
          queue.push(absolute);
        }
      }

      await safeExploreClicks(page, steps, allowPurchases);
    }
  } finally {
    await context.close();
    await browser.close();
  }

  const videoPath = await findNewestVideo(jobDir);
  const videoUrl = videoPath ? artifactUrl(payload.jobId, path.basename(videoPath)) : "";
  const script = buildInstructionScript(payload, steps);
  const summary = buildSummary(payload, steps, visited.size, allowPurchases);
  const usablePages = steps.filter((step) => step.type === "page" && !step.accessProblem);
  const crawlStatus = usablePages.length ? "completed" : "failed";
  const crawlError = usablePages.length ? "" : "Crawler zag geen bruikbare pagina's. Er wordt geen video gepubliceerd.";
  addDiagnostic(diagnostics, "job_result", {
    status: crawlStatus,
    pages: visited.size,
    usablePages: usablePages.length,
    error: crawlError,
    videoUrl
  });
  const aiAnalysis = usablePages.length
    ? await analyzeSiteWithOpenAI(payload, steps, summary).catch((error) => ({
        error: String(error?.message || error),
        workflows: [],
        usage_goals: [],
        features: [],
        optimizations: [],
        risks: [],
        content_suggestions: [],
        library_video: null,
        next_crawl_goal: ""
      }))
    : {
      error: "Crawler zag geen bruikbare pagina's; AI-generatie overgeslagen.",
      workflows: [],
      usage_goals: [],
      features: [],
      optimizations: [],
      risks: [],
      content_suggestions: [],
      library_video: null,
      next_crawl_goal: ""
    };
  const voiceoverAudioUrl = await synthesizeVoiceover(payload, aiAnalysis, jobDir).catch((error) => {
    console.error("voiceover failed", error);
    return "";
  });
  if (voiceoverAudioUrl && aiAnalysis.library_video) {
    aiAnalysis.library_video.voiceoverAudioUrl = voiceoverAudioUrl;
  }
  const resultPath = path.join(jobDir, "result.json");
  const diagnosticsPath = path.join(jobDir, "diagnostics.json");
  await fs.writeFile(diagnosticsPath, JSON.stringify(diagnostics, null, 2), "utf8");
  await fs.writeFile(resultPath, JSON.stringify({
    workerVersion: WORKER_VERSION,
    summary,
    script,
    steps,
    videoUrl,
    aiAnalysis,
    diagnosticsUrl: artifactUrl(payload.jobId, "diagnostics.json")
  }, null, 2), "utf8");

  const current = jobs.get(workerJobId);
  if (current && current.status !== "running") {
    return;
  }

  jobs.set(workerJobId, { status: crawlStatus, site: payload.site.name, finishedAt: new Date().toISOString(), pages: visited.size, videoUrl, error: crawlError, version: WORKER_VERSION });
  await postCallback(payload, {
    status: crawlStatus,
    error: crawlError,
    summary,
    script,
    videoUrl,
    artifactUrl: artifactUrl(payload.jobId, "result.json"),
    workerVersion: WORKER_VERSION,
    diagnostics,
    diagnosticsUrl: artifactUrl(payload.jobId, "diagnostics.json"),
    aiAnalysis
  });
}

async function login(page, site, steps) {
  if (!String(site.loginUrl || "").trim()) {
    steps.push({ type: "login_skipped", reason: "No login URL configured" });
    return;
  }

  await gotoPage(page, site.loginUrl);
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  steps.push({ type: "login", url: site.loginUrl, title: await page.title().catch(() => "Login") });

  const user = page.locator('input[type="email"], input[name*="email" i], input[name*="user" i], input[type="text"]').first();
  const pass = page.locator('input[type="password"]').first();
  if (await user.count()) await user.fill(site.username);
  if (await pass.count()) await pass.fill(site.password);

  const submit = page.locator('button[type="submit"], input[type="submit"], button:has-text("Log in"), button:has-text("Login"), button:has-text("Inloggen")').first();
  if (await submit.count()) {
    await Promise.allSettled([page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }), submit.click()]);
  } else if (await pass.count()) {
    await pass.press("Enter").catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  }
}

async function gotoPage(page, url) {
  let response = await gotoWithDirectorySlashFallback(page, url);
  if (response && response.status() === 403 && String(url).startsWith("https://")) {
    const httpUrl = "http://" + String(url).replace(/^https:\/\//i, "");
    response = await gotoWithDirectorySlashFallback(page, httpUrl).catch(() => response);
  }
  return response;
}

async function gotoWithDirectorySlashFallback(page, url) {
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  if (response && response.status() === 403 && !String(url).endsWith("/")) {
    const retryUrl = String(url) + "/";
    return page.goto(retryUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  }

  return response;
}

async function inspectPage(page) {
  return page.evaluate(() => {
    const visibleText = (el) => (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120);
    return {
      title: document.title || "",
      headings: Array.from(document.querySelectorAll("h1, h2, h3")).map(visibleText).filter(Boolean).slice(0, 40),
      links: Array.from(document.querySelectorAll("a[href]")).map((a) => a.href).filter(Boolean).slice(0, 80),
      buttons: Array.from(document.querySelectorAll("button, [role=button], input[type=submit]")).map(visibleText).filter(Boolean).slice(0, 40),
      forms: Array.from(document.querySelectorAll("form")).map((form) => ({
        action: form.action || location.href,
        labels: Array.from(form.querySelectorAll("label, input, select, textarea")).map((el) => el.getAttribute("aria-label") || el.getAttribute("name") || visibleText(el)).filter(Boolean).slice(0, 30)
      })).slice(0, 10),
      textSample: visibleText(document.body).slice(0, 1200),
      canonical: document.querySelector('link[rel="canonical"]')?.href || "",
      metaDescription: document.querySelector('meta[name="description"]')?.content || ""
    };
  });
}

async function safeExploreClicks(page, steps, allowPurchases) {
  const labels = await page.locator("button, [role=button], a").evaluateAll((elements) => elements.map((el, index) => ({ index, text: (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80) })).filter((item) => item.text));
  const interesting = labels.filter((item) => isSafeActionLabel(item.text, allowPurchases)).slice(0, 5);
  for (const item of interesting) {
    steps.push({ type: "action_candidate", label: item.text });
  }
}

function isSafeActionLabel(label, allowPurchases) {
  const text = label.toLowerCase();
  const destructive = ["delete", "remove", "verwijder", "annuleer", "cancel", "refund", "terminate"];
  if (destructive.some((word) => text.includes(word))) return false;
  const purchase = ["buy", "purchase", "checkout", "bestel", "afrekenen", "place order", "confirm order"];
  if (purchase.some((word) => text.includes(word))) return allowPurchases;
  return ["add", "new", "create", "edit", "settings", "configure", "next", "continue", "save", "view", "open", "start"].some((word) => text.includes(word));
}

async function postCallback(payload, result) {
  await fetch(payload.callbackUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Crawler-Callback-Token": payload.callbackToken
    },
    body: JSON.stringify({ jobId: payload.jobId, ...result }),
    signal: timeoutSignal(30000)
  }).catch((error) => console.error("callback failed", error));
}

function buildSummary(payload, steps, pages, allowPurchases) {
  const pageSteps = steps.filter((step) => step.type === "page");
  const blocked = pageSteps.filter((step) => step.accessProblem).length;
  const usable = pageSteps.length - blocked;
  const suffix = blocked ? ` ${blocked} pagina('s) geblokkeerd.` : "";
  return `${payload.site.name}: ${pages} pagina's bezocht, ${usable} bruikbaar. ${steps.filter((step) => step.type === "action_candidate").length} mogelijke functies gevonden. Aankoopmodus: ${allowPurchases ? "aan" : "uit"}.${suffix}`;
}

function buildInstructionScript(payload, steps) {
  const lines = [`# Concept-instructie: ${payload.site.name}`, "", payload.job?.objective || "Automatisch gegenereerde crawl", ""];
  for (const step of steps) {
    if (step.type === "page") {
      lines.push(`## ${step.title || step.url}`, `URL: ${step.url}`, "", "Mogelijke functies:");
      for (const button of step.buttons || []) lines.push(`- ${button}`);
      lines.push("");
    }
    if (step.type === "action_candidate") {
      lines.push(`- Actie-kandidaat: ${step.label}`);
    }
  }
  return lines.join("\n");
}

async function analyzeSiteWithOpenAI(payload, steps, summary) {
  const apiKey = String(payload.ai?.apiKey || process.env.OPENAI_API_KEY || "").trim();
  const model = String(payload.ai?.contentModel || payload.ai?.model || process.env.OPENAI_MODEL || "gpt-5.5").trim() || "gpt-5.5";
  if (!apiKey) {
    return {
      error: "OpenAI API key not configured",
      workflows: [],
      usage_goals: [],
      features: [],
      optimizations: [],
      risks: [],
      content_suggestions: [],
      library_video: null,
      next_crawl_goal: ""
    };
  }

  const observations = steps
    .filter((step) => step.type === "page")
    .slice(0, 30)
    .map((step) => ({
      url: step.url,
      title: step.title,
      status: step.status || 0,
      finalUrl: step.finalUrl || "",
      accessProblem: step.accessProblem || "",
      headings: step.headings || [],
      buttons: step.buttons || [],
      forms: step.forms || [],
      screenshot: step.screenshot || "",
      metaDescription: step.metaDescription || "",
      textSample: step.textSample || ""
    }));

  const prompt = [
    "Analyseer deze software-crawl alsof je een product onboarding specialist bent.",
    "Ontdek workflows, gebruiksdoelen, belangrijke functies, optimalisaties, risico's en suggesties voor instructievideo's.",
    "Gebruik Nederlands. Wees concreet en baseer elk item op evidence uit urls, knoppen, formulieren of headings.",
    "Geef uitsluitend geldige JSON terug met exact deze top-level keys:",
    "workflows, usage_goals, features, optimizations, risks, content_suggestions, library_video, next_crawl_goal.",
    "workflow object: title, user_goal, steps array, evidence array, confidence number 0..1.",
    "usage_goals object: title, audience, priority, evidence array.",
    "feature/optimization/risk/content_suggestion object: title, body, evidence array.",
    "library_video object: title, category, tags array, duration, level, summary, subtitle, voiceover, body.",
    "Maak library_video geschikt als instructievideo in een academy: korte titel, duidelijke ondertitel, voice-overtekst in spreektaal, en extra tekst met stappen.",
    "next_crawl_goal is een concreet Nederlandstalig doel voor de volgende crawl, niet langer dan 180 tekens.",
    "",
    JSON.stringify({
      site: payload.site?.name || "site",
      objective: payload.job?.objective || "",
      summary,
      observations
    })
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: prompt,
      text: { format: { type: "json_object" } }
    }),
    signal: timeoutSignal(120000)
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI analysis failed ${response.status}: ${body}`);
  }

  const data = JSON.parse(body);
  const outputText = extractResponseText(data);
  if (!outputText) {
    throw new Error("OpenAI response did not contain text output");
  }

  const parsed = JSON.parse(outputText);
  return {
    workflows: Array.isArray(parsed.workflows) ? parsed.workflows : [],
    usage_goals: Array.isArray(parsed.usage_goals) ? parsed.usage_goals : [],
    features: Array.isArray(parsed.features) ? parsed.features : [],
    optimizations: Array.isArray(parsed.optimizations) ? parsed.optimizations : [],
    risks: Array.isArray(parsed.risks) ? parsed.risks : [],
    content_suggestions: Array.isArray(parsed.content_suggestions) ? parsed.content_suggestions : [],
    library_video: parsed.library_video && typeof parsed.library_video === "object" ? normalizeLibraryVideo(parsed.library_video) : null,
    next_crawl_goal: typeof parsed.next_crawl_goal === "string" ? parsed.next_crawl_goal.slice(0, 300) : ""
  };
}

function normalizeLibraryVideo(video) {
  return {
    title: String(video.title || "Nieuwe instructievideo").trim(),
    category: String(video.category || "AI instructies").trim(),
    tags: Array.isArray(video.tags) ? video.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 8) : ["ai", "instructie"],
    duration: String(video.duration || "").trim(),
    level: String(video.level || "Basis").trim(),
    summary: String(video.summary || "").trim(),
    subtitle: String(video.subtitle || "").trim(),
    voiceover: String(video.voiceover || "").trim(),
    voiceoverAudioUrl: "",
    body: String(video.body || "").trim()
  };
}

function createDiagnostics(payload, workerJobId) {
  return {
    workerVersion: WORKER_VERSION,
    workerJobId,
    jobId: payload.jobId || "",
    createdAt: new Date().toISOString(),
    runtime: {
      node: process.version,
      platform: process.platform,
      publicBaseUrl,
      userAgent: DEFAULT_USER_AGENT
    },
    events: []
  };
}

function addDiagnostic(diagnostics, type, data = {}) {
  if (!diagnostics || !Array.isArray(diagnostics.events)) return;
  diagnostics.events.push({
    at: new Date().toISOString(),
    type,
    ...redactDiagnosticData(data)
  });
  if (diagnostics.events.length > 250) {
    diagnostics.events.splice(0, diagnostics.events.length - 250);
  }
}

function redactDiagnosticData(data) {
  const redacted = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (/password|token|secret|key/i.test(key)) {
      redacted[key] = "[redacted]";
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

async function writeFailureArtifact(payload, error) {
  const jobId = payload?.jobId || "unknown";
  const jobDir = path.join(artifactsDir, String(jobId));
  const diagnostics = createDiagnostics(payload || {}, "");
  addDiagnostic(diagnostics, "worker_failure", {
    error: String(error?.message || error),
    stack: String(error?.stack || "")
  });
  await fs.mkdir(jobDir, { recursive: true }).catch(() => {});
  const result = {
    workerVersion: WORKER_VERSION,
    summary: "",
    script: "",
    steps: [],
    videoUrl: "",
    aiAnalysis: {
      error: String(error?.message || error),
      workflows: [],
      usage_goals: [],
      features: [],
      optimizations: [],
      risks: [],
      content_suggestions: [],
      library_video: null,
      next_crawl_goal: ""
    },
    diagnosticsUrl: artifactUrl(jobId, "diagnostics.json")
  };
  await fs.writeFile(path.join(jobDir, "diagnostics.json"), JSON.stringify(diagnostics, null, 2), "utf8").catch(() => {});
  await fs.writeFile(path.join(jobDir, "result.json"), JSON.stringify(result, null, 2), "utf8").catch(() => {});
  return {
    artifactUrl: artifactUrl(jobId, "result.json"),
    diagnostics
  };
}

function buildStartUrls(site) {
  const baseUrl = String(site.baseUrl || "").trim();
  const loginUrl = String(site.loginUrl || "").trim();
  const urls = [];
  const add = (value) => {
    const absolute = safeUrl(value, baseUrl);
    if (absolute && !urls.includes(absolute)) urls.push(absolute);
  };

  add(baseUrl);
  if (baseUrl && !baseUrl.endsWith("/")) add(baseUrl + "/");
  if (loginUrl) add(loginUrl);

  return urls;
}

function normalizeUrlForVisit(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href.replace(/\/$/, "");
  } catch {
    return String(url || "").replace(/\/$/, "");
  }
}

function detectAccessProblem(pageInfo) {
  const status = Number(pageInfo?.status || 0);
  const haystack = [
    pageInfo?.title || "",
    pageInfo?.textSample || "",
    ...(Array.isArray(pageInfo?.headings) ? pageInfo.headings : [])
  ].join(" ").toLowerCase();

  if ([401, 403, 429, 503].includes(status)) {
    return `HTTP ${status}`;
  }
  if (
    haystack.includes("403 - forbidden") ||
    haystack.includes("access to this page is forbidden") ||
    haystack.includes("forbidden") ||
    haystack.includes("access denied") ||
    haystack.includes("blocked by") ||
    haystack.includes("enable cookies") ||
    haystack.includes("checking your browser")
  ) {
    return "Access denied content";
  }

  return "";
}

async function synthesizeVoiceover(payload, aiAnalysis, jobDir) {
  const apiKey = String(payload.ai?.apiKey || process.env.OPENAI_API_KEY || "").trim();
  const model = String(payload.ai?.voiceModel || process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts").trim();
  const voiceover = String(aiAnalysis?.library_video?.voiceover || "").trim();
  if (!apiKey || !model || !voiceover) return "";

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      voice: "alloy",
      input: voiceover.slice(0, 4000),
      response_format: "mp3"
    }),
    signal: timeoutSignal(120000)
  });

  if (!response.ok) {
    throw new Error(`OpenAI speech failed ${response.status}: ${await response.text()}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const filename = "voiceover.mp3";
  await fs.writeFile(path.join(jobDir, filename), bytes);
  return artifactUrl(payload.jobId, filename);
}

function extractResponseText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") return content.text;
    }
  }
  return "";
}

function normalizeHosts(hosts, baseUrl) {
  const parsed = new URL(baseUrl);
  const list = Array.isArray(hosts) ? hosts : String(hosts || "").split(",");
  return new Set(list.map((host) => String(host).trim().toLowerCase()).filter(Boolean).concat(parsed.host.toLowerCase()));
}

function isAllowedUrl(url, allowedHosts) {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) && allowedHosts.has(parsed.host.toLowerCase());
  } catch {
    return false;
  }
}

function safeUrl(value, base) {
  try { return new URL(value, base).href; } catch { return ""; }
}

function artifactUrl(jobId, filename) {
  return publicBaseUrl ? `${publicBaseUrl}/artifacts/${encodeURIComponent(jobId)}/${encodeURIComponent(filename)}` : `/artifacts/${encodeURIComponent(jobId)}/${encodeURIComponent(filename)}`;
}

async function findNewestVideo(dir) {
  const entries = await fs.readdir(dir).catch(() => []);
  const videos = entries.filter((name) => name.endsWith(".webm")).sort();
  return videos.length ? path.join(dir, videos[videos.length - 1]) : "";
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  return undefined;
}

app.listen(port, () => {
  console.log(`crawler worker listening on ${port}`);
});
