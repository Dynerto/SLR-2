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
      steps.push({ type: "page", url, title: pageInfo.title, screenshot: artifactUrl(payload.jobId, screenshotName), buttons: pageInfo.buttons, forms: pageInfo.forms });

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
  const resultPath = path.join(jobDir, "result.json");
  await fs.writeFile(resultPath, JSON.stringify({ summary, script, steps, videoUrl }, null, 2), "utf8");

  jobs.set(workerJobId, { status: "completed", site: payload.site.name, finishedAt: new Date().toISOString(), pages: visited.size, videoUrl });
  await postCallback(payload, { status: "completed", summary, script, videoUrl, artifactUrl: artifactUrl(payload.jobId, "result.json") });
}

async function login(page, site, steps) {
  await page.goto(site.loginUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
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

async function inspectPage(page) {
  return page.evaluate(() => {
    const visibleText = (el) => (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120);
    return {
      title: document.title || "",
      links: Array.from(document.querySelectorAll("a[href]")).map((a) => a.href).filter(Boolean).slice(0, 80),
      buttons: Array.from(document.querySelectorAll("button, [role=button], input[type=submit]")).map(visibleText).filter(Boolean).slice(0, 40),
      forms: Array.from(document.querySelectorAll("form")).map((form) => ({
        action: form.action || location.href,
        labels: Array.from(form.querySelectorAll("label, input, select, textarea")).map((el) => el.getAttribute("aria-label") || el.getAttribute("name") || visibleText(el)).filter(Boolean).slice(0, 30)
      })).slice(0, 10)
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