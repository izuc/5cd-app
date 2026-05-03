<?php

declare(strict_types=1);

namespace App\Controllers;

use App\Config\Database;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class UserController
{
    public function updateThemeColor(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        $data = $request->getParsedBody() ?? [];
        $color = $data['theme_color'] ?? '';

        if (!preg_match('/^#[0-9A-Fa-f]{6}$/', $color)) {
            return $this->json($response, ['error' => true, 'message' => 'Invalid hex color'], 400);
        }

        $db = Database::getConnection();
        $stmt = $db->prepare('UPDATE users SET theme_color = ?, updated_at = NOW() WHERE id = ?');
        $stmt->execute([$color, $userId]);

        return $this->json($response, ['message' => 'Theme updated']);
    }

    public function changePassword(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        $data = $request->getParsedBody() ?? [];
        $current = $data['current_password'] ?? '';
        $new = $data['new_password'] ?? '';

        if (strlen($new) < 6) {
            return $this->json($response, ['error' => true, 'message' => 'New password must be at least 6 characters'], 400);
        }

        $db = Database::getConnection();
        $stmt = $db->prepare('SELECT password_hash FROM users WHERE id = ?');
        $stmt->execute([$userId]);
        $row = $stmt->fetch();
        if (!$row || !password_verify($current, $row['password_hash'])) {
            return $this->json($response, ['error' => true, 'message' => 'Current password is incorrect'], 401);
        }

        $hash = password_hash($new, PASSWORD_BCRYPT);
        $stmt = $db->prepare('UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?');
        $stmt->execute([$hash, $userId]);

        return $this->json($response, ['message' => 'Password updated']);
    }

    public function deleteAccount(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        $data = $request->getParsedBody() ?? [];
        $password = $data['password'] ?? '';

        $db = Database::getConnection();
        $stmt = $db->prepare('SELECT password_hash FROM users WHERE id = ?');
        $stmt->execute([$userId]);
        $row = $stmt->fetch();
        if (!$row || !password_verify($password, $row['password_hash'])) {
            return $this->json($response, ['error' => true, 'message' => 'Password is incorrect'], 401);
        }

        $stmt = $db->prepare('DELETE FROM users WHERE id = ?');
        $stmt->execute([$userId]);

        return $this->json($response, ['message' => 'Account deleted']);
    }

    private function json(Response $response, array $data, int $status = 200): Response
    {
        $response->getBody()->write(json_encode($data));
        return $response->withHeader('Content-Type', 'application/json')->withStatus($status);
    }
}
