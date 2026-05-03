<?php

declare(strict_types=1);

namespace App\Config;

/**
 * Resolves filesystem paths for the app.
 *
 * `UPLOADS_DIR` in `.env` may be absolute (preferred) or relative. If relative
 * we resolve it against the backend project root (the parent of `public/`)
 * rather than the PHP CWD — relying on CWD breaks `php -S` and PHP-FPM
 * inconsistently.
 */
class Paths
{
    public static function uploads(): string
    {
        $env = $_ENV['UPLOADS_DIR'] ?? '../uploads';
        return self::resolve($env);
    }

    public static function backendRoot(): string
    {
        // src/Config/Paths.php → backend/src/Config → backend
        return dirname(__DIR__, 2);
    }

    private static function resolve(string $path): string
    {
        $path = rtrim($path, "/\\");
        if (self::isAbsolute($path)) {
            return $path;
        }
        return rtrim(self::backendRoot() . DIRECTORY_SEPARATOR . $path, "/\\");
    }

    private static function isAbsolute(string $path): bool
    {
        if ($path === '') {
            return false;
        }
        if ($path[0] === '/' || $path[0] === '\\') {
            return true;
        }
        // Windows drive letter, e.g. C:\foo
        if (strlen($path) >= 3 && ctype_alpha($path[0]) && $path[1] === ':' && ($path[2] === '\\' || $path[2] === '/')) {
            return true;
        }
        return false;
    }
}
