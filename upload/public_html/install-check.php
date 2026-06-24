<?php

declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

header('Content-Type: text/plain; charset=utf-8');
header('Cache-Control: no-store');

echo "Capteer Instruct install check\n";
echo "PHP: " . PHP_VERSION . "\n";
echo "PDO: " . (extension_loaded('pdo') ? 'yes' : 'no') . "\n";
echo "PDO MySQL: " . (extension_loaded('pdo_mysql') ? 'yes' : 'no') . "\n";
echo "OpenSSL: " . (extension_loaded('openssl') ? 'yes' : 'no') . "\n";
echo "cURL: " . (extension_loaded('curl') ? 'yes' : 'no') . "\n";
echo "APP_SECRET length ok: " . (strlen(app_config()['security']['app_secret'] ?? '') >= 32 ? 'yes' : 'no') . "\n";
echo "Worker URL: " . ((app_config()['worker']['url'] ?? '') !== '' ? app_config()['worker']['url'] : 'missing') . "\n";
echo "Worker token set: " . ((app_config()['worker']['api_token'] ?? '') !== '' ? 'yes' : 'no') . "\n";
echo "Callback token set: " . ((app_config()['security']['crawler_callback_token'] ?? '') !== '' ? 'yes' : 'no') . "\n";

try {
    $pdo = db();
    echo "Database connection: yes\n";

    foreach (['schema_migrations', 'views', 'crawl_sites', 'crawl_jobs', 'ai_settings', 'crawl_discovered_workflows', 'crawl_usage_goals', 'crawl_ai_insights'] as $table) {
        $stmt = $pdo->query('SHOW TABLES LIKE ' . $pdo->quote($table));
        echo "Table {$table}: " . ($stmt && $stmt->fetchColumn() ? 'yes' : 'no') . "\n";
    }
    $ai = ai_settings();
    echo "OpenAI key stored: " . ($ai['api_key'] !== '' ? 'yes' : 'no') . "\n";
    echo "OpenAI selected model: " . ($ai['selected_model'] ?: 'gpt-5.4-nano') . "\n";
} catch (Throwable $exception) {
    echo "Database connection: no\n";
    echo "Database error: " . $exception->getMessage() . "\n";
}
