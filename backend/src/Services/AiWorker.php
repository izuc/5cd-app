<?php

declare(strict_types=1);

namespace App\Services;

/**
 * Thin HTTP client for the FLUX worker, shared by controllers that submit
 * jobs (GenerationController keeps its long-standing private copies; new
 * controllers should use this).
 */
final class AiWorker
{
    public static function baseUrl(): string
    {
        return rtrim($_ENV['AI_SERVICE_URL'] ?? 'http://127.0.0.1:8090', '/');
    }

    /** POST an async job; returns the worker job_id or null on any failure. */
    public static function postAsync(string $path, array $payload): ?string
    {
        $url = self::baseUrl() . $path;
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
}
