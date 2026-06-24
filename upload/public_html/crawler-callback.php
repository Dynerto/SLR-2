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

$siteId = 0;
$stmt = db()->prepare('SELECT site_id FROM crawl_jobs WHERE id = ?');
$stmt->execute([$jobId]);
$siteId = (int) ($stmt->fetchColumn() ?: 0);

if ($siteId > 0 && isset($payload['aiAnalysis']) && is_array($payload['aiAnalysis'])) {
    store_ai_analysis($jobId, $siteId, $payload['aiAnalysis']);
}

json_response(['ok' => true]);

function store_ai_analysis(int $jobId, int $siteId, array $analysis): void
{
    db()->prepare('DELETE FROM crawl_discovered_workflows WHERE job_id = ?')->execute([$jobId]);
    db()->prepare('DELETE FROM crawl_usage_goals WHERE job_id = ?')->execute([$jobId]);
    db()->prepare('DELETE FROM crawl_ai_insights WHERE job_id = ?')->execute([$jobId]);

    foreach (($analysis['workflows'] ?? []) as $workflow) {
        if (!is_array($workflow)) {
            continue;
        }
        $stmt = db()->prepare('INSERT INTO crawl_discovered_workflows (job_id, site_id, title, user_goal, steps_json, evidence_json, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())');
        $stmt->execute([
            $jobId,
            $siteId,
            short_db_text((string) ($workflow['title'] ?? 'Workflow'), 255),
            (string) ($workflow['user_goal'] ?? ''),
            encode_json($workflow['steps'] ?? []),
            encode_json($workflow['evidence'] ?? []),
            isset($workflow['confidence']) ? (float) $workflow['confidence'] : null,
        ]);
    }

    foreach (($analysis['usage_goals'] ?? []) as $goal) {
        if (!is_array($goal)) {
            continue;
        }
        $stmt = db()->prepare('INSERT INTO crawl_usage_goals (job_id, site_id, title, audience, priority, evidence_json, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())');
        $stmt->execute([
            $jobId,
            $siteId,
            short_db_text((string) ($goal['title'] ?? 'Gebruiksdoel'), 255),
            short_db_text((string) ($goal['audience'] ?? ''), 255),
            short_db_text((string) ($goal['priority'] ?? ''), 40),
            encode_json($goal['evidence'] ?? []),
        ]);
    }

    $groups = [
        'features' => 'feature',
        'optimizations' => 'optimization',
        'risks' => 'risk',
        'content_suggestions' => 'content_suggestion',
    ];

    foreach ($groups as $key => $type) {
        foreach (($analysis[$key] ?? []) as $insight) {
            if (!is_array($insight)) {
                continue;
            }
            $stmt = db()->prepare('INSERT INTO crawl_ai_insights (job_id, site_id, insight_type, title, body, evidence_json, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())');
            $stmt->execute([
                $jobId,
                $siteId,
                $type,
                short_db_text((string) ($insight['title'] ?? ucfirst($type)), 255),
                (string) ($insight['body'] ?? $insight['description'] ?? ''),
                encode_json($insight['evidence'] ?? []),
            ]);
        }
    }
}

function encode_json($value): string
{
    $json = json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    return $json === false ? '[]' : $json;
}

function short_db_text(string $value, int $length): string
{
    $value = trim($value);
    return strlen($value) > $length ? substr($value, 0, $length) : $value;
}
