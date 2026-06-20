<?php

declare(strict_types=1);

namespace App\Controllers;

use App\Config\Database;
use App\Config\Paths;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class ProjectController
{
    private const VALID_TYPES = ['logo', 'flyer', 'banner', 'social', 'custom'];
    private const VALID_STATUSES = ['draft', 'generating', 'editing', 'exported', 'archived'];

    public function list(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        $params = $request->getQueryParams();
        $page = max(1, (int) ($params['page'] ?? 1));
        $limit = min(50, max(1, (int) ($params['limit'] ?? 20)));
        $offset = ($page - 1) * $limit;
        $statusFilter = $params['status'] ?? null;
        $query = trim((string) ($params['q'] ?? ''));

        $db = Database::getConnection();

        $where = 'WHERE user_id = ?';
        $bindings = [$userId];
        if ($statusFilter && in_array($statusFilter, self::VALID_STATUSES, true)) {
            $where .= ' AND status = ?';
            $bindings[] = $statusFilter;
        } else {
            $where .= ' AND status != ?';
            $bindings[] = 'archived';
        }
        if ($query !== '') {
            // Match against title or project type so users can search "logo" or by name.
            $where .= ' AND (title LIKE ? OR type LIKE ?)';
            // Escape the backslash first, then the LIKE wildcards (MySQL's default escape is '\').
            $like = '%' . str_replace(['\\', '%', '_'], ['\\\\', '\%', '\_'], $query) . '%';
            $bindings[] = $like;
            $bindings[] = $like;
        }

        $countStmt = $db->prepare("SELECT COUNT(*) AS total FROM projects {$where}");
        $countStmt->execute($bindings);
        $total = (int) $countStmt->fetch()['total'];

        $bindings[] = $limit;
        $bindings[] = $offset;
        $stmt = $db->prepare(
            "SELECT id, user_id, type, title, status, config_json, chosen_generation_id, created_at, updated_at
             FROM projects {$where}
             ORDER BY updated_at DESC
             LIMIT ? OFFSET ?"
        );
        $stmt->execute($bindings);
        $projects = $stmt->fetchAll();

        $uploadsDir = $this->uploadsDir();
        foreach ($projects as &$project) {
            $project['config'] = json_decode($project['config_json'] ?? '{}', true) ?: [];
            unset($project['config_json']);
            $thumb = $this->thumbnailFor((int) $project['id'], (int) ($project['chosen_generation_id'] ?? 0), $uploadsDir);
            if ($thumb) {
                $project['thumbnail_url'] = $thumb;
            }
        }

        return $this->json($response, [
            'projects' => $projects,
            'total' => $total,
            'pagination' => [
                'page' => $page,
                'limit' => $limit,
                'total' => $total,
                'pages' => (int) ceil($total / $limit),
            ],
        ]);
    }

    public function create(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        $data = $request->getParsedBody() ?? [];

        $type = $data['type'] ?? '';
        $title = trim($data['title'] ?? '');
        $config = $data['config'] ?? $data['config_json'] ?? [];

        if (!in_array($type, self::VALID_TYPES, true)) {
            return $this->json($response, [
                'error' => true,
                'message' => 'Invalid project type. Must be one of: ' . implode(', ', self::VALID_TYPES),
            ], 400);
        }
        if ($title === '') {
            $title = ucfirst($type) . ' Project';
        }
        if (is_string($config)) {
            $config = json_decode($config, true) ?: [];
        }

        $db = Database::getConnection();
        $stmt = $db->prepare(
            'INSERT INTO projects (user_id, type, title, status, config_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, NOW(), NOW())'
        );
        $stmt->execute([$userId, $type, $title, 'draft', json_encode($config)]);
        $projectId = (int) $db->lastInsertId();

        // Persist any inline base64 reference images so they don't have to be re-sent.
        $refImages = $config['referenceImages'] ?? [];
        $count = 0;
        if (!empty($refImages) && is_array($refImages)) {
            $refImages = array_slice(array_values($refImages), 0, 8); // cap number of refs
            $refDir = $this->uploadsDir() . '/projects/' . $projectId . '/references';
            if (!is_dir($refDir)) {
                mkdir($refDir, 0755, true);
            }
            foreach ($refImages as $i => $base64) {
                if (!is_string($base64)) {
                    continue;
                }
                if (str_contains($base64, ',')) { // tolerate data-URL prefix
                    $base64 = substr($base64, strpos($base64, ',') + 1);
                }
                $imageData = base64_decode($base64, true);
                if ($imageData === false || strlen($imageData) > 12 * 1024 * 1024) {
                    continue;
                }
                if (@getimagesizefromstring($imageData) === false) { // must be a real image
                    continue;
                }
                file_put_contents($refDir . '/ref_' . $i . '.png', $imageData);
                $count++;
            }
            unset($config['referenceImages']);
            $config['hasReferenceImages'] = $count > 0;
            $config['referenceImageCount'] = $count;
            $stmt = $db->prepare('UPDATE projects SET config_json = ? WHERE id = ?');
            $stmt->execute([json_encode($config), $projectId]);
        }

        // If the user uploaded an image to start from, store it as the chosen
        // "upload" generation so the studio shows it and it can be edited (it2i)
        // right away — reusing the whole edit/versions/export flow.
        if (is_string($config['uploadImage'] ?? null) && $config['uploadImage'] !== '') {
            $this->createUploadGeneration($db, $projectId, $config['uploadImage']);
            unset($config['uploadImage']);
            $config['hasUpload'] = true;
            $db->prepare('UPDATE projects SET config_json = ? WHERE id = ?')->execute([json_encode($config), $projectId]);
        }

        return $this->returnProject($response, $projectId, 201);
    }

    public function get(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        $projectId = (int) $args['id'];

        $db = Database::getConnection();
        $stmt = $db->prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?');
        $stmt->execute([$projectId, $userId]);
        $project = $stmt->fetch();

        if (!$project) {
            return $this->json($response, ['error' => true, 'message' => 'Project not found'], 404);
        }

        $project['config'] = json_decode($project['config_json'] ?? '{}', true) ?: [];
        unset($project['config_json']);

        $stmt = $db->prepare(
            'SELECT * FROM generations WHERE project_id = ? ORDER BY created_at ASC'
        );
        $stmt->execute([$projectId]);
        $project['generations'] = array_map(function ($row) {
            $row['is_chosen'] = (bool) $row['is_chosen'];
            return $row;
        }, $stmt->fetchAll());

        $project['chosen_generation'] = null;
        foreach ($project['generations'] as $g) {
            if ($g['is_chosen']) {
                $project['chosen_generation'] = $g;
                break;
            }
        }

        return $this->json($response, ['project' => $project]);
    }

    public function update(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        $projectId = (int) $args['id'];
        $data = $request->getParsedBody() ?? [];

        $db = Database::getConnection();
        $stmt = $db->prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?');
        $stmt->execute([$projectId, $userId]);
        if (!$stmt->fetch()) {
            return $this->json($response, ['error' => true, 'message' => 'Project not found'], 404);
        }

        $updates = [];
        $bindings = [];
        if (isset($data['title'])) {
            $updates[] = 'title = ?';
            $bindings[] = trim($data['title']);
        }
        // Only user-settable statuses; 'generating'/'exported' are driven by the
        // generate/export flows and must not be forced directly via PATCH.
        if (isset($data['status']) && in_array($data['status'], ['draft', 'editing', 'archived'], true)) {
            $updates[] = 'status = ?';
            $bindings[] = $data['status'];
        }
        if (isset($data['config']) || isset($data['config_json'])) {
            $incoming = $data['config'] ?? $data['config_json'];
            if (is_string($incoming)) {
                $incoming = json_decode($incoming, true) ?: [];
            }
            // Merge into the stored config so a partial update can't wipe server-managed
            // keys (e.g. _last_prompt, referenceImageCount).
            $cur = $db->prepare('SELECT config_json FROM projects WHERE id = ?');
            $cur->execute([$projectId]);
            $existing = json_decode($cur->fetch()['config_json'] ?? '{}', true) ?: [];
            $merged = array_merge($existing, is_array($incoming) ? $incoming : []);
            $updates[] = 'config_json = ?';
            $bindings[] = json_encode($merged);
        }

        if (empty($updates)) {
            return $this->json($response, ['error' => true, 'message' => 'No valid fields to update'], 400);
        }

        $updates[] = 'updated_at = NOW()';
        $bindings[] = $projectId;
        $sql = 'UPDATE projects SET ' . implode(', ', $updates) . ' WHERE id = ?';
        $stmt = $db->prepare($sql);
        $stmt->execute($bindings);

        return $this->returnProject($response, $projectId);
    }

    public function delete(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        $projectId = (int) $args['id'];

        $db = Database::getConnection();
        $stmt = $db->prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?');
        $stmt->execute([$projectId, $userId]);
        if (!$stmt->fetch()) {
            return $this->json($response, ['error' => true, 'message' => 'Project not found'], 404);
        }
        $stmt = $db->prepare('UPDATE projects SET status = ?, updated_at = NOW() WHERE id = ?');
        $stmt->execute(['archived', $projectId]);

        return $this->json($response, ['message' => 'Project archived']);
    }

    private function returnProject(Response $response, int $projectId, int $status = 200): Response
    {
        $db = Database::getConnection();
        $stmt = $db->prepare('SELECT * FROM projects WHERE id = ?');
        $stmt->execute([$projectId]);
        $project = $stmt->fetch();
        $project['config'] = json_decode($project['config_json'] ?? '{}', true) ?: [];
        unset($project['config_json']);
        return $this->json($response, ['project' => $project], $status);
    }

    /**
     * Save an uploaded image as the project's chosen "upload" generation. Normalises
     * to PNG and downscales to the model's 2048 sweet spot (bounds edit memory). The
     * studio then shows it as the current design and it2i edits work on it directly.
     */
    private function createUploadGeneration(\PDO $db, int $projectId, string $base64): void
    {
        if (str_contains($base64, ',')) { // tolerate data-URL prefix
            $base64 = substr($base64, strpos($base64, ',') + 1);
        }
        $bytes = base64_decode($base64, true);
        if ($bytes === false || strlen($bytes) > 12 * 1024 * 1024) {
            return;
        }
        $im = @imagecreatefromstring($bytes);
        if ($im === false) {
            return; // not a real/decodable image
        }
        $w = imagesx($im);
        $h = imagesy($im);
        $maxDim = 2048;
        if (max($w, $h) > $maxDim) {
            $scaled = imagescale($im, (int) round($w * $maxDim / max($w, $h))); // height auto (aspect kept)
            if ($scaled !== false) {
                imagedestroy($im);
                $im = $scaled;
                $w = imagesx($im);
                $h = imagesy($im);
            }
        }
        $projectDir = $this->uploadsDir() . '/projects/' . $projectId;
        if (!is_dir($projectDir)) {
            mkdir($projectDir, 0755, true);
        }
        $ins = $db->prepare(
            'INSERT INTO generations (project_id, parent_generation_id, prompt, model, kind, output_image_url, width, height, is_chosen, created_at)
             VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 0, NOW())'
        );
        $ins->execute([$projectId, 'Uploaded image', 'upload', 'upload', '', $w, $h]);
        $genId = (int) $db->lastInsertId();
        // Random suffix: these files are served unauthenticated (IDOR hardening).
        $filename = 'generation_' . $genId . '_' . bin2hex(random_bytes(4)) . '.png';
        $ok = imagepng($im, $projectDir . '/' . $filename);
        imagedestroy($im);
        if (!$ok) {
            $db->prepare('DELETE FROM generations WHERE id = ?')->execute([$genId]);
            return;
        }
        $publicUrl = '/uploads/projects/' . $projectId . '/' . $filename;
        $db->prepare('UPDATE generations SET output_image_url = ? WHERE id = ?')->execute([$publicUrl, $genId]);
        $db->prepare('UPDATE generations SET is_chosen = 0 WHERE project_id = ?')->execute([$projectId]);
        $db->prepare('UPDATE generations SET is_chosen = 1 WHERE id = ?')->execute([$genId]);
        $db->prepare('UPDATE projects SET chosen_generation_id = ?, status = ? WHERE id = ?')->execute([$genId, 'editing', $projectId]);
    }

    private function thumbnailFor(int $projectId, int $chosenGenId, string $uploadsDir): ?string
    {
        // Generation filenames carry a random suffix, so resolve via the stored URL
        // (not by reconstructing from the id). Prefer the chosen generation, else newest.
        $db = Database::getConnection();
        if ($chosenGenId > 0) {
            $stmt = $db->prepare('SELECT output_image_url FROM generations WHERE id = ? AND project_id = ?');
            $stmt->execute([$chosenGenId, $projectId]);
        } else {
            $stmt = $db->prepare('SELECT output_image_url FROM generations WHERE project_id = ? ORDER BY id DESC LIMIT 1');
            $stmt->execute([$projectId]);
        }
        $url = (string) (($stmt->fetch()['output_image_url'] ?? '') ?: '');
        if ($url === '') {
            return null;
        }
        $path = $uploadsDir . preg_replace('#^/uploads#', '', $url);
        return is_file($path) ? $url . '?t=' . filemtime($path) : $url;
    }

    private function uploadsDir(): string
    {
        return Paths::uploads();
    }

    private function json(Response $response, array $data, int $status = 200): Response
    {
        $response->getBody()->write(json_encode($data));
        return $response->withHeader('Content-Type', 'application/json')->withStatus($status);
    }
}
