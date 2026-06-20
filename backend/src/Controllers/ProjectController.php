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
            $like = '%' . str_replace(['%', '_'], ['\%', '\_'], $query) . '%';
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
        if (isset($data['status']) && in_array($data['status'], self::VALID_STATUSES, true)) {
            $updates[] = 'status = ?';
            $bindings[] = $data['status'];
        }
        if (isset($data['config']) || isset($data['config_json'])) {
            $config = $data['config'] ?? $data['config_json'];
            $updates[] = 'config_json = ?';
            $bindings[] = is_string($config) ? $config : json_encode($config);
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

    private function thumbnailFor(int $projectId, int $chosenGenId, string $uploadsDir): ?string
    {
        if ($chosenGenId > 0) {
            $candidate = $uploadsDir . '/projects/' . $projectId . '/generation_' . $chosenGenId . '.png';
            if (is_file($candidate)) {
                return '/uploads/projects/' . $projectId . '/generation_' . $chosenGenId . '.png?t=' . filemtime($candidate);
            }
        }
        $dir = $uploadsDir . '/projects/' . $projectId;
        if (is_dir($dir)) {
            $files = glob($dir . '/generation_*.png') ?: [];
            sort($files);
            if (!empty($files)) {
                $f = $files[0];
                $name = basename($f);
                return '/uploads/projects/' . $projectId . '/' . $name . '?t=' . filemtime($f);
            }
        }
        return null;
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
