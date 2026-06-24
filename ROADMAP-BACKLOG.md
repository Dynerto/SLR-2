# Capteer Instruct - Deploy, Roadmap en Backlog

Dit document is het centrale werkdocument vanaf versie `0.2.0-crawler-mvp`.

## 1. Deploy in een keer begrijpen

De app bestaat uit twee delen:

```text
SiteGround
  instruct.capteer.pro
  PHP + MySQL + admin + publieke academy
  deploy vanuit: upload/

Render
  Playwright crawler worker
  Node + Docker + browser automation
  deploy vanuit: worker/
```

Belangrijk: `worker/` gaat niet naar SiteGround. `upload/` gaat niet naar Render.

## 2. SiteGround deploy

### 2.1 Uploadbestanden

Kopieer de inhoud van deze lokale map:

```text
5. instruct.capteer.pro/upload/
```

naar de root van je hostingaccount, zodat dit op de server ontstaat:

```text
server-root/
  public_html/
    admin/
    academy-data.js
    app.js
    bootstrap.php
    config.php
    crawler-callback.php
    index.html
    service-worker.js
    style.css
    ...
```

De echte `.env` staat bewust niet in `upload/`.

### 2.2 Server `.env` plaatsen

Maak op SiteGround een `.env` naast `public_html`, dus:

```text
server-root/
  .env
  public_html/
```

Gebruik `upload/env.example` als template.

Minimaal nodig:

```text
DB_HOST=localhost
DB_PORT=3306
DB_NAME=your_database_name
DB_USER=your_database_user
DB_PASS=your_database_password
DB_CHARSET=utf8mb4

ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=change-this-password

APP_SECRET=maak-hier-een-lange-random-string-van-minimaal-32-tekens
CRAWLER_WORKER_URL=https://jouw-render-worker.onrender.com
CRAWLER_API_TOKEN=zelfde-token-als-op-render
CRAWLER_CALLBACK_TOKEN=random-callback-token-voor-render-naar-siteground
```

### 2.3 MySQL database

Maak in SiteGround een lege MySQL database en user.

Vul die waarden in `.env`:

```text
DB_NAME=...
DB_USER=...
DB_PASS=...
```

De app maakt tabellen automatisch aan bij de eerste databaseverbinding via `bootstrap.php`.

Tabellen die automatisch worden aangemaakt:

```text
schema_migrations
views
crawl_sites
crawl_jobs
```

### 2.4 Eerste login

Ga naar:

```text
https://instruct.capteer.pro/admin/
```

Login met:

```text
ADMIN_EMAIL
ADMIN_PASSWORD
```

### 2.5 Admin onderdelen

```text
/admin/
  Videobeheer: academyvideo's beheren

/admin/crawls/
  Crawlerbeheer: sites, credentials en crawljobs beheren
```

## 3. Render deploy

Render draait de Playwright-worker. Dit is dus niet `instruct.capteer.pro`, maar een aparte service met een eigen `.onrender.com` URL.

### 3.1 Eerst: code beschikbaar maken voor Render

Render kan meestal niet rechtstreeks uit jouw lokale OneDrive-map deployen. Render verwacht een Git provider of een image.

Aanbevolen route:

1. Maak een GitHub repository voor deze app, bijvoorbeeld:

```text
Dynerto/capteer-instruct
```

2. Zet minimaal deze mappen/bestanden in die repo:

```text
upload/
worker/
ROADMAP-BACKLOG.md
SETUP.md
env.example
schema.sql
```

3. Zet nooit echte secrets in GitHub:

```text
.env
worker/.env
```

Die staan in `.gitignore`.

Als je geen GitHub wilt gebruiken, kan Render ook via `Existing Image`, maar dan moet je zelf eerst een Docker image bouwen en pushen. Voor nu is GitHub het eenvoudigst.

### 3.2 Scherm: New Web Service > Source Code

Je zit nu in Render op:

```text
New Web Service > Configure
```

Je ziet `No repositories found`. Dat betekent dat Render nog geen toegang heeft tot jouw GitHub repositories.

Doe dit:

1. Klik op de knop:

```text
GitHub
```

2. Log in bij GitHub als daarom gevraagd wordt.
3. Geef Render toegang tot de repo waarin deze app staat.
   - Kies bij voorkeur alleen de specifieke repo, niet meteen alle repositories.
4. Na koppelen kom je terug in Render.
5. Selecteer de repo waarin `worker/` staat.

Waar komt deze waarde vandaan?

```text
GitHub repository = de repo waar jij deze projectmap naartoe pusht
```

Voorbeeld:

```text
Dynerto/capteer-instruct
```

### 3.3 Scherm: Configure Web Service

Vul de velden zo in.

#### Name

Render veld:

```text
Name
```

Invullen:

```text
capteer-instruct-crawler-worker
```

Waar komt dit vandaan?

Dit mag je zelf kiezen. Deze naam wordt onderdeel van de Render URL.

Voorbeeld Render URL na deploy:

```text
https://capteer-instruct-crawler-worker.onrender.com
```

#### Region

Render veld:

```text
Region
```

Invullen:

```text
Frankfurt / Europe
```

Als Frankfurt niet beschikbaar is, kies de dichtstbijzijnde EU-regio.

#### Branch

Render veld:

```text
Branch
```

Invullen:

```text
main
```

Waar komt dit vandaan?

Dit is de branch van je GitHub repo. Meestal heet die `main`.

#### Root Directory

Render veld:

```text
Root Directory
```

Invullen:

```text
worker
```

Belangrijk: zonder dit probeert Render de hele repo te deployen. De Dockerfile staat in `worker/`, dus Root Directory moet exact `worker` zijn.

#### Runtime / Environment

Render veld:

```text
Runtime / Environment
```

Kies:

```text
Docker
```

Waar komt dit vandaan?

De worker gebruikt Playwright met browsers. Daarom gebruiken we:

```text
worker/Dockerfile
```

#### Instance type / Plan

Render veld:

```text
Instance Type
```

Voor eerste test:

```text
Starter
```

Let op: Playwright is zwaarder dan een simpele API. Free kan slapen of te krap zijn. Voor serieus gebruik is `Starter` of hoger verstandiger.

#### Auto Deploy

Render veld:

```text
Auto Deploy
```

Voor nu aanbevolen:

```text
No / Off
```

Dan deploy je bewust handmatig na wijzigingen.

### 3.4 Render environment variables invullen

In Render, zoek het onderdeel:

```text
Environment Variables
```

Voeg deze toe.

#### CRAWLER_API_TOKEN

Render key:

```text
CRAWLER_API_TOKEN
```

Render value:

```text
maak-een-lange-random-token
```

Voorbeeld:

```text
CRAWLER_API_TOKEN=slr_render_7a9b0d4f_long_random_value
```

Waar komt dit vandaan?

Jij bedenkt dit token zelf. Hetzelfde token moet ook in de SiteGround `.env` komen.

SiteGround `.env`:

```text
CRAWLER_API_TOKEN=slr_render_7a9b0d4f_long_random_value
```

#### PUBLIC_BASE_URL

Render key:

```text
PUBLIC_BASE_URL
```

Render value:

```text
https://de-render-url-van-deze-worker.onrender.com
```

Waar komt dit vandaan?

Dit is de URL van de Render service zelf. Na deploy toont Render die bovenaan bij de service.

Als je de URL nog niet weet tijdens het eerste aanmaken, doe dan dit:

1. Vul tijdelijk in:

```text
PUBLIC_BASE_URL=https://capteer-instruct-crawler-worker.onrender.com
```

2. Deploy de service.
3. Kijk welke URL Render echt geeft.
4. Ga daarna in Render naar:

```text
Environment > PUBLIC_BASE_URL
```

5. Corrigeer de waarde als de URL anders is.

Voorbeeld:

```text
PUBLIC_BASE_URL=https://capteer-instruct-crawler-worker.onrender.com
```

Niet invullen:

```text
https://instruct.capteer.pro
```

Waarom niet?

`instruct.capteer.pro` is SiteGround. `PUBLIC_BASE_URL` is Render. De worker gebruikt deze waarde om links te maken naar crawlvideo's, screenshots en `result.json` op Render.

### 3.5 Deploy klikken

Klik op:

```text
Create Web Service
```

Render gaat nu bouwen.

Tijdens build moet Render ongeveer dit doen:

```text
FROM mcr.microsoft.com/playwright:v1.49.1-noble
npm install --omit=dev
npm start
```

Als deploy klaar is, open:

```text
https://jouw-render-worker.onrender.com/health
```

Verwacht:

```json
{"ok":true,"jobs":0}
```

### 3.6 Render URL terugzetten in SiteGround `.env`

Na succesvolle Render deploy kopieer je de Render URL.

Voorbeeld:

```text
https://capteer-instruct-crawler-worker.onrender.com
```

Zet op SiteGround in `.env`:

```text
CRAWLER_WORKER_URL=https://capteer-instruct-crawler-worker.onrender.com
CRAWLER_API_TOKEN=zelfde-token-als-op-render
CRAWLER_CALLBACK_TOKEN=ander-lang-random-token
```

`CRAWLER_CALLBACK_TOKEN` hoeft niet in Render als vaste env var. SiteGround stuurt dit token mee in elke job, en Render stuurt het terug naar:

```text
https://instruct.capteer.pro/crawler-callback.php
```

### 3.7 Wat hoort waar?

```text
SiteGround .env
  DB_HOST
  DB_PORT
  DB_NAME
  DB_USER
  DB_PASS
  DB_CHARSET
  ADMIN_EMAIL
  ADMIN_PASSWORD
  APP_SECRET
  CRAWLER_WORKER_URL
  CRAWLER_API_TOKEN
  CRAWLER_CALLBACK_TOKEN

Render Environment Variables
  CRAWLER_API_TOKEN
  PUBLIC_BASE_URL
```

### 3.8 Veelgemaakte fouten

#### Fout: No repositories found

Oorzaak:

Render heeft nog geen GitHub toegang.

Oplossing:

Klik op `GitHub` en koppel de juiste repo.

#### Fout: Dockerfile not found

Oorzaak:

Root Directory staat niet op `worker`.

Oplossing:

Zet:

```text
Root Directory=worker
```

#### Fout: Worker start, maar SiteGround kan hem niet starten

Controleer SiteGround `.env`:

```text
CRAWLER_WORKER_URL=https://jouw-render-worker.onrender.com
CRAWLER_API_TOKEN=exact hetzelfde als Render
```

#### Fout: Artifacts links werken niet

Controleer Render env var:

```text
PUBLIC_BASE_URL=https://jouw-render-worker.onrender.com
```

#### Fout: Wachtwoorden opslaan lukt niet

Controleer SiteGround `.env`:

```text
APP_SECRET=minimaal-32-tekens-en-niet-meer-veranderen
```
## 4. Eerste end-to-end test

1. Ga naar `https://instruct.capteer.pro/admin/crawls/`.
2. Maak een site aan.
3. Vul in:
   - naam
   - basis-url
   - login-url
   - gebruikersnaam
   - wachtwoord
   - toegestane hosts, bijvoorbeeld `example.com, app.example.com`
4. Zet `Aankopen/testorders zijn toegestaan` alleen aan voor accounts waar dat echt veilig is.
5. Sla de site op.
6. Start een nieuwe crawljob.
7. Controleer in Render logs of de worker start.
8. Wacht op callback naar SiteGround.
9. Bekijk de jobstatus onder `Laatste jobs`.
10. Controleer artifacts op Render:

```text
/artifacts/{jobId}/result.json
/artifacts/{jobId}/...webm
/artifacts/{jobId}/001.png
```

## 5. Veiligheidsregels

- Gebruik dit alleen voor eigen sites of sites waarvoor je expliciet toestemming hebt.
- Zet 2FA voorlopig uit voor testaccounts of gebruik aparte testaccounts zonder 2FA.
- Gebruik testaccounts met gratis plan, sandbox checkout of kortingscode.
- Zet aankoopmodus alleen per site en per job aan als testorders echt veilig zijn.
- Gebruik altijd `allowed_hosts`; de worker volgt geen externe domeinen buiten die lijst.
- Bewaar echte secrets alleen in `.env` of Render env vars, nooit in `upload/`, GitHub of documentatie.
- Verander `APP_SECRET` niet nadat crawler-wachtwoorden zijn opgeslagen, anders kun je die wachtwoorden niet meer ontsleutelen.

## 6. Huidige status

Versie: `0.2.0-crawler-mvp`

Werkend/fundament aanwezig:

- [x] Publieke academy
- [x] NL/EN interface toggle voor bezoekers
- [x] Admin login
- [x] Videobeheer
- [x] YouTube URL support naast upload/serverbestand
- [x] Uploadmapstructuur voor SiteGround
- [x] `.env` buiten `public_html`
- [x] MySQL migraties
- [x] Render worker scaffold
- [x] Crawler-sites beheren
- [x] Crawljobs starten
- [x] Render callback endpoint
- [x] Playwright login zonder 2FA
- [x] Host allowlist guardrail
- [x] Basale crawl recording + screenshots + scriptconcept

Nog niet volwassen/productierijp:

- [ ] Visuele jobdetailpagina met stappen, screenshots, video en script
- [ ] Automatisch conceptvideo toevoegen aan academy na goedkeuring
- [ ] AI-analyse van UI/functies met betere samenvattingen
- [ ] Voice-over en finale video-rendering
- [ ] Queue persistence op Render of externe queue
- [ ] Artifact opslag buiten Render ephemeral disk
- [ ] Betere loginflow configuratie per site
- [ ] Betere detectie van destructive/purchase acties
- [ ] Rollen/rechten voor admin
- [ ] Auditlog
- [ ] E-mail/notification bij afgeronde job

## 7. Roadmap

### Fase 1 - Stabiliseren MVP

- [ ] PHP linten op echte hosting of lokale PHP installeren
- [ ] Eerste SiteGround deploy testen
- [ ] Eerste Render deploy testen
- [ ] `/health` worker checken
- [ ] Eerste crawl op eenvoudige eigen site uitvoeren
- [ ] Callback en jobstatus controleren
- [ ] Fouten netjes tonen in admin
- [ ] Resultaatlinks klikbaar maken in admin
- [ ] Jobdetailpagina maken

### Fase 2 - Crawler bruikbaar maken voor echte sites

- [ ] Per site login selectors kunnen instellen
- [ ] Per site post-login check kunnen instellen
- [ ] Per site crawl start-url toevoegen
- [ ] Per site exclude patronen toevoegen
- [ ] Crawl depth/max duration toevoegen
- [ ] Screenshots per stap tonen
- [ ] Formulieren en menu's beter herkennen
- [ ] Modals/dropdowns/tabs herkennen
- [ ] Veilige click-exploration uitbreiden
- [ ] Checkout/testorder-flow expliciet markeren
- [ ] Rate limiting en pauzes instelbaar maken

### Fase 3 - Instructieconcepten

- [ ] Resultaat opslaan als concept-instructie
- [ ] Concept-instructie kunnen bewerken in admin
- [ ] Stappenplan genereren per functie
- [ ] Titel/categorie/tags voorstellen
- [ ] NL/EN metadata voorstellen
- [ ] Screenshots koppelen aan stappen
- [ ] Crawlvideo als bronmateriaal bewaren
- [ ] Goedkeurknop: publiceer naar academy

### Fase 4 - Videoproductie

- [ ] Script naar voice-over tekst
- [ ] Voice-over genereren
- [ ] Captions genereren
- [ ] Video knippen tot relevante segmenten
- [ ] Cursor/highlight overlays toevoegen
- [ ] Intro/outro template toevoegen
- [ ] Finale MP4 renderen
- [ ] YouTube upload optioneel toevoegen
- [ ] Academy item automatisch koppelen aan YouTube URL

### Fase 5 - Productieharding

- [ ] Artifact opslag naar S3/R2/Backblaze of vergelijkbaar
- [ ] Render jobs persistent maken met Redis/Postgres
- [ ] Webhook retry mechanisme
- [ ] Admin auditlog
- [ ] Secrets rotatie
- [ ] Error monitoring
- [ ] Kostenlimieten per job
- [ ] Robots/ToS checklist per site
- [ ] Backup/restore procedure

## 8. Backlog details

### Admin

- [ ] Jobdetailpagina: `/admin/crawls/job.php?id=...`
- [ ] Site testknop: login testen zonder crawl
- [ ] Worker status tonen
- [ ] Render artifact links tonen
- [ ] Job opnieuw starten
- [ ] Job annuleren
- [ ] Site dupliceren
- [ ] Credentials opnieuw versleutelen bij APP_SECRET rotatie

### Worker

- [ ] Login selectors configurabel maken
- [ ] Cookie/session reuse per job optioneel
- [ ] Network logs opslaan
- [ ] Console errors opslaan
- [ ] Accessibility tree gebruiken voor betere UI-analyse
- [ ] Crawls parallel beperken
- [ ] Hard timeout per job
- [ ] Better action classifier
- [ ] Form fill sandbox strategy
- [ ] Purchase/testorder confirmation strategy

### Academy

- [ ] Conceptstatus toevoegen aan video's
- [ ] Draft/published scheiding
- [ ] NL/EN contentvelden per video
- [ ] Zoeken in transcript
- [ ] Video chapters
- [ ] Related videos binnen academy
- [ ] Admin preview voor beide talen

### Deploy/Ops

- [ ] Render deploy guide met screenshots
- [ ] SiteGround deploy checklist met screenshots
- [ ] `.env` generator script
- [ ] Health check pagina voor SiteGround
- [ ] Install check voor database/env/migraties
- [ ] Backup script voor `academy-data.js` en database

## 9. Version log

### 0.2.0-crawler-mvp - 2026-06-24

Gemaakt:

- Render Playwright worker scaffold in `worker/`
- Dockerfile en `render.yaml`
- Worker API:
  - `GET /health`
  - `POST /jobs`
  - `GET /jobs/:id`
- SiteGround admin crawlerbeheer op `/admin/crawls/`
- Site credentials encrypted opgeslagen in MySQL
- `crawl_sites` en `crawl_jobs` database migraties
- `crawler-callback.php` voor Render callbacks
- Worker guardrails:
  - host allowlist
  - destructive action labels overslaan
  - checkout/order alleen als site en job aankoopmodus toestaan
- Worker output:
  - Playwright recording
  - screenshots
  - `result.json`
  - Markdown conceptscript
- `.env.example`, `env.example` en `upload/env.example` uitgebreid met crawler variabelen
- `SETUP.md` uitgebreid met crawler deployuitleg

Bekende beperkingen:

- Geen 2FA support
- Geen finale gemonteerde instructievideo
- Render artifact opslag is nog lokaal/ephemeral
- Worker queue is in-memory
- Loginflow is heuristisch, nog niet per site configureerbaar
- PHP lint niet lokaal uitgevoerd omdat PHP niet op PATH staat

### Volgende versie gepland: 0.3.0-job-details

Doel:

- Jobdetailpagina in admin
- Artifact links tonen
- Screenshots en script zichtbaar maken
- Concept naar academy kunnen promoveren