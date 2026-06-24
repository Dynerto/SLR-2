<?php

declare(strict_types=1);

function load_env_file(): void
{
    $paths = [
        dirname(__DIR__) . '/.env',
        __DIR__ . '/.env',
    ];

    foreach ($paths as $path) {
        if (!is_file($path) || !is_readable($path)) {
            continue;
        }

        foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
            $line = trim($line);

            if ($line === '' || strpos($line, '#') === 0 || strpos($line, '=') === false) {
                continue;
            }

            [$name, $value] = explode('=', $line, 2);
            $name = trim($name);
            $value = trim($value);

            if (
                (strpos($value, '"') === 0 && substr($value, -1) === '"') ||
                (strpos($value, "'") === 0 && substr($value, -1) === "'")
            ) {
                $value = substr($value, 1, -1);
            }

            $_ENV[$name] = $value;
            $_SERVER[$name] = $value;
            putenv($name . '=' . $value);
        }

        return;
    }
}

function env_value(string $name, ?string $default = null): string
{
    $value = $_ENV[$name] ?? $_SERVER[$name] ?? getenv($name);

    if ($value === false || $value === null || $value === '') {
        if ($default !== null) {
            return $default;
        }

        throw new RuntimeException('Missing required environment value: ' . $name);
    }

    return (string) $value;
}

load_env_file();

return [
    'db' => [
        'host' => env_value('DB_HOST', 'localhost'),
        'port' => (int) env_value('DB_PORT', '3306'),
        'name' => env_value('DB_NAME'),
        'user' => env_value('DB_USER'),
        'pass' => env_value('DB_PASS'),
        'charset' => env_value('DB_CHARSET', 'utf8mb4'),
    ],
    'admin' => [
        'email' => strtolower(env_value('ADMIN_EMAIL')),
        'password' => env_value('ADMIN_PASSWORD'),
    ],
    'security' => [
        'app_secret' => env_value('APP_SECRET', ''),
        'crawler_callback_token' => env_value('CRAWLER_CALLBACK_TOKEN', ''),
    ],
    'worker' => [
        'url' => rtrim(env_value('CRAWLER_WORKER_URL', ''), '/'),
        'api_token' => env_value('CRAWLER_API_TOKEN', ''),
    ],
    'openai' => [
        'api_key' => env_value('OPENAI_API_KEY', ''),
        'model' => env_value('OPENAI_MODEL', 'gpt-5.4-nano'),
    ],
];
