<?php

declare(strict_types=1);

namespace App\Controllers;

use App\Config\Database;
use App\Services\Credits;
use Firebase\JWT\JWT;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class AuthController
{
    public function register(Request $request, Response $response): Response
    {
        $data = $request->getParsedBody() ?? [];
        $email = trim($data['email'] ?? '');
        $password = $data['password'] ?? '';
        $displayName = trim($data['display_name'] ?? '');

        if (empty($email) || empty($password)) {
            return $this->json($response, ['error' => true, 'message' => 'Email and password are required'], 400);
        }
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            return $this->json($response, ['error' => true, 'message' => 'Invalid email format'], 400);
        }
        if (strlen($password) < 6) {
            return $this->json($response, ['error' => true, 'message' => 'Password must be at least 6 characters'], 400);
        }

        $db = Database::getConnection();
        $stmt = $db->prepare('SELECT id FROM users WHERE email = ?');
        $stmt->execute([$email]);
        if ($stmt->fetch()) {
            return $this->json($response, ['error' => true, 'message' => 'Email already registered'], 409);
        }

        $hash = password_hash($password, PASSWORD_BCRYPT);
        if ($displayName === '') {
            $displayName = explode('@', $email)[0];
        }

        // Purchased credits start at 0 — new users get the daily free allowance.
        $stmt = $db->prepare(
            'INSERT INTO users (email, password_hash, display_name, credits, plan, theme_color, created_at, updated_at)
             VALUES (?, ?, ?, 0, ?, ?, NOW(), NOW())'
        );
        $stmt->execute([$email, $hash, $displayName, 'free', '#059669']);
        $userId = (int) $db->lastInsertId();

        $token = $this->makeToken($userId, $email);
        $stmt = $db->prepare('SELECT id, email, display_name, credits, plan, theme_color, created_at FROM users WHERE id = ?');
        $stmt->execute([$userId]);
        $user = $this->withCredits($db, $stmt->fetch());

        return $this->json($response, ['token' => $token, 'user' => $user], 201);
    }

    public function login(Request $request, Response $response): Response
    {
        $data = $request->getParsedBody() ?? [];
        $email = trim($data['email'] ?? '');
        $password = $data['password'] ?? '';

        if (empty($email) || empty($password)) {
            return $this->json($response, ['error' => true, 'message' => 'Email and password are required'], 400);
        }

        $db = Database::getConnection();
        $stmt = $db->prepare('SELECT id, email, password_hash, display_name, credits, plan, theme_color, token_version, created_at FROM users WHERE email = ?');
        $stmt->execute([$email]);
        $user = $stmt->fetch();

        if (!$user || !password_verify($password, $user['password_hash'])) {
            return $this->json($response, ['error' => true, 'message' => 'Invalid email or password'], 401);
        }

        $token = $this->makeToken((int) $user['id'], $user['email'], (int) $user['token_version']);
        unset($user['password_hash'], $user['token_version']);

        return $this->json($response, ['token' => $token, 'user' => $this->withCredits($db, $user)]);
    }

    public function logout(Request $request, Response $response): Response
    {
        return $this->json($response, ['message' => 'Logged out successfully']);
    }

    public function me(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        $db = Database::getConnection();
        $stmt = $db->prepare(
            'SELECT id, email, display_name, credits, plan, theme_color, created_at, updated_at
             FROM users WHERE id = ?'
        );
        $stmt->execute([$userId]);
        $user = $stmt->fetch();
        if (!$user) {
            return $this->json($response, ['error' => true, 'message' => 'User not found'], 404);
        }
        return $this->json($response, ['user' => $this->withCredits($db, $user)]);
    }

    /** Override `credits` with the live total (daily free + purchased) and add the breakdown. */
    private function withCredits(\PDO $db, array $user): array
    {
        $b = Credits::balance($db, (int) $user['id']);
        $user['credits'] = $b['total'];
        $user['free_credits'] = $b['free'];
        $user['paid_credits'] = $b['paid'];
        return $user;
    }

    private function makeToken(int $userId, string $email, int $tokenVersion = 0): string
    {
        $secret = $_ENV['JWT_SECRET'] ?? '';
        $expiry = (int) ($_ENV['JWT_EXPIRY'] ?? 604800);
        $payload = [
            'iss' => '5cd.com',
            'sub' => $userId,
            'email' => $email,
            'tv' => $tokenVersion,
            'iat' => time(),
            'exp' => time() + $expiry,
        ];
        return JWT::encode($payload, $secret, 'HS256');
    }

    private function json(Response $response, array $data, int $status = 200): Response
    {
        $response->getBody()->write(json_encode($data));
        return $response->withHeader('Content-Type', 'application/json')->withStatus($status);
    }
}
