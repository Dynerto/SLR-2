<?php

require __DIR__ . '/../../bootstrap.php';
require_admin();

$error = '';
$notice = '';

if (empty($_SESSION['csrf_token'])) {
    $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    try {
        if (!hash_equals($_SESSION['csrf_token'], $_POST['csrf_token'] ?? '')) {
            throw new RuntimeException('Sessie verlopen. Vernieuw de pagina.');
        }

        $action = $_POST['action'] ?? '';
        if ($action === 'save_site') {
            save_site($_POST);
            header('Location: /admin/crawls/?saved=site');
            exit;
        }
        if ($action === 'delete_site') {
            delete_site((int) ($_POST['site_id'] ?? 0));
            header('Location: /admin/crawls/?deleted=site');
            exit;
        }
        if ($action === 'start_job') {
            $jobId = create_job($_POST);
            dispatch_job($jobId);
            header('Location: /admin/crawls/?started=' . $jobId);
            exit;
        }
    } catch (Throwable $exception) {
        $error = $exception->getMessage();
    }
}

if (isset($_GET['saved'])) {
    $notice = 'Site opgeslagen.';
}
if (isset($_GET['deleted'])) {
    $notice = 'Site verwijderd.';
}
if (isset($_GET['started'])) {
    $notice = 'Crawljob gestart.';
}

$sites = db()->query('SELECT * FROM crawl_sites ORDER BY id DESC')->fetchAll();
$jobs = db()->query('SELECT j.*, s.name AS site_name FROM crawl_jobs j JOIN crawl_sites s ON s.id = j.site_id ORDER BY j.id DESC LIMIT 50')->fetchAll();
$editSite = null;
if (isset($_GET['edit'])) {
    $stmt = db()->prepare('SELECT * FROM crawl_sites WHERE id = ?');
    $stmt->execute([(int) $_GET['edit']]);
    $editSite = $stmt->fetch() ?: null;
}

function save_site(array $post): void
{
    $id = (int) ($post['site_id'] ?? 0);
    $name = trim((string) ($post['name'] ?? ''));
    $baseUrl = trim((string) ($post['base_url'] ?? ''));
    $loginUrl = trim((string) ($post['login_url'] ?? ''));
    $username = trim((string) ($post['username'] ?? ''));
    $password = (string) ($post['password'] ?? '');
    $allowedHosts = trim((string) ($post['allowed_hosts'] ?? ''));
    $notes = trim((string) ($post['crawl_notes'] ?? ''));
    $allowPurchases = isset($post['allow_purchases']) ? 1 : 0;
    $active = isset($post['active']) ? 1 : 0;

    if ($name === '' || $baseUrl === '' || $loginUrl === '' || $username === '') {
        throw new RuntimeException('Naam, basis-url, login-url en gebruikersnaam zijn verplicht.');
    }
    if (!filter_var($baseUrl, FILTER_VALIDATE_URL) || !filter_var($loginUrl, FILTER_VALIDATE_URL)) {
        throw new RuntimeException('Gebruik geldige URL\'s voor basis-url en login-url.');
    }
    if ($allowedHosts === '') {
        $host = parse_url($baseUrl, PHP_URL_HOST);
        $allowedHosts = is_string($host) ? $host : '';
    }
    if ($allowedHosts === '') {
        throw new RuntimeException('Vul minimaal een toegestane host in.');
    }

    if ($id > 0) {
        $stmt = db()->prepare('SELECT password_encrypted FROM crawl_sites WHERE id = ?');
        $stmt->execute([$id]);
        $existing = $stmt->fetch();
        if (!$existing) {
            throw new RuntimeException('Site niet gevonden.');
        }
        $encrypted = $password !== '' ? encrypt_secret($password) : $existing['password_encrypted'];
        $stmt = db()->prepare('UPDATE crawl_sites SET name=?, base_url=?, login_url=?, username=?, password_encrypted=?, allowed_hosts=?, crawl_notes=?, allow_purchases=?, active=?, updated_at=NOW() WHERE id=?');
        $stmt->execute([$name, $baseUrl, $loginUrl, $username, $encrypted, $allowedHosts, $notes, $allowPurchases, $active, $id]);
        return;
    }

    if ($password === '') {
        throw new RuntimeException('Wachtwoord is verplicht voor een nieuwe site.');
    }
    $stmt = db()->prepare('INSERT INTO crawl_sites (name, base_url, login_url, username, password_encrypted, allowed_hosts, crawl_notes, allow_purchases, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())');
    $stmt->execute([$name, $baseUrl, $loginUrl, $username, encrypt_secret($password), $allowedHosts, $notes, $allowPurchases, $active]);
}

function delete_site(int $id): void
{
    if ($id <= 0) {
        throw new RuntimeException('Geen site gekozen.');
    }
    $stmt = db()->prepare('DELETE FROM crawl_sites WHERE id = ?');
    $stmt->execute([$id]);
}

function create_job(array $post): int
{
    $siteId = (int) ($post['site_id'] ?? 0);
    $objective = trim((string) ($post['objective'] ?? ''));
    $maxPages = max(1, min(100, (int) ($post['max_pages'] ?? 25)));
    $allowPurchases = isset($post['allow_purchases']) ? 1 : 0;

    $stmt = db()->prepare('SELECT id FROM crawl_sites WHERE id = ? AND active = 1');
    $stmt->execute([$siteId]);
    if (!$stmt->fetch()) {
        throw new RuntimeException('Kies een actieve site.');
    }

    $stmt = db()->prepare('INSERT INTO crawl_jobs (site_id, status, objective, max_pages, allow_purchases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NOW(), NOW())');
    $stmt->execute([$siteId, 'queued', $objective, $maxPages, $allowPurchases]);
    return (int) db()->lastInsertId();
}

function dispatch_job(int $jobId): void
{
    $config = app_config()['worker'];
    if (($config['url'] ?? '') === '' || ($config['api_token'] ?? '') === '') {
        throw new RuntimeException('CRAWLER_WORKER_URL en CRAWLER_API_TOKEN moeten in .env staan.');
    }

    $stmt = db()->prepare('SELECT j.*, s.* FROM crawl_jobs j JOIN crawl_sites s ON s.id = j.site_id WHERE j.id = ?');
    $stmt->execute([$jobId]);
    $row = $stmt->fetch();
    if (!$row) {
        throw new RuntimeException('Job niet gevonden.');
    }

    $payload = [
        'jobId' => $jobId,
        'callbackUrl' => site_origin() . '/crawler-callback.php',
        'callbackToken' => app_config()['security']['crawler_callback_token'],
        'site' => [
            'name' => $row['name'],
            'baseUrl' => $row['base_url'],
            'loginUrl' => $row['login_url'],
            'username' => $row['username'],
            'password' => decrypt_secret($row['password_encrypted']),
            'allowedHosts' => array_values(array_filter(array_map('trim', explode(',', $row['allowed_hosts'])))),
            'notes' => $row['crawl_notes'],
            'allowPurchases' => (bool) $row['allow_purchases'],
        ],
        'job' => [
            'objective' => $row['objective'],
            'maxPages' => (int) $row['max_pages'],
            'allowPurchases' => (bool) $row['allow_purchases'],
        ],
    ];

    $ch = curl_init($config['url'] . '/jobs');
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => [
            'Content-Type: application/json',
            'Authorization: Bearer ' . $config['api_token'],
        ],
        CURLOPT_POSTFIELDS => json_encode($payload),
        CURLOPT_TIMEOUT => 20,
    ]);
    $response = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlError = curl_error($ch);
    curl_close($ch);

    if ($response === false || $status < 200 || $status >= 300) {
        throw new RuntimeException('Worker kon niet gestart worden: ' . ($curlError ?: (string) $response));
    }

    $data = json_decode((string) $response, true);
    $workerJobId = is_array($data) ? (string) ($data['workerJobId'] ?? '') : '';
    $stmt = db()->prepare('UPDATE crawl_jobs SET status=?, worker_job_id=?, started_at=NOW(), updated_at=NOW() WHERE id=?');
    $stmt->execute(['running', $workerJobId, $jobId]);
}

function short_text(string $value, int $length = 120): string
{
    $value = trim($value);
    if (strlen($value) <= $length) {
        return $value;
    }

    return substr($value, 0, $length - 3) . '...';
}
function site_origin(): string
{
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    return $scheme . '://' . ($_SERVER['HTTP_HOST'] ?? 'localhost');
}

?><!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Crawlerbeheer</title>
  <link rel="stylesheet" href="/admin.css">
</head>
<body>
  <main class="dashboard admin-manager">
    <header class="dashboard-header">
      <div>
        <h1>Crawlerbeheer</h1>
        <p>Laat Render inloggen, functies doorlopen en concept-instructies terugsturen.</p>
      </div>
      <div class="actions">
        <a class="button secondary" href="/admin/">Videobeheer</a>
        <a class="button secondary" href="/">Academy</a>
      </div>
    </header>

    <?php if ($notice): ?><p class="notice"><?= e($notice) ?></p><?php endif; ?>
    <?php if ($error): ?><p class="error panel-message"><?= e($error) ?></p><?php endif; ?>

    <section class="manager-grid">
      <aside class="video-admin-list">
        <div class="list-head"><h2>Sites</h2><a class="button" href="/admin/crawls/">Nieuwe site</a></div>
        <?php foreach ($sites as $site): ?>
          <article class="admin-video-card<?= ($editSite && (int) $editSite['id'] === (int) $site['id']) ? ' active' : '' ?>">
            <div>
              <span><?= $site['active'] ? 'Actief' : 'Inactief' ?><?= $site['allow_purchases'] ? ' · aankopen toegestaan' : '' ?></span>
              <strong><?= e($site['name']) ?></strong>
              <small><?= e($site['base_url']) ?></small>
            </div>
            <div class="row-actions">
              <a class="button secondary" href="/admin/crawls/?edit=<?= (int) $site['id'] ?>">Bewerk</a>
              <form method="post" action="/admin/crawls/" onsubmit="return confirm('Site en jobs verwijderen?');"><input type="hidden" name="csrf_token" value="<?= e($_SESSION['csrf_token']) ?>"><input type="hidden" name="action" value="delete_site"><input type="hidden" name="site_id" value="<?= (int) $site['id'] ?>"><button class="danger" type="submit">Verwijder</button></form>
            </div>
          </article>
        <?php endforeach; ?>
      </aside>

      <section class="editor-panel">
        <h2><?= $editSite ? 'Site bewerken' : 'Nieuwe site' ?></h2>
        <form class="video-form" method="post" action="/admin/crawls/">
          <input type="hidden" name="csrf_token" value="<?= e($_SESSION['csrf_token']) ?>">
          <input type="hidden" name="action" value="save_site">
          <input type="hidden" name="site_id" value="<?= e((string) ($editSite['id'] ?? '')) ?>">
          <div class="form-grid">
            <label>Naam <input name="name" value="<?= e($editSite['name'] ?? '') ?>" required></label>
            <label>Gebruikersnaam <input name="username" value="<?= e($editSite['username'] ?? '') ?>" required></label>
            <label>Basis-url <input name="base_url" value="<?= e($editSite['base_url'] ?? '') ?>" placeholder="https://example.com" required></label>
            <label>Login-url <input name="login_url" value="<?= e($editSite['login_url'] ?? '') ?>" placeholder="https://example.com/login" required></label>
            <label>Wachtwoord <input type="password" name="password" placeholder="<?= $editSite ? 'Laat leeg om te behouden' : 'Verplicht' ?>"></label>
            <label>Toegestane hosts <input name="allowed_hosts" value="<?= e($editSite['allowed_hosts'] ?? '') ?>" placeholder="example.com, app.example.com"></label>
          </div>
          <label>Notities / speciale flow <textarea name="crawl_notes" rows="4"><?= e($editSite['crawl_notes'] ?? '') ?></textarea></label>
          <label class="check-row"><input type="checkbox" name="allow_purchases" <?= !empty($editSite['allow_purchases']) ? 'checked' : '' ?>> Aankopen/testorders zijn toegestaan</label>
          <label class="check-row"><input type="checkbox" name="active" <?= (!$editSite || !empty($editSite['active'])) ? 'checked' : '' ?>> Actief</label>
          <div class="form-actions"><button type="submit">Site opslaan</button></div>
        </form>

        <div class="preview-panel">
          <h2>Nieuwe crawljob</h2>
          <form class="video-form" method="post" action="/admin/crawls/">
            <input type="hidden" name="csrf_token" value="<?= e($_SESSION['csrf_token']) ?>">
            <input type="hidden" name="action" value="start_job">
            <div class="form-grid">
              <label>Site <select name="site_id"><?php foreach ($sites as $site): ?><option value="<?= (int) $site['id'] ?>"><?= e($site['name']) ?></option><?php endforeach; ?></select></label>
              <label>Max pagina's <input type="number" name="max_pages" value="25" min="1" max="100"></label>
            </div>
            <label>Doel <textarea name="objective" rows="3" placeholder="Bijvoorbeeld: doorgrond bestelproces en maak instructie voor nieuwe gebruikers"></textarea></label>
            <label class="check-row"><input type="checkbox" name="allow_purchases"> Deze job mag testorders/aankopen uitvoeren</label>
            <div class="form-actions"><button type="submit" <?= $sites ? '' : 'disabled' ?>>Start crawler</button></div>
          </form>
        </div>

        <div class="preview-panel">
          <h2>Laatste jobs</h2>
          <div class="table-wrap"><table><thead><tr><th>ID</th><th>Site</th><th>Status</th><th>Resultaat</th><th>Fout</th></tr></thead><tbody><?php foreach ($jobs as $job): ?><tr><td><?= (int) $job['id'] ?></td><td><?= e($job['site_name']) ?></td><td><?= e($job['status']) ?></td><td><?= e(short_text((string) $job['result_summary'])) ?></td><td><?= e(short_text((string) $job['error_message'])) ?></td></tr><?php endforeach; ?></tbody></table></div>
        </div>
      </section>
    </section>
  </main>
</body>
</html>