<?php

require __DIR__ . '/../bootstrap.php';

const ACADEMY_DATA_FILE = __DIR__ . '/../academy-data.js';
const VIDEO_UPLOAD_DIR = __DIR__ . '/../videos';

$error = '';
$notice = '';

if (empty($_SESSION['csrf_token'])) {
    $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
}

if (isset($_GET['logout'])) {
    $_SESSION = [];
    session_destroy();
    header('Location: /admin/');
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['auth_action'] ?? '') === 'login') {
    $email = strtolower(trim($_POST['email'] ?? ''));
    $password = $_POST['password'] ?? '';
    $admin = app_config()['admin'];

    if ($email === $admin['email'] && hash_equals($admin['password'], $password)) {
        $_SESSION['admin_email'] = $admin['email'];
        header('Location: /admin/');
        exit;
    }

    $error = 'Ongeldige login.';
}

$isAdmin = ($_SESSION['admin_email'] ?? '') === app_config()['admin']['email'];

if ($isAdmin && $_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['video_action'] ?? '') !== '') {
    try {
        assert_valid_csrf($_POST['csrf_token'] ?? '');
        $videos = read_academy_videos();
        $action = $_POST['video_action'];

        if ($action === 'save') {
            $originalId = trim($_POST['original_id'] ?? '');
            $video = video_from_post($_POST, $_FILES['videoUpload'] ?? null);
            $existingIndex = find_video_index($videos, $originalId);

            if ($existingIndex === null) {
                $existingIndex = find_video_index($videos, $video['id']);
            }

            foreach ($videos as $index => $existingVideo) {
                if ($index !== $existingIndex && $existingVideo['id'] === $video['id']) {
                    throw new RuntimeException('Deze video-id bestaat al. Kies een unieke id.');
                }
            }

            if ($existingIndex === null) {
                $videos[] = $video;
            } else {
                $videos[$existingIndex] = $video;
            }

            write_academy_videos($videos);
            header('Location: /admin/?saved=1&edit=' . rawurlencode($video['id']));
            exit;
        }

        if ($action === 'move_up' || $action === 'move_down') {
            $moveId = trim($_POST['move_id'] ?? '');
            $index = find_video_index($videos, $moveId);
            if ($index === null) {
                throw new RuntimeException('Geen video gekozen om te verplaatsen.');
            }

            $targetIndex = $action === 'move_up' ? $index - 1 : $index + 1;
            if (isset($videos[$targetIndex])) {
                $current = $videos[$index];
                $videos[$index] = $videos[$targetIndex];
                $videos[$targetIndex] = $current;
                write_academy_videos($videos);
            }

            header('Location: /admin/?saved=1&edit=' . rawurlencode($moveId));
            exit;
        }

        if ($action === 'delete') {
            $deleteId = trim($_POST['delete_id'] ?? '');
            if ($deleteId === '') {
                throw new RuntimeException('Geen video gekozen om te verwijderen.');
            }

            $videos = array_values(array_filter($videos, function (array $video) use ($deleteId): bool {
                return ($video['id'] ?? '') !== $deleteId;
            }));
            write_academy_videos($videos);
            header('Location: /admin/?deleted=1');
            exit;
        }
    } catch (Throwable $exception) {
        $error = $exception->getMessage();
    }
}

if (isset($_GET['saved'])) {
    $notice = 'Wijzigingen opgeslagen.';
}
if (isset($_GET['deleted'])) {
    $notice = 'Video verwijderd.';
}

$videos = $isAdmin ? read_academy_videos() : [];
$editId = $isAdmin ? trim($_GET['edit'] ?? '') : '';
$editing = $isAdmin ? selected_video($videos, $editId) : null;
$formVideo = $editing ?? empty_video();
$categories = unique_values($videos, 'category');
$levels = unique_values($videos, 'level');
$totalTags = unique_tags($videos);

function assert_valid_csrf(string $token): void
{
    if (!hash_equals($_SESSION['csrf_token'] ?? '', $token)) {
        throw new RuntimeException('Sessie verlopen. Vernieuw de pagina en probeer opnieuw.');
    }
}

function read_academy_videos(): array
{
    if (!is_file(ACADEMY_DATA_FILE)) {
        return [];
    }

    $contents = file_get_contents(ACADEMY_DATA_FILE);
    if ($contents === false) {
        throw new RuntimeException('Kan academy-data.js niet lezen.');
    }

    if (!preg_match('/window\.CAPTEER_ACADEMY_VIDEOS\s*=\s*(\[.*\])\s*;\s*$/s', trim($contents), $matches)) {
        throw new RuntimeException('academy-data.js heeft geen herkenbaar JSON-formaat.');
    }

    $videos = json_decode($matches[1], true);
    if (!is_array($videos)) {
        throw new RuntimeException('academy-data.js bevat ongeldige JSON: ' . json_last_error_msg());
    }

    return array_values(array_map('normalize_video', $videos));
}

function write_academy_videos(array $videos): void
{
    $normalized = array_values(array_map('normalize_video', $videos));
    $json = json_encode($normalized, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

    if ($json === false) {
        throw new RuntimeException('Kan videodata niet omzetten naar JSON.');
    }

    if (file_put_contents(ACADEMY_DATA_FILE, "window.CAPTEER_ACADEMY_VIDEOS = " . $json . ";\n", LOCK_EX) === false) {
        throw new RuntimeException('Kan academy-data.js niet schrijven. Controleer bestandsrechten.');
    }
}

function normalize_video(array $video): array
{
    $type = trim((string) ($video['videoType'] ?? 'file'));
    if (!in_array($type, ['file', 'youtube'], true)) {
        $type = 'file';
    }

    return [
        'id' => trim((string) ($video['id'] ?? '')),
        'title' => trim((string) ($video['title'] ?? '')),
        'category' => trim((string) ($video['category'] ?? '')),
        'tags' => array_values(array_filter(array_map('trim', $video['tags'] ?? []))),
        'duration' => trim((string) ($video['duration'] ?? '')),
        'level' => trim((string) ($video['level'] ?? '')),
        'videoType' => $type,
        'videoSrc' => trim((string) ($video['videoSrc'] ?? '')),
        'youtubeUrl' => trim((string) ($video['youtubeUrl'] ?? '')),
        'youtubeId' => trim((string) ($video['youtubeId'] ?? '')),
        'summary' => trim((string) ($video['summary'] ?? '')),
        'body' => trim((string) ($video['body'] ?? '')),
    ];
}

function video_from_post(array $post, ?array $upload): array
{
    $title = trim((string) ($post['title'] ?? ''));
    $id = slugify(trim((string) ($post['id'] ?? '')) ?: $title);
    $category = trim((string) ($post['category'] ?? ''));
    $videoType = in_array(($post['videoType'] ?? 'file'), ['file', 'youtube'], true) ? $post['videoType'] : 'file';
    $videoSrc = trim((string) ($post['videoSrc'] ?? ''));
    $youtubeUrl = trim((string) ($post['youtubeUrl'] ?? ''));
    $youtubeId = '';

    if ($id === '') {
        throw new RuntimeException('Vul een titel of video-id in.');
    }
    if ($title === '') {
        throw new RuntimeException('Vul een titel in.');
    }
    if ($category === '') {
        throw new RuntimeException('Vul een categorie in.');
    }

    if ($videoType === 'youtube') {
        $youtubeId = extract_youtube_id($youtubeUrl);
        if ($youtubeId === '') {
            throw new RuntimeException('Vul een geldige YouTube URL of video-id in.');
        }
        $videoSrc = $youtubeUrl;
    } else {
        $uploadedPath = save_uploaded_video($upload, $id);
        if ($uploadedPath !== '') {
            $videoSrc = $uploadedPath;
        }
        if ($videoSrc === '') {
            throw new RuntimeException('Vul een videopad in of upload een videobestand.');
        }
        $youtubeUrl = '';
    }

    return normalize_video([
        'id' => $id,
        'title' => $title,
        'category' => $category,
        'tags' => tags_from_string((string) ($post['tags'] ?? '')),
        'duration' => (string) ($post['duration'] ?? ''),
        'level' => (string) ($post['level'] ?? ''),
        'videoType' => $videoType,
        'videoSrc' => $videoSrc,
        'youtubeUrl' => $youtubeUrl,
        'youtubeId' => $youtubeId,
        'summary' => (string) ($post['summary'] ?? ''),
        'body' => (string) ($post['body'] ?? ''),
    ]);
}

function save_uploaded_video(?array $upload, string $id): string
{
    if (!$upload || ($upload['error'] ?? UPLOAD_ERR_NO_FILE) === UPLOAD_ERR_NO_FILE) {
        return '';
    }
    if (($upload['error'] ?? UPLOAD_ERR_OK) !== UPLOAD_ERR_OK) {
        throw new RuntimeException('Upload mislukt. Controleer de maximale uploadgrootte van PHP/hosting.');
    }

    $original = (string) ($upload['name'] ?? 'video.mp4');
    $extension = strtolower(pathinfo($original, PATHINFO_EXTENSION));
    $allowed = ['mp4', 'webm', 'mov', 'm4v'];
    if (!in_array($extension, $allowed, true)) {
        throw new RuntimeException('Alleen mp4, webm, mov en m4v zijn toegestaan.');
    }

    if (!is_dir(VIDEO_UPLOAD_DIR) && !mkdir(VIDEO_UPLOAD_DIR, 0755, true)) {
        throw new RuntimeException('Kan de videos-map niet aanmaken.');
    }

    $targetName = $id . '-' . date('Ymd-His') . '.' . $extension;
    $targetPath = VIDEO_UPLOAD_DIR . '/' . $targetName;
    if (!move_uploaded_file((string) $upload['tmp_name'], $targetPath)) {
        throw new RuntimeException('Kan het videobestand niet opslaan.');
    }

    return 'videos/' . $targetName;
}

function extract_youtube_id(string $value): string
{
    $value = trim($value);
    if (preg_match('/^[a-zA-Z0-9_-]{11}$/', $value)) {
        return $value;
    }
    if (preg_match('/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/', $value, $matches)) {
        return $matches[1];
    }

    return '';
}

function tags_from_string(string $tags): array
{
    return array_values(array_unique(array_filter(array_map('trim', explode(',', $tags)))));
}

function tags_to_string(array $tags): string
{
    return implode(', ', array_values(array_filter(array_map('trim', $tags))));
}

function slugify(string $value): string
{
    $value = strtolower(trim($value));
    $value = preg_replace('/[^a-z0-9]+/i', '-', $value) ?? '';

    return strtolower(trim($value, '-'));
}

function find_video_index(array $videos, string $id): ?int
{
    foreach ($videos as $index => $video) {
        if ($id !== '' && ($video['id'] ?? '') === $id) {
            return $index;
        }
    }

    return null;
}

function selected_video(array $videos, string $id): ?array
{
    $index = find_video_index($videos, $id);

    return $index === null ? null : $videos[$index];
}

function video_preview_src(array $video): string
{
    if (($video['videoType'] ?? 'file') === 'youtube') {
        return 'https://www.youtube-nocookie.com/embed/' . rawurlencode($video['youtubeId'] ?? '') . '?rel=0&modestbranding=1&playsinline=1';
    }

    return '/' . ltrim((string) ($video['videoSrc'] ?? ''), '/');
}

function local_video_status(array $video): string
{
    if (($video['videoType'] ?? 'file') === 'youtube') {
        return 'YouTube embed via youtube-nocookie.com. rel=0 beperkt suggesties tot hetzelfde kanaal.';
    }

    $videoSrc = (string) ($video['videoSrc'] ?? '');
    if ($videoSrc === '') {
        return 'Geen videopad ingevuld.';
    }

    $path = realpath(__DIR__ . '/../' . ltrim($videoSrc, '/'));
    $publicRoot = realpath(__DIR__ . '/..');
    if ($path !== false && $publicRoot !== false && strpos($path, $publicRoot) === 0 && is_file($path)) {
        return 'Bestand gevonden in deze public_html.';
    }

    return 'Bestand niet in deze uploadmap. Dat is prima als de video al op de server staat.';
}

function empty_video(): array
{
    return [
        'id' => '',
        'title' => '',
        'category' => '',
        'tags' => [],
        'duration' => '',
        'level' => '',
        'videoType' => 'youtube',
        'videoSrc' => 'videos/',
        'youtubeUrl' => '',
        'youtubeId' => '',
        'summary' => '',
        'body' => '',
    ];
}

function unique_values(array $videos, string $key): array
{
    $values = array_map(function (array $video) use ($key): string {
        return trim((string) ($video[$key] ?? ''));
    }, $videos);
    $values = array_values(array_unique(array_filter($values)));
    sort($values, SORT_NATURAL | SORT_FLAG_CASE);

    return $values;
}

function unique_tags(array $videos): array
{
    $tags = [];
    foreach ($videos as $video) {
        $tags = array_merge($tags, $video['tags'] ?? []);
    }
    $tags = array_values(array_unique(array_filter(array_map('trim', $tags))));
    sort($tags, SORT_NATURAL | SORT_FLAG_CASE);

    return $tags;
}

?><!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Capteer Instruct Admin</title>
  <link rel="stylesheet" href="/admin.css">
</head>
<body>
<?php if (!$isAdmin): ?>
  <main class="login-page">
    <form class="login-card" method="post" action="/admin/">
      <input type="hidden" name="auth_action" value="login">
      <h1>Admin login</h1>
      <?php if ($error): ?><p class="error"><?= e($error) ?></p><?php endif; ?>
      <label>E-mail <input type="email" name="email" autocomplete="email" required></label>
      <label>Wachtwoord <input type="password" name="password" autocomplete="current-password" required></label>
      <button type="submit">Inloggen</button>
    </form>
  </main>
<?php else: ?>
  <main class="dashboard admin-manager">
    <header class="dashboard-header">
      <div>
        <h1>Bibliotheekbeheer</h1>
        <p>Beheer upload-video's en YouTube-video's voor de publieke academy.</p>
      </div>
      <div class="actions">
        <a class="button secondary" href="/admin/crawls/">Crawlerbeheer</a>
        <a class="button secondary" href="/">Naar academy</a>
        <a class="button secondary" href="/admin/?logout=1">Uitloggen</a>
      </div>
    </header>

    <?php if ($notice): ?><p class="notice"><?= e($notice) ?></p><?php endif; ?>
    <?php if ($error): ?><p class="error panel-message"><?= e($error) ?></p><?php endif; ?>

    <section class="stats">
      <div class="stat"><strong><?= count($videos) ?></strong><span>Video's</span></div>
      <div class="stat"><strong><?= count($categories) ?></strong><span>Categorieen</span></div>
      <div class="stat"><strong><?= count($totalTags) ?></strong><span>Tags</span></div>
    </section>

    <section class="manager-grid">
      <aside class="video-admin-list" aria-label="Video's">
        <div class="list-head"><h2>Video's</h2><a class="button" href="/admin/">Nieuwe video</a></div>
        <?php foreach ($videos as $index => $video): ?>
          <article class="admin-video-card<?= ($video['id'] === ($editing['id'] ?? '')) ? ' active' : '' ?>">
            <div>
              <span><?= e($video['category']) ?> · <?= e($video['videoType'] === 'youtube' ? 'YouTube' : 'Upload/bestand') ?></span>
              <strong><?= e($video['title']) ?></strong>
              <small><?= e($video['videoType'] === 'youtube' ? ($video['youtubeUrl'] ?: $video['youtubeId']) : $video['videoSrc']) ?></small>
              <em><?= e(local_video_status($video)) ?></em>
            </div>
            <div class="row-actions">
              <a class="button secondary" href="/admin/?edit=<?= rawurlencode($video['id']) ?>">Bewerk</a>
              <form method="post" action="/admin/"><input type="hidden" name="csrf_token" value="<?= e($_SESSION['csrf_token']) ?>"><input type="hidden" name="video_action" value="move_up"><input type="hidden" name="move_id" value="<?= e($video['id']) ?>"><button class="secondary-button" type="submit" <?= $index === 0 ? 'disabled' : '' ?>>Omhoog</button></form>
              <form method="post" action="/admin/"><input type="hidden" name="csrf_token" value="<?= e($_SESSION['csrf_token']) ?>"><input type="hidden" name="video_action" value="move_down"><input type="hidden" name="move_id" value="<?= e($video['id']) ?>"><button class="secondary-button" type="submit" <?= $index === count($videos) - 1 ? 'disabled' : '' ?>>Omlaag</button></form>
              <form method="post" action="/admin/" onsubmit="return confirm('Deze video verwijderen?');"><input type="hidden" name="csrf_token" value="<?= e($_SESSION['csrf_token']) ?>"><input type="hidden" name="video_action" value="delete"><input type="hidden" name="delete_id" value="<?= e($video['id']) ?>"><button class="danger" type="submit">Verwijder</button></form>
            </div>
          </article>
        <?php endforeach; ?>
        <?php if (!$videos): ?><p class="empty">Nog geen video's.</p><?php endif; ?>
      </aside>

      <section class="editor-panel">
        <h2><?= $editing ? 'Video bewerken' : 'Nieuwe video' ?></h2>
        <form class="video-form" method="post" action="/admin/" enctype="multipart/form-data">
          <input type="hidden" name="csrf_token" value="<?= e($_SESSION['csrf_token']) ?>">
          <input type="hidden" name="video_action" value="save">
          <input type="hidden" name="original_id" value="<?= e($editing['id'] ?? '') ?>">

          <div class="form-grid">
            <label>Titel <input type="text" name="title" value="<?= e($formVideo['title']) ?>" required></label>
            <label>Video-id <input type="text" name="id" value="<?= e($formVideo['id']) ?>" placeholder="automatisch-op-basis-van-titel"></label>
            <label>Categorie <input type="text" name="category" value="<?= e($formVideo['category']) ?>" list="category-options" required></label>
            <label>Niveau <input type="text" name="level" value="<?= e($formVideo['level']) ?>" list="level-options"></label>
            <label>Duur <input type="text" name="duration" value="<?= e($formVideo['duration']) ?>" placeholder="2:48"></label>
            <label>Bron
              <select name="videoType">
                <option value="youtube" <?= $formVideo['videoType'] === 'youtube' ? 'selected' : '' ?>>YouTube URL</option>
                <option value="file" <?= $formVideo['videoType'] === 'file' ? 'selected' : '' ?>>Upload of bestand op server</option>
              </select>
            </label>
          </div>

          <label>YouTube URL of video-id <input type="text" name="youtubeUrl" value="<?= e($formVideo['youtubeUrl'] ?: $formVideo['youtubeId']) ?>" placeholder="https://www.youtube.com/watch?v=..."></label>
          <label>Bestaand videopad <input type="text" name="videoSrc" value="<?= e($formVideo['videoSrc']) ?>" placeholder="videos/bestand.mp4"></label>
          <label>Videobestand uploaden <input type="file" name="videoUpload" accept="video/mp4,video/webm,video/quicktime,.m4v"></label>
          <label>Tags, gescheiden met komma's <input type="text" name="tags" value="<?= e(tags_to_string($formVideo['tags'])) ?>" placeholder="account, basis, beheer"></label>
          <label>Samenvatting <textarea name="summary" rows="3"><?= e($formVideo['summary']) ?></textarea></label>
          <label>Uitleg <textarea name="body" rows="7"><?= e($formVideo['body']) ?></textarea></label>

          <div class="form-actions">
            <button type="submit">Opslaan</button>
            <?php if ($editing): ?><a class="button secondary" href="/admin/">Annuleer</a><?php endif; ?>
          </div>
        </form>

        <datalist id="category-options"><?php foreach ($categories as $category): ?><option value="<?= e($category) ?>"></option><?php endforeach; ?></datalist>
        <datalist id="level-options"><?php foreach ($levels as $level): ?><option value="<?= e($level) ?>"></option><?php endforeach; ?></datalist>

        <div class="preview-panel">
          <h2>Preview</h2>
          <p class="video-status"><?= e(local_video_status($formVideo)) ?></p>
          <?php if (($formVideo['videoType'] ?? 'file') === 'youtube' && $formVideo['youtubeId']): ?>
            <iframe src="<?= e(video_preview_src($formVideo)) ?>" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>
          <?php elseif ($formVideo['videoSrc']): ?>
            <video controls playsinline preload="metadata" src="<?= e(video_preview_src($formVideo)) ?>"></video>
          <?php else: ?>
            <p class="empty">Vul een videobron in voor preview.</p>
          <?php endif; ?>
        </div>
      </section>
    </section>
  </main>
<?php endif; ?>
</body>
</html>