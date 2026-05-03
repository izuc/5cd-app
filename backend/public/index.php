<?php

declare(strict_types=1);

use DI\ContainerBuilder;
use Slim\Factory\AppFactory;
use Dotenv\Dotenv;

require __DIR__ . '/../vendor/autoload.php';

$dotenv = Dotenv::createImmutable(__DIR__ . '/..');
$dotenv->load();

$containerBuilder = new ContainerBuilder();
$container = $containerBuilder->build();

AppFactory::setContainer($container);
$app = AppFactory::create();

$app->addBodyParsingMiddleware();
$app->add(new App\Middleware\CorsMiddleware());
$app->addErrorMiddleware(
    ($_ENV['APP_ENV'] ?? 'production') === 'development',
    true,
    true
);

$routes = require __DIR__ . '/../src/routes.php';
$routes($app);

$app->run();
