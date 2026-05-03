<?php

declare(strict_types=1);

namespace App\Controllers;

use App\Config\Database;
use App\Config\Paths;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class GenerationController
{
    /** Submit a generate job for a project; non-blocking — caller polls /jobs/{id}. */
    public function generate(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        $projectId = (int) $args['id'];
        $data = $request->getParsedBody() ?? [];

        $db = Database::getConnection();
        $stmt = $db->prepare('SELECT id, type, title, config_json FROM projects WHERE id = ? AND user_id = ?');
        $stmt->execute([$projectId, $userId]);
        $project = $stmt->fetch();
        if (!$project) {
            return $this->json($response, ['error' => true, 'message' => 'Project not found'], 404);
        }

        $config = json_decode($project['config_json'] ?? '{}', true) ?: [];
        $prompt = trim((string) ($data['prompt'] ?? ''));
        if ($prompt === '') {
            $prompt = trim((string) ($config['description'] ?? ''));
        }
        if ($prompt === '') {
            $prompt = $project['title'] ?: 'Design';
        }

        $payload = [
            'prompt' => $prompt,
            'num_concepts' => max(1, min(4, (int) ($config['numConcepts'] ?? ($data['num_concepts'] ?? 1)))),
            'width' => (int) ($data['width'] ?? 1024),
            'height' => (int) ($data['height'] ?? 1024),
            'steps' => (int) ($data['steps'] ?? 25),
            'cfg_scale' => (float) ($data['cfg_scale'] ?? 4.0),
            'seed' => isset($data['seed']) ? (int) $data['seed'] : null,
        ];

        $jobId = $this->aiPostAsync('/api/generate/async', $payload);

        $stmt = $db->prepare('UPDATE projects SET status = ?, ai_job_id = ?, updated_at = NOW() WHERE id = ?');
        $stmt->execute(['generating', $jobId, $projectId]);

        // Stash the prompt so we can label generations when the job finishes.
        $config['_last_prompt'] = $prompt;
        $stmt = $db->prepare('UPDATE projects SET config_json = ? WHERE id = ?');
        $stmt->execute([json_encode($config), $projectId]);

        return $this->json($response, [
            'job_id' => $jobId,
            'status' => $jobId ? 'queued' : 'failed',
            'message' => $jobId ? 'Generation started.' : 'AI service unreachable.',
        ], $jobId ? 202 : 502);
    }

    /** Submit an edit job — takes the chosen generation (or an explicit URL) plus an instruction. */
    public function edit(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        $projectId = (int) $args['id'];
        $data = $request->getParsedBody() ?? [];

        $prompt = trim((string) ($data['prompt'] ?? ''));
        $imageUrl = trim((string) ($data['image_url'] ?? ''));

        if ($prompt === '') {
            return $this->json($response, ['error' => true, 'message' => 'prompt is required'], 400);
        }

        $db = Database::getConnection();
        $stmt = $db->prepare('SELECT id, chosen_generation_id FROM projects WHERE id = ? AND user_id = ?');
        $stmt->execute([$projectId, $userId]);
        $project = $stmt->fetch();
        if (!$project) {
            return $this->json($response, ['error' => true, 'message' => 'Project not found'], 404);
        }

        if ($imageUrl === '') {
            // Fall back to the chosen generation
            if (!empty($project['chosen_generation_id'])) {
                $stmt = $db->prepare('SELECT output_image_url FROM generations WHERE id = ?');
                $stmt->execute([$project['chosen_generation_id']]);
                $row = $stmt->fetch();
                if ($row) {
                    $imageUrl = (string) $row['output_image_url'];
                }
            }
        }

        if ($imageUrl === '') {
            return $this->json($response, ['error' => true, 'message' => 'No image to edit'], 400);
        }

        $bytes = $this->loadImageBytes($imageUrl);
        if ($bytes === null) {
            return $this->json($response, ['error' => true, 'message' => 'Source image not found: ' . $imageUrl], 404);
        }

        $payload = [
            'prompt' => $prompt,
            'ref_images' => [base64_encode($bytes)],
            'steps' => (int) ($data['steps'] ?? 25),
            'cfg_scale' => (float) ($data['cfg_scale'] ?? 4.0),
            'img_cfg_scale' => (float) ($data['img_cfg_scale'] ?? 1.0),
        ];

        $jobId = $this->aiPostAsync('/api/edit/async', $payload);

        $stmt = $db->prepare('UPDATE projects SET ai_job_id = ?, status = ?, updated_at = NOW() WHERE id = ?');
        $stmt->execute([$jobId, 'generating', $projectId]);

        return $this->json($response, [
            'job_id' => $jobId,
            'status' => $jobId ? 'queued' : 'failed',
            'kind' => 'edit',
        ], $jobId ? 202 : 502);
    }

    /** List a project's generations. Auto-saves any completed AI job before responding. */
    public function listForProject(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        $projectId = (int) $args['id'];

        $db = Database::getConnection();
        $stmt = $db->prepare('SELECT id, ai_job_id, status, config_json FROM projects WHERE id = ? AND user_id = ?');
        $stmt->execute([$projectId, $userId]);
        $project = $stmt->fetch();
        if (!$project) {
            return $this->json($response, ['error' => true, 'message' => 'Project not found'], 404);
        }

        if (!empty($project['ai_job_id'])) {
            $this->checkAndSaveJob($projectId);
            $stmt = $db->prepare('SELECT status, ai_job_id FROM projects WHERE id = ?');
            $stmt->execute([$projectId]);
            $project = array_merge($project, $stmt->fetch() ?: []);
        }

        $stmt = $db->prepare(
            'SELECT id, project_id, parent_generation_id, prompt, model, kind, output_image_url, width, height, is_chosen, created_at
             FROM generations WHERE project_id = ? ORDER BY created_at ASC'
        );
        $stmt->execute([$projectId]);
        $generations = array_map(function ($row) {
            $row['is_chosen'] = (bool) $row['is_chosen'];
            return $row;
        }, $stmt->fetchAll());

        return $this->json($response, [
            'generations' => $generations,
            'project_status' => $project['status'] ?? 'unknown',
            'ai_job_id' => $project['ai_job_id'] ?? null,
        ]);
    }

    public function chooseGeneration(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        $projectId = (int) $args['id'];
        $genId = (int) $args['genId'];

        $db = Database::getConnection();
        $stmt = $db->prepare('SELECT p.id FROM projects p WHERE p.id = ? AND p.user_id = ?');
        $stmt->execute([$projectId, $userId]);
        if (!$stmt->fetch()) {
            return $this->json($response, ['error' => true, 'message' => 'Project not found'], 404);
        }
        $stmt = $db->prepare('SELECT id FROM generations WHERE id = ? AND project_id = ?');
        $stmt->execute([$genId, $projectId]);
        if (!$stmt->fetch()) {
            return $this->json($response, ['error' => true, 'message' => 'Generation not found'], 404);
        }

        $stmt = $db->prepare('UPDATE generations SET is_chosen = 0 WHERE project_id = ?');
        $stmt->execute([$projectId]);
        $stmt = $db->prepare('UPDATE generations SET is_chosen = 1 WHERE id = ?');
        $stmt->execute([$genId]);
        $stmt = $db->prepare('UPDATE projects SET chosen_generation_id = ?, status = ?, updated_at = NOW() WHERE id = ?');
        $stmt->execute([$genId, 'editing', $projectId]);

        return $this->json($response, ['message' => 'Generation chosen', 'generation_id' => $genId]);
    }

    public function getJobStatus(Request $request, Response $response, array $args): Response
    {
        $jobId = (string) $args['jobId'];
        $url = $this->aiUrl() . '/api/jobs/' . rawurlencode($jobId);

        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 5,
        ]);
        $body = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($code === 200 && $body) {
            $response->getBody()->write($body);
            return $response->withHeader('Content-Type', 'application/json');
        }
        return $this->json($response, ['job_id' => $jobId, 'status' => 'unknown', 'progress' => 0]);
    }

    /** Poll the AI service for the project's current job and persist any results. */
    private function checkAndSaveJob(int $projectId): void
    {
        $db = Database::getConnection();
        $stmt = $db->prepare('SELECT id, ai_job_id, status, config_json FROM projects WHERE id = ?');
        $stmt->execute([$projectId]);
        $project = $stmt->fetch();
        if (!$project || empty($project['ai_job_id'])) {
            return;
        }

        $url = $this->aiUrl() . '/api/jobs/' . rawurlencode($project['ai_job_id']);
        $ch = curl_init($url);
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 5]);
        $body = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if (!$body) {
            return;
        }
        $data = json_decode($body, true) ?: [];
        $jobStatus = $data['status'] ?? '';

        if ($code === 404 || $jobStatus === 'failed') {
            $stmt = $db->prepare('UPDATE projects SET status = ?, ai_job_id = NULL, updated_at = NOW() WHERE id = ?');
            $stmt->execute(['draft', $projectId]);
            return;
        }
        if ($jobStatus !== 'completed') {
            return;
        }

        $images = $data['result']['images'] ?? [];
        if (empty($images)) {
            return;
        }

        $config = json_decode($project['config_json'] ?? '{}', true) ?: [];
        $prompt = (string) ($config['_last_prompt'] ?? 'Generated design');
        $kind = ($data['type'] ?? 'generate') === 'edit' ? 'edit' : 'concept';
        $model = (string) ($data['result']['model'] ?? 'sensenova-u1');
        $width = (int) ($data['result']['width'] ?? 1024);
        $height = (int) ($data['result']['height'] ?? 1024);

        $projectDir = $this->uploadsDir() . '/projects/' . $projectId;
        if (!is_dir($projectDir)) {
            mkdir($projectDir, 0755, true);
        }

        // For edits, link this back to the chosen generation as the parent so the
        // FE can show an edit history.
        $parentId = null;
        if ($kind === 'edit') {
            $stmt = $db->prepare('SELECT chosen_generation_id FROM projects WHERE id = ?');
            $stmt->execute([$projectId]);
            $parentId = (int) ($stmt->fetch()['chosen_generation_id'] ?? 0) ?: null;
        }

        $insert = $db->prepare(
            'INSERT INTO generations (project_id, parent_generation_id, prompt, model, kind, output_image_url, width, height, is_chosen, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NOW())'
        );

        $newIds = [];
        foreach ($images as $i => $b64) {
            $bytes = base64_decode($b64);
            if ($bytes === false) {
                continue;
            }
            $insert->execute([$projectId, $parentId, $prompt, $model, $kind, '', $width, $height]);
            $genId = (int) $db->lastInsertId();
            $filename = 'generation_' . $genId . '.png';
            file_put_contents($projectDir . '/' . $filename, $bytes);
            $publicUrl = '/uploads/projects/' . $projectId . '/' . $filename;
            $update = $db->prepare('UPDATE generations SET output_image_url = ? WHERE id = ?');
            $update->execute([$publicUrl, $genId]);
            $newIds[] = $genId;
        }

        // For an edit job, auto-promote the new image to the chosen generation.
        if ($kind === 'edit' && !empty($newIds)) {
            $newGen = end($newIds);
            $stmt = $db->prepare('UPDATE generations SET is_chosen = 0 WHERE project_id = ?');
            $stmt->execute([$projectId]);
            $stmt = $db->prepare('UPDATE generations SET is_chosen = 1 WHERE id = ?');
            $stmt->execute([$newGen]);
            $stmt = $db->prepare('UPDATE projects SET chosen_generation_id = ?, status = ?, ai_job_id = NULL, updated_at = NOW() WHERE id = ?');
            $stmt->execute([$newGen, 'editing', $projectId]);
        } else {
            $stmt = $db->prepare('UPDATE projects SET status = ?, ai_job_id = NULL, updated_at = NOW() WHERE id = ?');
            $stmt->execute(['editing', $projectId]);
        }
    }

    private function aiPostAsync(string $path, array $payload): ?string
    {
        $url = $this->aiUrl() . $path;
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode($payload),
            CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Expect:'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 30,
        ]);
        $body = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($code !== 200 || !$body) {
            return null;
        }
        $data = json_decode($body, true) ?: [];
        return $data['job_id'] ?? null;
    }

    private function loadImageBytes(string $url): ?string
    {
        $clean = preg_replace('/\?.*$/', '', $url);
        $uploadsDir = $this->uploadsDir();
        if (str_starts_with($clean, '/uploads/')) {
            $path = $uploadsDir . substr($clean, strlen('/uploads'));
            return is_file($path) ? file_get_contents($path) : null;
        }
        if (filter_var($clean, FILTER_VALIDATE_URL)) {
            $bytes = @file_get_contents($clean);
            return $bytes ?: null;
        }
        $fallback = $uploadsDir . '/' . ltrim($clean, '/');
        return is_file($fallback) ? file_get_contents($fallback) : null;
    }

    private function aiUrl(): string
    {
        return rtrim($_ENV['AI_SERVICE_URL'] ?? 'http://127.0.0.1:8090', '/');
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
