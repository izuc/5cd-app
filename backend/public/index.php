<?php

declare(strict_types=1);

use DI\ContainerBuilder;
use Slim\Factory\AppFactory;
use Dotenv\Dotenv;

require __DIR__ . '/../vendor/autoload.php';

$dotenv = Dotenv::createImmutable(__DIR__ . '/..');
$dotenv->load();

// Fail fast on an unconfigured JWT secret: a missing or placeholder secret would
// let anyone forge auth tokens (HS256 signs and verifies with the same key).
$jwtSecret = $_ENV['JWT_SECRET'] ?? '';
if (strlen($jwtSecret) < 32 || $jwtSecret === 'replace_me_with_a_random_64_char_string') {
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode(['error' => true, 'message' => 'Server misconfigured: JWT_SECRET must be set to a random string of at least 32 characters.']);
    exit;
}

$containerBuilder = new ContainerBuilder();
$container = $containerBuilder->build();

AppFactory::setContainer($container);
$app = AppFactory::create();

$app->addBodyParsingMiddleware();
// Error middleware is added before CORS so that CORS (added last = outermost)
// wraps it and error responses (4xx/5xx) still carry Access-Control headers.
$app->addErrorMiddleware(
    ($_ENV['APP_ENV'] ?? 'production') === 'development',
    true,
    true
);
$app->add(new App\Middleware\CorsMiddleware());

$routes = require __DIR__ . '/../src/routes.php';
$routes($app);

$app->run();
