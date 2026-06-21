<?php

declare(strict_types=1);

use Slim\App;
use Slim\Routing\RouteCollectorProxy;
use App\Config\Paths;
use App\Middleware\AuthMiddleware;
use App\Controllers\AuthController;
use App\Controllers\ProjectController;
use App\Controllers\GenerationController;
use App\Controllers\ExportController;
use App\Controllers\CreditController;
use App\Controllers\UserController;

return function (App $app) {
    $app->group('/api', function (RouteCollectorProxy $api) {

        // -- Auth ----------------------------------------------------------
        $api->group('/auth', function (RouteCollectorProxy $auth) {
            $auth->post('/register', [AuthController::class, 'register']);
            $auth->post('/login', [AuthController::class, 'login']);
            $auth->post('/logout', [AuthController::class, 'logout']);
            $auth->get('/me', [AuthController::class, 'me'])->add(new AuthMiddleware());
        });

        // -- Projects + nested generation/export ---------------------------
        $api->group('/projects', function (RouteCollectorProxy $projects) {
            $projects->get('', [ProjectController::class, 'list']);
            $projects->post('', [ProjectController::class, 'create']);
            $projects->get('/{id}', [ProjectController::class, 'get']);
            $projects->patch('/{id}', [ProjectController::class, 'update']);
            $projects->delete('/{id}', [ProjectController::class, 'delete']);

            $projects->post('/{id}/generate', [GenerationController::class, 'generate']);
            $projects->post('/{id}/edit', [GenerationController::class, 'edit']);
            $projects->get('/{id}/generations', [GenerationController::class, 'listForProject']);
            $projects->post('/{id}/generations/{genId}/choose', [GenerationController::class, 'chooseGeneration']);

            $projects->post('/{id}/export', [ExportController::class, 'create']);
        })->add(new AuthMiddleware());

        // -- Standalone job poll -------------------------------------------
        $api->get('/jobs/{jobId}/status', [GenerationController::class, 'getJobStatus'])
            ->add(new AuthMiddleware());

        // -- Active image engine + UI size/steps policy --------------------
        $api->get('/ai-config', [GenerationController::class, 'aiConfig'])
            ->add(new AuthMiddleware());

        // -- Exports / credits / user --------------------------------------
        $api->get('/exports', [ExportController::class, 'listForUser'])->add(new AuthMiddleware());

        $api->group('/credits', function (RouteCollectorProxy $credits) {
            $credits->get('/balance', [CreditController::class, 'balance']);
            $credits->get('/history', [CreditController::class, 'history']);
            $credits->post('/purchase', [CreditController::class, 'purchase']);
        })->add(new AuthMiddleware());

        $api->patch('/user/theme', [UserController::class, 'updateThemeColor'])
            ->add(new AuthMiddleware());
        $api->post('/user/change-password', [UserController::class, 'changePassword'])
            ->add(new AuthMiddleware());
        $api->delete('/user/account', [UserController::class, 'deleteAccount'])
            ->add(new AuthMiddleware());
    });

    // -- Static uploads -----------------------------------------------------
    $app->get('/uploads/{path:.*}', function ($request, $response, $args) {
        $uploadsDir = realpath(Paths::uploads());
        $filePath = $uploadsDir . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $args['path']);
        $real = $uploadsDir ? realpath($filePath) : false;
        // Confine to the uploads dir with a trailing separator so a sibling such as
        // "<uploads>-backups" cannot satisfy the prefix check (path traversal).
        if ($real === false || !is_file($real)
            || strncmp($real, $uploadsDir . DIRECTORY_SEPARATOR, strlen($uploadsDir) + 1) !== 0) {
            $response->getBody()->write(json_encode(['error' => 'File not found']));
            return $response->withHeader('Content-Type', 'application/json')->withStatus(404);
        }
        $ext = strtolower(pathinfo($real, PATHINFO_EXTENSION));
        $mimes = [
            'png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg',
            'webp' => 'image/webp', 'svg' => 'image/svg+xml',
            'pdf' => 'application/pdf', 'json' => 'application/json',
        ];
        $mime = $mimes[$ext] ?? 'application/octet-stream';
        $response->getBody()->write(file_get_contents($real));
        return $response->withHeader('Content-Type', $mime)->withHeader('Cache-Control', 'public, max-age=86400');
    });
};
