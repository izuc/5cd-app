<?php

declare(strict_types=1);

namespace App\Controllers;

use App\Config\Database;
use App\Config\Paths;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class ExportController
{
    private const FORMATS = ['png' => 0, 'transparent_png' => 1, 'jpg' => 0, 'pdf' => 2];

    public function create(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        $projectId = (int) $args['id'];
        $data = $request->getParsedBody() ?? [];
        $format = (string) ($data['format'] ?? 'png');

        if (!array_key_exists($format, self::FORMATS)) {
            return $this->json($response, ['error' => true, 'message' => 'Invalid format'], 400);
        }
        $cost = self::FORMATS[$format];

        $db = Database::getConnection();

        // 1. Resolve and validate the source (cheap reads, no lock held).
        $stmt = $db->prepare('SELECT p.chosen_generation_id, u.credits FROM projects p
                              JOIN users u ON u.id = p.user_id WHERE p.id = ? AND p.user_id = ?');
        $stmt->execute([$projectId, $userId]);
        $row = $stmt->fetch();
        if (!$row) {
            return $this->json($response, ['error' => true, 'message' => 'Project not found'], 404);
        }
        if (empty($row['chosen_generation_id'])) {
            return $this->json($response, ['error' => true, 'message' => 'No chosen design to export'], 400);
        }
        if ($cost > 0 && (int) $row['credits'] < $cost) {
            return $this->json($response, ['error' => true, 'message' => 'Insufficient credits'], 402);
        }

        $stmt = $db->prepare('SELECT output_image_url FROM generations WHERE id = ? AND project_id = ?');
        $stmt->execute([$row['chosen_generation_id'], $projectId]);
        $gen = $stmt->fetch();
        if (!$gen || empty($gen['output_image_url'])) {
            return $this->json($response, ['error' => true, 'message' => 'Source image missing'], 404);
        }

        $uploadsDir = $this->uploadsDir();
        // Strip only the leading "/uploads" prefix (global str_replace was fragile).
        $relative = preg_replace('#^/uploads#', '', preg_replace('/\?.*$/', '', $gen['output_image_url']));
        $sourcePath = $uploadsDir . $relative;
        if (!is_file($sourcePath)) {
            return $this->json($response, ['error' => true, 'message' => 'Source file missing on disk'], 404);
        }

        $exportDir = $uploadsDir . '/projects/' . $projectId . '/exports';
        if (!is_dir($exportDir) && !mkdir($exportDir, 0755, true) && !is_dir($exportDir)) {
            return $this->json($response, ['error' => true, 'message' => 'Could not create export directory'], 500);
        }

        // 2. Generate the export file OUTSIDE any transaction (the slow part) so we
        // don't hold a row lock across image/PDF processing.
        $filename = 'export_' . time() . '_' . bin2hex(random_bytes(4)) . '_' . $format;
        $diskPath = $exportDir . '/';
        $outName = '';
        try {
            switch ($format) {
                case 'png':
                    $outName = $filename . '.png';
                    if (!copy($sourcePath, $diskPath . $outName)) {
                        throw new \RuntimeException('Failed to write export file');
                    }
                    break;
                case 'transparent_png':
                    $outName = $filename . '.png';
                    $this->makeTransparentPng($sourcePath, $diskPath . $outName);
                    break;
                case 'jpg':
                    $outName = $filename . '.jpg';
                    $this->makeJpg($sourcePath, $diskPath . $outName);
                    break;
                case 'pdf':
                    $outName = $filename . '.pdf';
                    $this->makePdf($sourcePath, $diskPath . $outName);
                    break;
                default:
                    return $this->json($response, ['error' => true, 'message' => 'Unsupported format'], 400);
            }
        } catch (\Throwable $e) {
            if ($outName !== '' && is_file($diskPath . $outName)) {
                @unlink($diskPath . $outName); // drop any partially-written export file
            }
            $msg = ($_ENV['APP_ENV'] ?? 'production') === 'development' ? ('Export failed: ' . $e->getMessage()) : 'Export failed';
            return $this->json($response, ['error' => true, 'message' => $msg], 500);
        }

        $destPath = $diskPath . $outName;
        $fileUrl = '/uploads/projects/' . $projectId . '/exports/' . $outName;

        // 3. Short transaction: re-check credits under lock, deduct, and record.
        $db->beginTransaction();
        try {
            if ($cost > 0) {
                $stmt = $db->prepare('SELECT credits FROM users WHERE id = ? FOR UPDATE');
                $stmt->execute([$userId]);
                $u = $stmt->fetch();
                if (!$u || (int) $u['credits'] < $cost) {
                    $db->rollBack();
                    @unlink($destPath);
                    return $this->json($response, ['error' => true, 'message' => 'Insufficient credits'], 402);
                }
                $stmt = $db->prepare('UPDATE users SET credits = credits - ? WHERE id = ?');
                $stmt->execute([$cost, $userId]);
                $stmt = $db->prepare(
                    'INSERT INTO credit_transactions (user_id, amount, reason, project_id, created_at)
                     VALUES (?, ?, ?, ?, NOW())'
                );
                $stmt->execute([$userId, -$cost, 'export-' . $format, $projectId]);
            }

            $stmt = $db->prepare(
                'INSERT INTO exports (project_id, generation_id, format, file_url, credits_used, created_at)
                 VALUES (?, ?, ?, ?, ?, NOW())'
            );
            $stmt->execute([$projectId, $row['chosen_generation_id'], $format, $fileUrl, $cost]);
            $exportId = (int) $db->lastInsertId();

            $stmt = $db->prepare('UPDATE projects SET status = ?, updated_at = NOW() WHERE id = ?');
            $stmt->execute(['exported', $projectId]);

            $db->commit();
        } catch (\Throwable $e) {
            $db->rollBack();
            @unlink($destPath);
            $msg = ($_ENV['APP_ENV'] ?? 'production') === 'development' ? ('Export failed: ' . $e->getMessage()) : 'Export failed';
            return $this->json($response, ['error' => true, 'message' => $msg], 500);
        }

        return $this->json($response, [
            'export' => [
                'id' => $exportId,
                'project_id' => $projectId,
                'format' => $format,
                'file_url' => $fileUrl,
                'credits_used' => $cost,
            ],
        ], 201);
    }

    public function listForUser(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        $db = Database::getConnection();
        $stmt = $db->prepare(
            'SELECT e.*, p.title AS project_title FROM exports e
             JOIN projects p ON p.id = e.project_id
             WHERE p.user_id = ? ORDER BY e.created_at DESC LIMIT 100'
        );
        $stmt->execute([$userId]);
        return $this->json($response, ['exports' => $stmt->fetchAll()]);
    }

    private function makeTransparentPng(string $sourcePath, string $destPath): void
    {
        $img = imagecreatefrompng($sourcePath);
        if ($img === false) {
            throw new \RuntimeException('Could not read source PNG');
        }
        $w = imagesx($img);
        $h = imagesy($img);
        $out = imagecreatetruecolor($w, $h);
        imagealphablending($out, false);
        imagesavealpha($out, true);
        $transparent = imagecolorallocatealpha($out, 0, 0, 0, 127);
        imagefilledrectangle($out, 0, 0, $w, $h, $transparent);
        // Treat near-white pixels as transparent — a simple chroma key for solid backgrounds.
        for ($y = 0; $y < $h; $y++) {
            for ($x = 0; $x < $w; $x++) {
                $rgba = imagecolorat($img, $x, $y);
                $r = ($rgba >> 16) & 0xFF;
                $g = ($rgba >> 8) & 0xFF;
                $b = $rgba & 0xFF;
                if ($r >= 245 && $g >= 245 && $b >= 245) {
                    continue;
                }
                $color = imagecolorallocatealpha($out, $r, $g, $b, 0);
                imagesetpixel($out, $x, $y, $color);
            }
        }
        $ok = imagepng($out, $destPath);
        imagedestroy($img);
        imagedestroy($out);
        if (!$ok) {
            throw new \RuntimeException('Failed to write transparent PNG export');
        }
    }

    private function makeJpg(string $sourcePath, string $destPath): void
    {
        $img = imagecreatefrompng($sourcePath);
        if ($img === false) {
            throw new \RuntimeException('Could not read source PNG');
        }
        $w = imagesx($img);
        $h = imagesy($img);
        $bg = imagecreatetruecolor($w, $h);
        $white = imagecolorallocate($bg, 255, 255, 255);
        imagefilledrectangle($bg, 0, 0, $w, $h, $white);
        imagecopy($bg, $img, 0, 0, 0, 0, $w, $h);
        $ok = imagejpeg($bg, $destPath, 92);
        imagedestroy($img);
        imagedestroy($bg);
        if (!$ok) {
            throw new \RuntimeException('Failed to write JPG export');
        }
    }

    private function makePdf(string $sourcePath, string $destPath): void
    {
        // Minimal embedded PDF with the PNG flowed onto a single page.
        // Falls back to copying the PNG if GD is unavailable.
        $size = @getimagesize($sourcePath);
        if ($size === false) {
            if (!copy($sourcePath, $destPath)) {
                throw new \RuntimeException('Failed to write PDF export');
            }
            return;
        }
        $w = $size[0];
        $h = $size[1];

        // Use a JPEG inside the PDF for portability (PDF supports DCTDecode natively).
        $jpegPath = $destPath . '.tmp.jpg';
        try {
            $this->makeJpg($sourcePath, $jpegPath);
            $jpeg = file_get_contents($jpegPath);
        } finally {
            if (is_file($jpegPath)) {
                @unlink($jpegPath); // always clean up the temp JPEG, even on failure
            }
        }

        $pageW = $w;
        $pageH = $h;

        $objects = [];
        $objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
        $objects[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
        $contentStream = "q\n{$pageW} 0 0 {$pageH} 0 0 cm\n/Im1 Do\nQ\n";
        $objects[4] = "<< /Length " . strlen($contentStream) . " >>\nstream\n" . $contentStream . "endstream";
        $objects[3] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {$pageW} {$pageH}] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>";
        $objects[5] = "<< /Type /XObject /Subtype /Image /Width {$w} /Height {$h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " . strlen($jpeg) . " >>\nstream\n" . $jpeg . "\nendstream";

        // Emit objects and the xref table in object-number order so byte offsets line
        // up with their xref slots (objects 3 and 4 are defined out of order above).
        ksort($objects);

        $output = "%PDF-1.4\n";
        $offsets = [0];
        foreach ($objects as $id => $body) {
            $offsets[$id] = strlen($output);
            $output .= "{$id} 0 obj\n{$body}\nendobj\n";
        }
        $xrefStart = strlen($output);
        $output .= "xref\n0 " . (count($objects) + 1) . "\n0000000000 65535 f \n";
        foreach ($objects as $id => $body) {
            $output .= str_pad((string) $offsets[$id], 10, '0', STR_PAD_LEFT) . " 00000 n \n";
        }
        $output .= "trailer\n<< /Size " . (count($objects) + 1) . " /Root 1 0 R >>\nstartxref\n{$xrefStart}\n%%EOF\n";

        if (file_put_contents($destPath, $output) === false) {
            throw new \RuntimeException('Failed to write PDF export');
        }
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
