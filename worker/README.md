# Capteer Instruct Crawler Worker

This Render worker runs Playwright jobs for `instruct.capteer.pro`.

## Render setup

Create a Render Web Service from this `worker` folder using the included Dockerfile.

Environment variables:

```text
CRAWLER_API_TOKEN=same-value-as-siteground-env
PUBLIC_BASE_URL=https://your-render-worker.onrender.com
```

SiteGround `.env` needs:

```text
CRAWLER_WORKER_URL=https://your-render-worker.onrender.com
CRAWLER_API_TOKEN=same-value-as-render
CRAWLER_CALLBACK_TOKEN=same-callback-token-sent-to-worker
APP_SECRET=random-at-least-32-characters
```

## Guardrails

- The worker only follows hosts supplied by SiteGround in `allowedHosts`.
- Destructive labels are ignored.
- Checkout/order labels are only considered when both the site and job allow purchases.
- 2FA is not supported in this MVP.
- Output is a recorded crawl video, screenshots, and a Markdown concept script.

## Next step

For polished instruction videos, add a render step that turns the Markdown script + screenshots/video into narrated final video assets.