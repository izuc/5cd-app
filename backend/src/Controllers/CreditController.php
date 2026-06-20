<?php

declare(strict_types=1);

namespace App\Controllers;

use App\Config\Database;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class CreditController
{
    private const BUNDLES = [
        'starter' => ['credits' => 20, 'price' => '$1.00'],
        'popular' => ['credits' => 120, 'price' => '$5.00'],
        'pro'     => ['credits' => 260, 'price' => '$10.00'],
    ];

    public function balance(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        $db = Database::getConnection();
        $stmt = $db->prepare('SELECT credits FROM users WHERE id = ?');
        $stmt->execute([$userId]);
        $row = $stmt->fetch();
        return $this->json($response, ['balance' => (int) ($row['credits'] ?? 0)]);
    }

    public function history(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        $db = Database::getConnection();
        $stmt = $db->prepare(
            'SELECT id, amount, reason, project_id, external_payment_ref, created_at
             FROM credit_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 200'
        );
        $stmt->execute([$userId]);
        return $this->json($response, ['transactions' => $stmt->fetchAll()]);
    }

    public function purchase(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        $data = $request->getParsedBody() ?? [];
        $bundleId = (string) ($data['bundle'] ?? '');
        if (!isset(self::BUNDLES[$bundleId])) {
            return $this->json($response, ['error' => true, 'message' => 'Unknown bundle'], 400);
        }
        $bundle = self::BUNDLES[$bundleId];
        $db = Database::getConnection();
        $db->beginTransaction();
        try {
            $stmt = $db->prepare('UPDATE users SET credits = credits + ? WHERE id = ?');
            $stmt->execute([$bundle['credits'], $userId]);
            $stmt = $db->prepare(
                'INSERT INTO credit_transactions (user_id, amount, reason, external_payment_ref, created_at)
                 VALUES (?, ?, ?, ?, NOW())'
            );
            $stmt->execute([$userId, $bundle['credits'], 'purchase-' . $bundleId, 'dev-' . uniqid()]);
            $stmt = $db->prepare('SELECT credits FROM users WHERE id = ?');
            $stmt->execute([$userId]);
            $balance = (int) $stmt->fetch()['credits'];
            $db->commit();
            return $this->json($response, ['success' => true, 'credits' => $balance]);
        } catch (\Throwable $e) {
            $db->rollBack();
            $msg = ($_ENV['APP_ENV'] ?? 'production') === 'development' ? $e->getMessage() : 'Purchase failed';
            return $this->json($response, ['error' => true, 'message' => $msg], 500);
        }
    }

    private function json(Response $response, array $data, int $status = 200): Response
    {
        $response->getBody()->write(json_encode($data));
        return $response->withHeader('Content-Type', 'application/json')->withStatus($status);
    }
}
