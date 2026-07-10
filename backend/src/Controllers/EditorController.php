<?php

declare(strict_types=1);

namespace App\Controllers;

use App\Config\Database;
use App\Config\Paths;
use App\Services\AiWorker;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Layered-editor persistence + ephemeral layer AI jobs.
 *
 * The editor document is opaque JSON except layers[].id and layers[].bitmap_url,
 * which the server owns: PUT writes any dirty layer bitmaps (raw PNG bytes —
 * never GD re-encoded, so RGBA survives) under uploads/projects/{id}/layers/
 * and rewrites the URLs. Layer AI jobs never touch projects.ai_job_id, so the
 * generation pipeline (checkAndSaveJob) can never claim them — their results
 * go straight back to the browser via the job-status poll.
 */
class EditorController
{
    private const MAX_LAYERS = 32;
    private const MAX_BITMAP_BYTES = 12582912; // 12MB decoded, mirrors createUploadGeneration
    private const MAX_BITMAP_SIDE = 4096;
    private const LAYER_ID_RE = '/^[A-Za-z0-9_-]{1,40}$/'; // becomes a filename stem — this IS the traversal guard

    public function getDocument(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        $projectId = (int) $args['id'];
        $db = Database::getConnection();
        if (!$this->ownsProject($db, $projectId, (int) $userId)) {
            return $this->json($response, ['error' => true, 'message' => 'Project not found'], 404);
        }
        $stmt = $db->prepare('SELECT doc_json, updated_at FROM editor_documents WHERE project_id = ?');
        $stmt->execute([$projectId]);
        $row = $stmt->fetch();
        return $this->json($response, [
            'document' => $row ? (json_decode((string) $row['doc_json'], true) ?: null) : null,
            'updated_at' => $row['updated_at'] ?? null,
        ]);
    }

    public function saveDocument(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        $projectId = (int) $args['id'];
        $db = Database::getConnection();
        if (!$this->ownsProject($db, $projectId, (int) $userId)) {
            return $this->json($response, ['error' => true, 'message' => 'Project not found'], 404);
        }

        $data = $request->getParsedBody() ?? [];
        $document = $data['document'] ?? null;
        if (!is_array($document) || !isset($document['layers']) || !is_array($document['layers'])) {
            // A missing document on a PUT this size usually means PHP truncated the
            // body (post_max_size) — call that out so it isn't a silent mystery.
            return $this->json($response, [
                'error' => true,
                'message' => 'document.layers is required — if you sent one, the request body may exceed post_max_size.',
            ], 400);
        }
        if (count($document['layers']) > self::MAX_LAYERS) {
            return $this->json($response, ['error' => true, 'message' => 'Too many layers (max ' . self::MAX_LAYERS . ').'], 400);
        }

        $layerIds = [];
        foreach ($document['layers'] as $layer) {
            if (!is_array($layer) || !isset($layer['id']) || !preg_match(self::LAYER_ID_RE, (string) $layer['id'])) {
                return $this->json($response, ['error' => true, 'message' => 'Invalid layer id.'], 400);
            }
            $layerIds[(string) $layer['id']] = true;
        }

        $bitmaps = $data['bitmaps'] ?? [];
        if (!is_array($bitmaps) || count($bitmaps) > self::MAX_LAYERS) {
            return $this->json($response, ['error' => true, 'message' => 'Invalid bitmaps payload.'], 400);
        }

        $layersDir = $this->layersDir($projectId);

        // Write dirty bitmaps and stamp their fresh URLs into the document.
        foreach ($bitmaps as $layerId => $b64) {
            $layerId = (string) $layerId;
            if (!preg_match(self::LAYER_ID_RE, $layerId) || !isset($layerIds[$layerId])) {
                return $this->json($response, ['error' => true, 'message' => "Bitmap for unknown layer '{$layerId}'."], 400);
            }
            $decoded = $this->decodePngB64((string) $b64);
            if ($decoded === null) {
                return $this->json($response, ['error' => true, 'message' => "Layer '{$layerId}' is not a valid PNG (max 12MB, 4096px)."], 400);
            }
            $filename = $layerId . '_' . bin2hex(random_bytes(4)) . '.png';
            if (file_put_contents($layersDir . '/' . $filename, $decoded['bytes']) === false) {
                return $this->json($response, ['error' => true, 'message' => 'Failed to store layer bitmap.'], 500);
            }
            $url = '/uploads/projects/' . $projectId . '/layers/' . $filename;
            foreach ($document['layers'] as &$layer) {
                if ((string) ($layer['id'] ?? '') === $layerId) {
                    $layer['bitmap_url'] = $url;
                }
            }
            unset($layer);
        }

        // Orphan cleanup, scoped strictly to layers/: anything not referenced by
        // the final document (deleted layers, superseded bitmap versions) goes.
        $referenced = [];
        foreach ($document['layers'] as $layer) {
            $url = (string) ($layer['bitmap_url'] ?? '');
            if ($url !== '') {
                $referenced[basename($url)] = true;
            }
        }
        foreach (glob($layersDir . '/*.png') ?: [] as $file) {
            if (!isset($referenced[basename($file)])) {
                @unlink($file);
            }
        }

        $stmt = $db->prepare(
            'INSERT INTO editor_documents (project_id, doc_json) VALUES (?, ?)
             ON DUPLICATE KEY UPDATE doc_json = VALUES(doc_json)'
        );
        $stmt->execute([$projectId, json_encode($document)]);

        $stmt = $db->prepare('SELECT updated_at FROM editor_documents WHERE project_id = ?');
        $stmt->execute([$projectId]);
        return $this->json($response, [
            'document' => $document,
            'updated_at' => $stmt->fetch()['updated_at'] ?? null,
        ]);
    }

    /** Image-to-image on a single layer's bitmap; result stays ephemeral. */
    public function layerEdit(Request $request, Response $response, array $args): Response
    {
        $userId = (int) $request->getAttribute('userId');
        $projectId = (int) $args['id'];
        $db = Database::getConnection();
        if (!$this->ownsProject($db, $projectId, $userId)) {
            return $this->json($response, ['error' => true, 'message' => 'Project not found'], 404);
        }
        if (!$this->aiJobsTableReady($db)) {
            return $this->json($response, ['error' => true, 'message' => 'Server needs a database migration (ai_jobs table) — apply database.sql.'], 500);
        }

        $data = $request->getParsedBody() ?? [];
        $prompt = trim((string) ($data['prompt'] ?? ''));
        if ($prompt === '') {
            return $this->json($response, ['error' => true, 'message' => 'prompt is required'], 400);
        }
        $decoded = $this->decodePngB64((string) ($data['image_b64'] ?? ''), false);
        if ($decoded === null) {
            return $this->json($response, ['error' => true, 'message' => 'image_b64 must be a valid image (max 12MB).'], 400);
        }

        $payload = [
            'prompt' => $prompt,
            'ref_images' => [base64_encode($decoded['bytes'])],
            'transparent' => (bool) ($data['transparent'] ?? false),
        ];
        if (isset($data['steps'])) {
            $payload['steps'] = (int) $data['steps'];
        }
        if (isset($data['guidance_scale'])) {
            $payload['guidance_scale'] = (float) $data['guidance_scale'];
        }
        if (isset($data['seed'])) {
            $payload['seed'] = (int) $data['seed'];
        }

        $jobId = AiWorker::postAsync('/api/edit/async', $payload);
        if (!$jobId) {
            return $this->json($response, ['error' => true, 'message' => 'AI service unreachable or queue full.'], 502);
        }
        $this->recordAiJob($db, $jobId, $projectId, $userId, 'layer_edit');
        return $this->json($response, ['job_id' => $jobId, 'status' => 'queued'], 202);
    }

    /** Text-to-image for a brand-new layer (transparent background by default). */
    public function layerGenerate(Request $request, Response $response, array $args): Response
    {
        $userId = (int) $request->getAttribute('userId');
        $projectId = (int) $args['id'];
        $db = Database::getConnection();
        if (!$this->ownsProject($db, $projectId, $userId)) {
            return $this->json($response, ['error' => true, 'message' => 'Project not found'], 404);
        }
        if (!$this->aiJobsTableReady($db)) {
            return $this->json($response, ['error' => true, 'message' => 'Server needs a database migration (ai_jobs table) — apply database.sql.'], 500);
        }

        $data = $request->getParsedBody() ?? [];
        $prompt = trim((string) ($data['prompt'] ?? ''));
        if ($prompt === '') {
            return $this->json($response, ['error' => true, 'message' => 'prompt is required'], 400);
        }

        $payload = [
            'prompt' => $prompt,
            'num_concepts' => 1,
            'width' => max(256, min(4096, (int) ($data['width'] ?? 1024))),
            'height' => max(256, min(4096, (int) ($data['height'] ?? 1024))),
            'transparent' => (bool) ($data['transparent'] ?? true),
        ];
        if (isset($data['steps'])) {
            $payload['steps'] = (int) $data['steps'];
        }
        if (isset($data['guidance_scale'])) {
            $payload['guidance_scale'] = (float) $data['guidance_scale'];
        }
        if (isset($data['seed'])) {
            $payload['seed'] = (int) $data['seed'];
        }

        $jobId = AiWorker::postAsync('/api/generate/async', $payload);
        if (!$jobId) {
            return $this->json($response, ['error' => true, 'message' => 'AI service unreachable or queue full.'], 502);
        }
        $this->recordAiJob($db, $jobId, $projectId, $userId, 'layer_generate');
        return $this->json($response, ['job_id' => $jobId, 'status' => 'queued'], 202);
    }

    // -- helpers -------------------------------------------------------------

    private function ownsProject(\PDO $db, int $projectId, int $userId): bool
    {
        $stmt = $db->prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?');
        $stmt->execute([$projectId, $userId]);
        return (bool) $stmt->fetch();
    }

    /** Fail BEFORE queueing GPU work when the additive migration hasn't been
     *  applied — a post-queue insert failure would burn inference time on a
     *  job whose status poll could never be authorized. */
    private function aiJobsTableReady(\PDO $db): bool
    {
        try {
            $db->query('SELECT 1 FROM ai_jobs LIMIT 1');
            return true;
        } catch (\Throwable $e) {
            return false;
        }
    }

    /** Track a layer job for status-poll authorization + prune stale rows
     *  (worker TTL is 600s; an hour is generously past useful life). */
    private function recordAiJob(\PDO $db, string $jobId, int $projectId, int $userId, string $purpose): void
    {
        // Layer jobs are free (consistent with edits); note for a future billing pass.
        $db->prepare('DELETE FROM ai_jobs WHERE created_at < NOW() - INTERVAL 1 HOUR')->execute();
        $stmt = $db->prepare('INSERT INTO ai_jobs (job_id, project_id, user_id, purpose) VALUES (?, ?, ?, ?)');
        $stmt->execute([$jobId, $projectId, $userId, $purpose]);
    }

    /**
     * Decode + validate a base64 image (data-URL prefix tolerated).
     * Returns ['bytes','w','h'] or null. $requirePng also enforces dimensions —
     * used for stored layer bitmaps; AI inputs accept any decodable image.
     */
    private function decodePngB64(string $b64, bool $requirePng = true): ?array
    {
        if (preg_match('/^data:image\/[a-z+.-]+;base64,/i', $b64, $m)) {
            $b64 = substr($b64, strlen($m[0]));
        }
        $bytes = base64_decode($b64, true);
        if ($bytes === false || $bytes === '' || strlen($bytes) > self::MAX_BITMAP_BYTES) {
            return null;
        }
        $info = @getimagesizefromstring($bytes);
        if ($info === false) {
            return null;
        }
        if ($requirePng) {
            if (($info[2] ?? 0) !== IMAGETYPE_PNG) {
                return null;
            }
            if ($info[0] > self::MAX_BITMAP_SIDE || $info[1] > self::MAX_BITMAP_SIDE) {
                return null;
            }
        }
        return ['bytes' => $bytes, 'w' => (int) $info[0], 'h' => (int) $info[1]];
    }

    private function layersDir(int $projectId): string
    {
        $dir = Paths::uploads() . '/projects/' . $projectId . '/layers';
        if (!is_dir($dir)) {
            mkdir($dir, 0755, true);
        }
        return $dir;
    }

    private function json(Response $response, array $data, int $status = 200): Response
    {
        $response->getBody()->write(json_encode($data));
        return $response->withHeader('Content-Type', 'application/json')->withStatus($status);
    }
}
