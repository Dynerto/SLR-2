# Instruct Capteer setup

## Upload structure

Use `upload` as the deployment package for code and lightweight assets. Heavy video files are intentionally not included; keep them on the server in `public_html/videos`.

Copy the contents of `upload` to the hosting account root. This means `upload/public_html` overwrites or updates the server `public_html` directory.

The real `.env` file is deliberately not inside `upload`, so future uploads do not overwrite production secrets.

Expected server layout:

```text
server-root/
  .env
  env.example
  README-UPLOAD.txt
  public_html/
    admin/
    videos/
    .htaccess
    academy-data.js
    admin.css
    app.js
    bootstrap.php
    config.php
    index.html
    log.php
    manifest.webmanifest
    service-worker.js
    style.css
```

## Local project layout

```text
5. instruct.capteer.pro/
  upload/
    env.example
    README-UPLOAD.txt
    public_html/
      ... deploy files ...
  .env
  .env.example
  env.example
  .gitignore
  schema.sql
  SETUP.md
```

`.env.example` is present for convention, but it can be hidden by file explorers. `env.example` is the visible copy with the same contents.

## Admin

The `/admin/` page is protected by the login in `public_html/admin/index.php`. The admin folder also has its own `.htaccess` so `index.php` remains the only PHP entry point there.


Open `/admin/` on the domain and sign in with the values from `.env`:

```text
ADMIN_EMAIL=...
ADMIN_PASSWORD=...
```

## Environment

Create `.env` outside the server `public_html` directory, next to `public_html`, using `env.example` as the template.

Required values:

```text
DB_HOST=localhost
DB_PORT=3306
DB_NAME=your_database_name
DB_USER=your_database_user
DB_PASS=your_database_password
DB_CHARSET=utf8mb4

ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=change-this-password
```

## Database

Create an empty MySQL database and user in the hosting panel, then fill those details in `.env`.

The app creates and updates its own tables from `bootstrap.php`. On every database connection it checks `schema_migrations` and runs any missing migrations.

When the database structure changes later, add a new version to the `$migrations` array in `bootstrap.php`. Use a new unique version name, for example:

```php
'202606240001_add_example_column' => [
    'ALTER TABLE views ADD COLUMN example VARCHAR(255) NULL',
],
```

The SQL in `schema.sql` is only a manual fallback/reference and is not included in `upload/public_html`.
## YouTube videos

In admin you can choose `YouTube URL` as the source and paste a YouTube URL or video-id. The public academy embeds YouTube through `youtube-nocookie.com` with `rel=0`, `modestbranding=1`, and `playsinline=1`.

YouTube no longer allows embeds to fully disable end-screen suggestions. `rel=0` limits suggestions to the same YouTube channel. To keep suggestions inside the academy as much as YouTube permits, host academy videos on one dedicated channel and use unlisted/private videos with embedding enabled. Truly private YouTube videos may still require the viewer to be logged into an approved YouTube account.

The existing upload/server-file option remains available in admin.
## Crawler worker

The crawler is split across SiteGround and Render.

SiteGround deploys only `upload`:

```text
upload/
  env.example
  README-UPLOAD.txt
  public_html/
    admin/
    crawler-callback.php
    ...
```

Render deploys the separate `worker` folder. Do not upload `worker` to SiteGround public_html.

Required SiteGround `.env` values:

```text
APP_SECRET=random-at-least-32-characters
CRAWLER_WORKER_URL=https://your-render-worker.onrender.com
CRAWLER_API_TOKEN=same-token-as-render
CRAWLER_CALLBACK_TOKEN=random-callback-token
```

Required Render environment variables:

```text
CRAWLER_API_TOKEN=same-token-as-siteground
PUBLIC_BASE_URL=https://your-render-worker.onrender.com
```

Admin path:

```text
/admin/crawls/
```

Crawler MVP behavior:

- stores site login credentials encrypted in MySQL using `APP_SECRET`
- sends jobs to Render with a bearer token
- Render logs in through Playwright without 2FA
- Render follows only configured allowed hosts
- destructive labels are ignored
- checkout/order labels are only considered when both the site and the individual job allow purchases
- Render records the crawl, screenshots pages, generates a Markdown concept script, and posts results back to `/crawler-callback.php`

This is a working foundation, not yet a polished autonomous video production studio. The next production step is a renderer that turns the crawl recording plus generated script into final edited instruction videos.