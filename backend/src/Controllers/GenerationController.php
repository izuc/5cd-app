<?php

declare(strict_types=1);

namespace App\Controllers;

use App\Config\Database;
use App\Config\Paths;
use App\Services\Credits;
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
            'num_concepts' => max(1, min(6, (int) ($config['numConcepts'] ?? ($data['num_concepts'] ?? 1)))),
            'width' => max(256, min(4096, (int) ($data['width'] ?? 1024))),
            'height' => max(256, min(4096, (int) ($data['height'] ?? 1024))),
            'steps' => (int) ($data['steps'] ?? 8),
            'cfg_scale' => (float) ($data['cfg_scale'] ?? 1.0),
            'seed' => isset($data['seed']) ? (int) $data['seed'] : null,
            'enhance' => (bool) ($data['enhance'] ?? $config['enhance'] ?? false),
            // Unique concepts: the worker rewrites the prompt per concept (Qwen3) for variety.
            'vary_concepts' => (bool) ($config['varyConcepts'] ?? $data['vary_concepts'] ?? false),
            'design_type' => $project['type'] ?: null,
        ];

        // The single FLUX.2-klein worker handles both pure text-to-image and
        // reference-guided (image-to-image) generation. Pass any stored style
        // reference through so it conditions the generation.
        $refB64 = $this->loadProjectReference($projectId);
        if ($refB64 !== null) {
            $payload['ref_images'] = [$refB64];
            $payload['img_cfg_scale'] = 1.0;
        }

        // Generation costs 1 credit per concept (drawn from the daily free allowance
        // first, then purchased credits). Gate up-front; the actual charge happens on
        // delivery in checkAndSaveJob() so only concepts that succeed are billed.
        $needed = (int) $payload['num_concepts'];
        if (!Credits::canAfford($db, (int) $userId, $needed)) {
            return $this->json($response, [
                'error' => true,
                'code' => 'insufficient_credits',
                'message' => "Not enough credits — $needed concept(s) needs $needed credit(s). Buy more or generate fewer.",
            ], 402);
        }

        $jobId = $this->aiPostAsync('/api/generate/async', $payload);

        // Only flip the project into "generating" if the worker actually accepted the
        // job. Otherwise a transient AI outage would brick the project in a state with
        // no recovery path. Also stash the prompt to label the resulting generation.
        if ($jobId) {
            // A new generation run replaces the project's existing concepts/edits, so
            // clear them (and their files) and unselect the chosen design. This is what
            // the "regenerate replaces current concepts" confirmation promises.
            $old = $db->prepare('SELECT output_image_url FROM generations WHERE project_id = ?');
            $old->execute([$projectId]);
            foreach ($old->fetchAll() as $g) {
                $u = (string) ($g['output_image_url'] ?? '');
                if (str_starts_with($u, '/uploads/')) {
                    $f = $this->uploadsDir() . substr($u, strlen('/uploads'));
                    if (is_file($f)) {
                        @unlink($f);
                    }
                }
            }
            $db->prepare('DELETE FROM generations WHERE project_id = ?')->execute([$projectId]);

            $config['_last_prompt'] = $prompt;
            $stmt = $db->prepare('UPDATE projects SET status = ?, ai_job_id = ?, config_json = ?, chosen_generation_id = NULL, updated_at = NOW() WHERE id = ?');
            $stmt->execute(['generating', $jobId, json_encode($config), $projectId]);
        }

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

        $bytes = $this->loadImageBytes($imageUrl, $projectId);
        if ($bytes === null) {
            return $this->json($response, ['error' => true, 'message' => 'Source image not found: ' . $imageUrl], 404);
        }

        $payload = [
            'prompt' => $prompt,
            'ref_images' => [base64_encode($bytes)],
            'steps' => (int) ($data['steps'] ?? 4),
            // How strongly FLUX.2-klein follows the edit instruction. Higher = bigger
            // change. Null lets the worker use its default (4.0); the worker clamps 1–12.
            'guidance_scale' => isset($data['guidance_scale']) ? (float) $data['guidance_scale'] : null,
        ];

        // FLUX.2-klein does the edit as image-to-image (the source is the reference).
        $jobId = $this->aiPostAsync('/api/edit/async', $payload);

        // Only mark generating on a real job; label the resulting generation with the
        // edit instruction (not the previous generate prompt).
        if ($jobId) {
            $cfgStmt = $db->prepare('SELECT config_json FROM projects WHERE id = ?');
            $cfgStmt->execute([$projectId]);
            $cfg = json_decode(($cfgStmt->fetch()['config_json'] ?? '{}'), true) ?: [];
            $cfg['_last_prompt'] = $prompt;
            $stmt = $db->prepare('UPDATE projects SET ai_job_id = ?, status = ?, config_json = ?, updated_at = NOW() WHERE id = ?');
            $stmt->execute([$jobId, 'generating', json_encode($cfg), $projectId]);
        }

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
        $userId = $request->getAttribute('userId');
        $jobId = (string) $args['jobId'];

        // Only allow polling a job that belongs to one of the caller's projects
        // (prevents cross-user disclosure of generated images/prompts via job id).
        $db = Database::getConnection();
        $stmt = $db->prepare('SELECT config_json FROM projects WHERE ai_job_id = ? AND user_id = ?');
        $stmt->execute([$jobId, $userId]);
        $row = $stmt->fetch();
        if (!$row) {
            return $this->json($response, ['job_id' => $jobId, 'status' => 'unknown', 'progress' => 0], 404);
        }

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
        $stmt = $db->prepare('SELECT id, user_id, ai_job_id, status, config_json FROM projects WHERE id = ?');
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
            // Clear only THIS job (a newer one may already be queued), and don't knock a
            // project that already has saved designs back to draft.
            $cnt = $db->prepare('SELECT COUNT(*) FROM generations WHERE project_id = ?');
            $cnt->execute([$projectId]);
            $newStatus = ((int) $cnt->fetchColumn() > 0) ? 'editing' : 'draft';
            $stmt = $db->prepare('UPDATE projects SET status = ?, ai_job_id = NULL, updated_at = NOW() WHERE id = ? AND ai_job_id = ?');
            $stmt->execute([$newStatus, $projectId, $project['ai_job_id']]);
            return;
        }
        if ($jobStatus !== 'completed') {
            return;
        }

        $result = $data['result'] ?? [];
        // A placeholder/failed result is not a real design — reset to draft rather
        // than persisting the fallback swatch as a finished generation.
        if (!empty($result['placeholder'])) {
            // An edit can fail to a placeholder on a project that already has designs —
            // keep it 'editing'; only a fresh project with nothing falls back to 'draft'.
            $cnt = $db->prepare('SELECT COUNT(*) FROM generations WHERE project_id = ?');
            $cnt->execute([$projectId]);
            $newStatus = ((int) $cnt->fetchColumn() > 0) ? 'editing' : 'draft';
            $stmt = $db->prepare('UPDATE projects SET status = ?, ai_job_id = NULL, updated_at = NOW() WHERE id = ? AND ai_job_id = ?');
            $stmt->execute([$newStatus, $projectId, $project['ai_job_id']]);
            return;
        }

        $images = $result['images'] ?? [];
        if (empty($images)) {
            return;
        }

        // Atomically claim this job so concurrent polls can't double-insert the
        // same generations/files — only the winner (rowCount === 1) proceeds.
        $claim = $db->prepare('UPDATE projects SET ai_job_id = NULL WHERE id = ? AND ai_job_id = ?');
        $claim->execute([$projectId, $project['ai_job_id']]);
        if ($claim->rowCount() !== 1) {
            return;
        }

        $config = json_decode($project['config_json'] ?? '{}', true) ?: [];
        // Prefer the AI's enhanced prompt (when enhance was on) over the raw input.
        $enhanced = trim((string) ($result['enhanced_prompt'] ?? ''));
        $prompt = $enhanced !== '' ? $enhanced : (string) ($config['_last_prompt'] ?? 'Generated design');
        $kind = ($data['type'] ?? 'generate') === 'edit' ? 'edit' : 'concept';
        $model = (string) ($data['result']['model'] ?? 'flux');
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

        $flags = $result['placeholder_flags'] ?? [];
        $newIds = [];
        foreach ($images as $i => $b64) {
            if (!empty($flags[$i])) {
                continue; // skip per-concept placeholder swatches from a partial failure
            }
            $bytes = base64_decode($b64);
            if ($bytes === false) {
                continue;
            }
            $insert->execute([$projectId, $parentId, $prompt, $model, $kind, '', $width, $height]);
            $genId = (int) $db->lastInsertId();
            // Random suffix makes the path unguessable — these files are served unauthenticated.
            $filename = 'generation_' . $genId . '_' . bin2hex(random_bytes(4)) . '.png';
            if (file_put_contents($projectDir . '/' . $filename, $bytes) === false) {
                // Don't leave a generation row pointing at a file we couldn't write.
                $db->prepare('DELETE FROM generations WHERE id = ?')->execute([$genId]);
                continue;
            }
            $publicUrl = '/uploads/projects/' . $projectId . '/' . $filename;
            $update = $db->prepare('UPDATE generations SET output_image_url = ? WHERE id = ?');
            $update->execute([$publicUrl, $genId]);
            $newIds[] = $genId;
        }

        // Bill generation: 1 credit per delivered concept (edits are free). Free
        // allowance first, then purchased. allowPartial so a partial failure never
        // overcharges; the up-front gate in generate() already ensured funds.
        if ($kind === 'concept' && $newIds) {
            try {
                Credits::charge($db, (int) $project['user_id'], count($newIds), 'generate-concepts', $projectId, true);
            } catch (\Throwable $e) {
                error_log('[5cd] credit charge failed for project ' . $projectId . ': ' . $e->getMessage());
            }
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

    /** Base64 of a project's stored style-reference image (references/ref_0.png), or null. */
    private function loadProjectReference(int $projectId): ?string
    {
        $path = $this->uploadsDir() . '/projects/' . $projectId . '/references/ref_0.png';
        if (!is_file($path)) {
            return null;
        }
        $bytes = @file_get_contents($path);
        return $bytes !== false ? base64_encode($bytes) : null;
    }

    private function aiPostAsync(string $path, array $payload): ?string
    {
        return $this->aiPostAsyncTo($this->aiUrl(), $path, $payload);
    }

    /** POST an async job to a specific worker base URL; returns its job_id or null. */
    private function aiPostAsyncTo(string $baseUrl, string $path, array $payload): ?string
    {
        $url = rtrim($baseUrl, '/') . $path;
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
        $err = curl_error($ch);
        curl_close($ch);
        if ($code !== 200 || !$body) {
            error_log("[5cd] AI POST {$url} failed: http={$code} curl_err=\"{$err}\"");
            return null;
        }
        $data = json_decode($body, true) ?: [];
        return $data['job_id'] ?? null;
    }

    /**
     * Load the bytes of a source image for editing. Only files inside THIS
     * project's own uploads directory are allowed: no remote URLs (SSRF), no
     * path traversal, and no cross-project/tenant reads (IDOR).
     */
    private function loadImageBytes(string $url, int $projectId): ?string
    {
        $clean = preg_replace('/\?.*$/', '', $url);
        if (!str_starts_with($clean, '/uploads/')) {
            return null;
        }
        $uploadsDir = $this->uploadsDir();
        $candidate = realpath($uploadsDir . substr($clean, strlen('/uploads')));
        if ($candidate === false || !is_file($candidate)) {
            return null;
        }
        // Confine the resolved path to this project's own upload directory.
        $projectRoot = realpath($uploadsDir . '/projects/' . $projectId);
        if ($projectRoot === false
            || strncmp($candidate, $projectRoot . DIRECTORY_SEPARATOR, strlen($projectRoot) + 1) !== 0) {
            return null;
        }
        return file_get_contents($candidate);
    }

    private function aiUrl(): string
    {
        return rtrim($_ENV['AI_SERVICE_URL'] ?? 'http://127.0.0.1:8090', '/');
    }

    /** Fetch the AI worker's /api/health, or null if unreachable. */
    private function aiHealth(): ?array
    {
        $ch = curl_init($this->aiUrl() . '/api/health');
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 2]);
        $body = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($code !== 200 || !$body) {
            return null;
        }
        return json_decode($body, true) ?: null;
    }

    /**
     * Report the engine + UI policy (max resolution, default size, steps) so the
     * Create page can size generation appropriately. One FLUX.2-klein worker does
     * text-to-image, image-to-image and upscaling.
     */
    public function aiConfig(Request $request, Response $response): Response
    {
        $maxSide = 1024;
        $steps = 4;
        $supportsEdit = true;
        $supportsUpscale = false;
        $h = $this->aiHealth();
        if (is_array($h)) {
            $maxSide = (int) ($h['max_side'] ?? $maxSide);
            $steps = (int) ($h['steps'] ?? $steps);
            $supportsEdit = (bool) ($h['supports_edit'] ?? $supportsEdit);
            $supportsUpscale = (bool) ($h['supports_upscale'] ?? false);
        }
        return $this->json($response, [
            'engine' => 'flux',
            'label' => 'FLUX.2-klein',
            'enabled' => true,
            'max_side' => $maxSide,
            'default_size' => $maxSide >= 2048 ? '2048x2048' : '1024x1024',
            'steps' => $steps,
            'supports_edit' => $supportsEdit,
            'supports_upscale' => $supportsUpscale,
        ]);
    }

    /** Proxy an AI super-resolution request to the worker (used by the vectoriser). */
    public function upscale(Request $request, Response $response): Response
    {
        $data = $request->getParsedBody() ?? [];
        $image = (string) ($data['image'] ?? '');
        if ($image === '') {
            return $this->json($response, ['error' => true, 'message' => 'image is required'], 400);
        }
        $payload = ['image' => $image];
        if (isset($data['max_dim'])) {
            $payload['max_dim'] = (int) $data['max_dim'];
        }
        $ch = curl_init($this->aiUrl() . '/api/upscale');
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode($payload),
            CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Expect:'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 120,
        ]);
        $body = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($code === 200 && $body) {
            $response->getBody()->write($body);
            return $response->withHeader('Content-Type', 'application/json');
        }
        return $this->json($response, ['error' => true, 'message' => 'Upscale failed or unavailable.'], 502);
    }

    /** Proxy a prompt-expansion request to the worker (Qwen3 text encoder). */
    public function expandPrompt(Request $request, Response $response): Response
    {
        $data = $request->getParsedBody() ?? [];
        $prompt = trim((string) ($data['prompt'] ?? ''));
        if ($prompt === '') {
            return $this->json($response, ['error' => true, 'message' => 'prompt is required'], 400);
        }
        $payload = ['prompt' => mb_substr($prompt, 0, 1500)];
        if (!empty($data['design_type'])) {
            $payload['design_type'] = (string) $data['design_type'];
        }
        $ch = curl_init($this->aiUrl() . '/api/expand');
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode($payload),
            CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Expect:'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 60,
        ]);
        $body = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($code === 200 && $body) {
            $response->getBody()->write($body);
            return $response->withHeader('Content-Type', 'application/json');
        }
        // Soft-fail: return the original prompt so the UI can carry on.
        return $this->json($response, ['prompt' => $prompt, 'expanded' => $prompt]);
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
