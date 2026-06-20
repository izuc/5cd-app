<?php

declare(strict_types=1);

namespace App\Middleware;

use App\Config\Database;
use Firebase\JWT\JWT;
use Firebase\JWT\Key;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface as RequestHandler;
use Slim\Psr7\Response as SlimResponse;

class AuthMiddleware implements MiddlewareInterface
{
    public function process(Request $request, RequestHandler $handler): Response
    {
        $authHeader = $request->getHeaderLine('Authorization');

        if (empty($authHeader) || !preg_match('/^Bearer\s+(.+)$/', $authHeader, $matches)) {
            return $this->unauthorized('Missing or invalid Authorization header');
        }

        $token = $matches[1];

        try {
            $secret = $_ENV['JWT_SECRET'] ?? '';
            $decoded = JWT::decode($token, new Key($secret, 'HS256'));

            // Reject tokens invalidated by a later password change (token_version bump)
            // or whose user no longer exists.
            $db = Database::getConnection();
            $stmt = $db->prepare('SELECT token_version FROM users WHERE id = ?');
            $stmt->execute([$decoded->sub]);
            $row = $stmt->fetch();
            if (!$row || (int) ($decoded->tv ?? 0) !== (int) $row['token_version']) {
                return $this->unauthorized('Invalid or expired token');
            }

            $request = $request->withAttribute('userId', $decoded->sub);
            $request = $request->withAttribute('userEmail', $decoded->email);
            return $handler->handle($request);
        } catch (\Exception $e) {
            return $this->unauthorized('Invalid or expired token');
        }
    }

    private function unauthorized(string $message): Response
    {
        $response = new SlimResponse();
        $response->getBody()->write(json_encode([
            'error' => true,
            'message' => $message,
        ]));
        return $response
            ->withHeader('Content-Type', 'application/json')
            ->withStatus(401);
    }
}
