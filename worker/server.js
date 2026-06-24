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

app.use(express.json({ limit: "2mb" }));
app.use("/artifacts", express.static(artifactsDir));

app.get("/health", (req, res) => {
  res.json({ ok: true, jobs: jobs.size });
});

app.post("/jobs", requireToken, async (req, res) => {
  const payload = req.body || {};
  if (!payload.jobId || !payload.site || !payload.callbackUrl || !payload.callbackToken) {
    return res.status(400).json({ ok: false, error: "Missing jobId, site, callbackUrl, or callbackToken" });
  }

  const workerJobId = crypto.randomUUID();
  jobs.set(workerJobId, { status: "queued", site: payload.site?.name || "unknown", createdAt: new Date().toISOString() });
  res.status(202).json({ ok: true, workerJobId });

  runJob(workerJobId, payload).catch(async (error) => {
    jobs.set(workerJobId, { status: "failed", error: String(error?.stack || error) });
    await postCallback(payload, { status: "failed", error: String(error?.message || error) });
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

async function runJob(workerJobId, payload) {
  jobs.set(workerJobId, { status: "running", site: payload.site.name, startedAt: new Date().toISOString() });
  await fs.mkdir(artifactsDir, { recursive: true });
  const jobDir = path.join(artifactsDir, String(payload.jobId));
  await fs.mkdir(jobDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    recordVideo: { dir: jobDir, size: { width: 1440, height: 1000 } }
  });
  const page = await context.newPage();
  const steps = [];
  const visited = new Set();
  const queue = [payload.site.baseUrl];
  const allowedHosts = normalizeHosts(payload.site.allowedHosts, payload.site.baseUrl);
  const maxPages = clamp(Number(payload.job?.maxPages || 25), 1, 100);
  const allowPurchases = Boolean(payload.site.allowPurchases && payload.job?.allowPurchases);

  try {
    await login(page, payload.site, steps);

    while (queue.length && visited.size < maxPages) {
      const url = queue.shift();
      if (!url || visited.has(url) || !isAllowedUrl(url, allowedHosts)) continue;

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      visited.add(url);

      const pageInfo = await inspectPage(page);
      const screenshotName = `${String(visited.size).padStart(3, "0")}.png`;
      await page.screenshot({ path: path.join(jobDir, screenshotName), fullPage: true }).catch(() => {});
      steps.push({
        type: "page",
        url,
        title: pageInfo.title,
        headings: pageInfo.headings,
        screenshot: artifactUrl(payload.jobId, screenshotName),
        buttons: pageInfo.buttons,
        forms: pageInfo.forms,
        textSample: pageInfo.textSample
      });

      for (const link of pageInfo.links) {
        const absolute = safeUrl(link, url);
        if (absolute && isAllowedUrl(absolute, allowedHosts) && !visited.has(absolute) && queue.length < maxPages * 3) {
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
  const aiAnalysis = await analyzeSiteWithOpenAI(payload, steps, summary).catch((error) => ({
    error: String(error?.message || error),
    workflows: [],
    usage_goals: [],
    features: [],
    optimizations: [],
    risks: [],
    content_suggestions: [],
    library_video: null,
    next_crawl_goal: ""
  }));
  const voiceoverAudioUrl = await synthesizeVoiceover(payload, aiAnalysis, jobDir).catch((error) => {
    console.error("voiceover failed", error);
    return "";
  });
  if (voiceoverAudioUrl && aiAnalysis.library_video) {
    aiAnalysis.library_video.voiceoverAudioUrl = voiceoverAudioUrl;
  }
  const resultPath = path.join(jobDir, "result.json");
  await fs.writeFile(resultPath, JSON.stringify({ summary, script, steps, videoUrl, aiAnalysis }, null, 2), "utf8");

  jobs.set(workerJobId, { status: "completed", site: payload.site.name, finishedAt: new Date().toISOString(), pages: visited.size, videoUrl });
  await postCallback(payload, { status: "completed", summary, script, videoUrl, artifactUrl: artifactUrl(payload.jobId, "result.json"), aiAnalysis });
}

async function login(page, site, steps) {
  await gotoWithDirectorySlashFallback(page, site.loginUrl);
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  steps.push({ type: "login", url: site.loginUrl, title: await page.title().catch(() => "Login") });

  const user = page.locator('input[type="email"], input[name*="email" i], input[name*="user" i], input[type="text"]').first();
  const pass = page.locator('input[type="password"]').first();
  if (await user.count()) await user.fill(site.username);
  if (await pass.count()) await pass.fill(site.password);

  const submit = page.locator('button[type="submit"], input[type="submit"], button:has-text("Log in"), button:has-text("Login"), button:has-text("Inloggen")').first();
  if (await submit.count()) {
    await Promise.allSettled([page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }), submit.click()]);
  } else {
    await pass.press("Enter").catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  }
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
      textSample: visibleText(document.body).slice(0, 1200)
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
    body: JSON.stringify({ jobId: payload.jobId, ...result })
  }).catch((error) => console.error("callback failed", error));
}

function buildSummary(payload, steps, pages, allowPurchases) {
  return `${payload.site.name}: ${pages} pagina's bezocht. ${steps.filter((step) => step.type === "action_candidate").length} mogelijke functies gevonden. Aankoopmodus: ${allowPurchases ? "aan" : "uit"}.`;
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
      headings: step.headings || [],
      buttons: step.buttons || [],
      forms: step.forms || [],
      screenshot: step.screenshot || "",
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
    })
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
    })
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

app.listen(port, () => {
  console.log(`crawler worker listening on ${port}`);
});
