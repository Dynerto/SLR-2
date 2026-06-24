<?php

declare(strict_types=1);

session_start();

$config = require __DIR__ . '/config.php';

function app_config(): array
{
    global $config;
    return $config;
}

function db(): PDO
{
    static $pdo = null;

    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $db = app_config()['db'];
    $dsn = sprintf(
        'mysql:host=%s;port=%d;dbname=%s;charset=%s',
        $db['host'],
        $db['port'],
        $db['name'],
        $db['charset']
    );

    $pdo = new PDO($dsn, $db['user'], $db['pass'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);

    migrate_database($pdo);

    return $pdo;
}

function migrate_database(PDO $pdo): void
{
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS schema_migrations (
            version VARCHAR(96) NOT NULL,
            applied_at DATETIME NOT NULL,
            PRIMARY KEY (version)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
    );
    $pdo->exec('ALTER TABLE schema_migrations MODIFY version VARCHAR(96) NOT NULL');

    $migrations = [
        '202605280001_create_views' => [
            'CREATE TABLE IF NOT EXISTS views (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                page VARCHAR(32) NOT NULL,
                path VARCHAR(255) NOT NULL,
                ip VARCHAR(45) NOT NULL,
                user_agent TEXT NULL,
                referer TEXT NULL,
                viewed_at DATETIME NOT NULL,
                PRIMARY KEY (id),
                INDEX idx_views_page (page),
                INDEX idx_views_viewed_at (viewed_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
        ],
        '202606240001_create_crawler_tables' => [
            'CREATE TABLE IF NOT EXISTS crawl_sites (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                name VARCHAR(160) NOT NULL,
                base_url VARCHAR(500) NOT NULL,
                login_url VARCHAR(500) NOT NULL,
                username VARCHAR(255) NOT NULL,
                password_encrypted TEXT NOT NULL,
                allowed_hosts TEXT NOT NULL,
                crawl_notes TEXT NULL,
                allow_purchases TINYINT(1) NOT NULL DEFAULT 0,
                active TINYINT(1) NOT NULL DEFAULT 1,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                PRIMARY KEY (id),
                INDEX idx_crawl_sites_active (active)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
            'CREATE TABLE IF NOT EXISTS crawl_jobs (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                site_id BIGINT UNSIGNED NOT NULL,
                status VARCHAR(32) NOT NULL,
                objective TEXT NULL,
                max_pages INT UNSIGNED NOT NULL DEFAULT 25,
                allow_purchases TINYINT(1) NOT NULL DEFAULT 0,
                worker_job_id VARCHAR(120) NULL,
                result_summary MEDIUMTEXT NULL,
                generated_script MEDIUMTEXT NULL,
                generated_video_url VARCHAR(500) NULL,
                artifact_url VARCHAR(500) NULL,
                error_message MEDIUMTEXT NULL,
                started_at DATETIME NULL,
                finished_at DATETIME NULL,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                PRIMARY KEY (id),
                INDEX idx_crawl_jobs_site_id (site_id),
                INDEX idx_crawl_jobs_status (status),
                CONSTRAINT fk_crawl_jobs_site FOREIGN KEY (site_id) REFERENCES crawl_sites(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
        ],
        '202606240002_create_ai_tables' => [
            'CREATE TABLE IF NOT EXISTS ai_settings (
                id TINYINT UNSIGNED NOT NULL,
                api_key_encrypted TEXT NULL,
                selected_model VARCHAR(120) NOT NULL DEFAULT "gpt-5.4-nano",
                available_models MEDIUMTEXT NULL,
                updated_at DATETIME NOT NULL,
                PRIMARY KEY (id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
            'INSERT IGNORE INTO ai_settings (id, selected_model, updated_at) VALUES (1, "gpt-5.4-nano", NOW())',
            'CREATE TABLE IF NOT EXISTS crawl_discovered_workflows (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                job_id BIGINT UNSIGNED NOT NULL,
                site_id BIGINT UNSIGNED NOT NULL,
                title VARCHAR(255) NOT NULL,
                user_goal TEXT NULL,
                steps_json MEDIUMTEXT NULL,
                evidence_json MEDIUMTEXT NULL,
                confidence DECIMAL(4,3) NULL,
                created_at DATETIME NOT NULL,
                PRIMARY KEY (id),
                INDEX idx_crawl_workflows_job_id (job_id),
                INDEX idx_crawl_workflows_site_id (site_id),
                CONSTRAINT fk_crawl_workflows_job FOREIGN KEY (job_id) REFERENCES crawl_jobs(id) ON DELETE CASCADE,
                CONSTRAINT fk_crawl_workflows_site FOREIGN KEY (site_id) REFERENCES crawl_sites(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
            'CREATE TABLE IF NOT EXISTS crawl_usage_goals (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                job_id BIGINT UNSIGNED NOT NULL,
                site_id BIGINT UNSIGNED NOT NULL,
                title VARCHAR(255) NOT NULL,
                audience VARCHAR(255) NULL,
                priority VARCHAR(40) NULL,
                evidence_json MEDIUMTEXT NULL,
                created_at DATETIME NOT NULL,
                PRIMARY KEY (id),
                INDEX idx_crawl_goals_job_id (job_id),
                INDEX idx_crawl_goals_site_id (site_id),
                CONSTRAINT fk_crawl_goals_job FOREIGN KEY (job_id) REFERENCES crawl_jobs(id) ON DELETE CASCADE,
                CONSTRAINT fk_crawl_goals_site FOREIGN KEY (site_id) REFERENCES crawl_sites(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
            'CREATE TABLE IF NOT EXISTS crawl_ai_insights (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                job_id BIGINT UNSIGNED NOT NULL,
                site_id BIGINT UNSIGNED NOT NULL,
                insight_type VARCHAR(60) NOT NULL,
                title VARCHAR(255) NOT NULL,
                body MEDIUMTEXT NULL,
                evidence_json MEDIUMTEXT NULL,
                created_at DATETIME NOT NULL,
                PRIMARY KEY (id),
                INDEX idx_crawl_insights_job_id (job_id),
                INDEX idx_crawl_insights_site_id (site_id),
                INDEX idx_crawl_insights_type (insight_type),
                CONSTRAINT fk_crawl_insights_job FOREIGN KEY (job_id) REFERENCES crawl_jobs(id) ON DELETE CASCADE,
                CONSTRAINT fk_crawl_insights_site FOREIGN KEY (site_id) REFERENCES crawl_sites(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
        ],
    ];

    $applied = $pdo
        ->query('SELECT version FROM schema_migrations')
        ->fetchAll(PDO::FETCH_COLUMN);

    $legacyCrawlerVersion = '202606240001_create_crawler_tabl';
    $crawlerVersion = '202606240001_create_crawler_tables';
    if (in_array($legacyCrawlerVersion, $applied, true) && !in_array($crawlerVersion, $applied, true)) {
        $stmt = $pdo->prepare('UPDATE schema_migrations SET version = :new_version WHERE version = :old_version');
        $stmt->execute([
            'new_version' => $crawlerVersion,
            'old_version' => $legacyCrawlerVersion,
        ]);
        $applied = array_map(
            function (string $version) use ($legacyCrawlerVersion, $crawlerVersion): string {
                return $version === $legacyCrawlerVersion ? $crawlerVersion : $version;
            },
            $applied
        );
    }

    $applied = array_flip($applied);

    foreach ($migrations as $version => $statements) {
        if (isset($applied[$version])) {
            continue;
        }

        foreach ($statements as $statement) {
            $pdo->exec($statement);
        }

        $stmt = $pdo->prepare(
            'INSERT IGNORE INTO schema_migrations (version, applied_at) VALUES (:version, NOW())'
        );
        $stmt->execute(['version' => $version]);
    }
}

function e(string $value): string
{
    return htmlspecialchars($value, ENT_QUOTES, 'UTF-8');
}

function client_ip(): string
{
    if (!empty($_SERVER['HTTP_CF_CONNECTING_IP'])) {
        return $_SERVER['HTTP_CF_CONNECTING_IP'];
    }

    if (!empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
        return trim(explode(',', $_SERVER['HTTP_X_FORWARDED_FOR'])[0]);
    }

    return $_SERVER['REMOTE_ADDR'] ?? '';
}

function log_view(string $page): void
{
    $stmt = db()->prepare(
        'INSERT INTO views (page, path, ip, user_agent, referer, viewed_at)
         VALUES (:page, :path, :ip, :user_agent, :referer, NOW())'
    );

    $stmt->execute([
        'page' => $page,
        'path' => $_SERVER['REQUEST_URI'] ?? '',
        'ip' => client_ip(),
        'user_agent' => $_SERVER['HTTP_USER_AGENT'] ?? '',
        'referer' => $_SERVER['HTTP_REFERER'] ?? '',
    ]);
}

function require_admin(): void
{
    if (($_SESSION['admin_email'] ?? '') === app_config()['admin']['email']) {
        return;
    }

    header('Location: /admin/');
    exit;
}

function app_secret(): string
{
    $secret = app_config()['security']['app_secret'] ?? '';
    if (strlen($secret) < 32) {
        throw new RuntimeException('APP_SECRET must be at least 32 characters before storing crawler passwords.');
    }

    return $secret;
}

function encrypt_secret(string $plain): string
{
    $iv = random_bytes(16);
    $key = hash('sha256', app_secret(), true);
    $cipher = openssl_encrypt($plain, 'aes-256-cbc', $key, OPENSSL_RAW_DATA, $iv);

    if ($cipher === false) {
        throw new RuntimeException('Could not encrypt secret.');
    }

    return base64_encode($iv . $cipher);
}

function decrypt_secret(string $encrypted): string
{
    $raw = base64_decode($encrypted, true);
    if ($raw === false || strlen($raw) <= 16) {
        return '';
    }

    $iv = substr($raw, 0, 16);
    $cipher = substr($raw, 16);
    $key = hash('sha256', app_secret(), true);
    $plain = openssl_decrypt($cipher, 'aes-256-cbc', $key, OPENSSL_RAW_DATA, $iv);

    return $plain === false ? '' : $plain;
}

function ai_settings(): array
{
    $stmt = db()->query('SELECT * FROM ai_settings WHERE id = 1');
    $settings = $stmt->fetch();

    if (!$settings) {
        db()->exec('INSERT IGNORE INTO ai_settings (id, selected_model, updated_at) VALUES (1, "gpt-5.4-nano", NOW())');
        $stmt = db()->query('SELECT * FROM ai_settings WHERE id = 1');
        $settings = $stmt->fetch() ?: [];
    }

    $models = [];
    if (!empty($settings['available_models'])) {
        $decoded = json_decode((string) $settings['available_models'], true);
        $models = is_array($decoded) ? array_values(array_filter(array_map('strval', $decoded))) : [];
    }

    return [
        'api_key_encrypted' => (string) ($settings['api_key_encrypted'] ?? ''),
        'api_key' => !empty($settings['api_key_encrypted']) ? decrypt_secret((string) $settings['api_key_encrypted']) : '',
        'selected_model' => (string) ($settings['selected_model'] ?? 'gpt-5.4-nano'),
        'available_models' => $models,
        'updated_at' => (string) ($settings['updated_at'] ?? ''),
    ];
}

function json_response(array $payload, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}
