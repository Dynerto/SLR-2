<?php

declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo '{"ok":false}';
    exit;
}

$page = $_POST['page'] ?? '';

if (!in_array($page, ['product', 'founder'], true)) {
    http_response_code(400);
    echo '{"ok":false}';
    exit;
}

log_view($page);

echo '{"ok":true}';
