<?php

require __DIR__ . '/bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_response(['ok' => false], 405);
}

$token = $_SERVER['HTTP_X_CRAWLER_CALLBACK_TOKEN'] ?? '';
$expected = app_config()['security']['crawler_callback_token'] ?? '';
if ($expected === '' || !hash_equals($expected, $token)) {
    json_response(['ok' => false, 'error' => 'unauthorized'], 401);
}

$payload = json_decode(file_get_contents('php://input') ?: '', true);
if (!is_array($payload)) {
    json_response(['ok' => false, 'error' => 'invalid json'], 400);
}

$jobId = (int) ($payload['jobId'] ?? 0);
$status = (string) ($payload['status'] ?? 'failed');
if ($jobId <= 0) {
    json_response(['ok' => false, 'error' => 'missing jobId'], 400);
}

$allowed = ['queued', 'running', 'completed', 'failed'];
if (!in_array($status, $allowed, true)) {
    $status = 'failed';
}

$stmt = db()->prepare('UPDATE crawl_jobs SET status=?, result_summary=?, generated_script=?, generated_video_url=?, artifact_url=?, error_message=?, finished_at=IF(? IN ("completed", "failed"), NOW(), finished_at), updated_at=NOW() WHERE id=?');
$stmt->execute([
    $status,
    (string) ($payload['summary'] ?? ''),
    (string) ($payload['script'] ?? ''),
    (string) ($payload['videoUrl'] ?? ''),
    (string) ($payload['artifactUrl'] ?? ''),
    (string) ($payload['error'] ?? ''),
    $status,
    $jobId,
]);

json_response(['ok' => true]);