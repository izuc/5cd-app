<?php

declare(strict_types=1);

namespace App\Services;

use PDO;

/**
 * Credit accounting: a daily free allowance (resets each day, no rollover) plus
 * persistent purchased credits. Charges draw from the free allowance first, then
 * from purchased credits.
 *
 *   users.credits             = purchased balance (persists)
 *   users.free_credits        = today's remaining free allowance
 *   users.free_credits_reset  = date free_credits was last set to DAILY_FREE
 */
class Credits
{
    public const DAILY_FREE = 5;

    /**
     * Apply the daily reset if it's a new day and return the breakdown.
     * @return array{free:int, paid:int, total:int}
     */
    public static function balance(PDO $db, int $userId): array
    {
        $stmt = $db->prepare('SELECT credits, free_credits, free_credits_reset FROM users WHERE id = ?');
        $stmt->execute([$userId]);
        $u = $stmt->fetch();
        if (!$u) {
            return ['free' => 0, 'paid' => 0, 'total' => 0];
        }
        $today = date('Y-m-d');
        $paid = (int) $u['credits'];
        if ((string) ($u['free_credits_reset'] ?? '') !== $today) {
            $free = self::DAILY_FREE;
            $db->prepare('UPDATE users SET free_credits = ?, free_credits_reset = ? WHERE id = ?')
               ->execute([$free, $today, $userId]);
        } else {
            $free = (int) $u['free_credits'];
        }
        return ['free' => $free, 'paid' => $paid, 'total' => $free + $paid];
    }

    public static function canAfford(PDO $db, int $userId, int $n): bool
    {
        return self::balance($db, $userId)['total'] >= $n;
    }

    /**
     * Charge $n credits — free allowance first, then purchased. Applies the daily
     * reset inline and records a credit_transactions row for the amount taken.
     *
     * @param bool $allowPartial false: if the balance can't cover $n, nothing is
     *        deducted and -1 is returned. true: deduct min($n, total) (use after a
     *        result has already been delivered so the user is never overcharged).
     * @return int amount actually deducted, or -1 when refused (strict + insufficient).
     *
     * Joins the caller's transaction if one is open, otherwise manages its own.
     */
    public static function charge(PDO $db, int $userId, int $n, string $reason, ?int $projectId = null, bool $allowPartial = false): int
    {
        if ($n <= 0) {
            return 0;
        }
        $ownTx = !$db->inTransaction();
        if ($ownTx) {
            $db->beginTransaction();
        }
        try {
            $stmt = $db->prepare('SELECT credits, free_credits, free_credits_reset FROM users WHERE id = ? FOR UPDATE');
            $stmt->execute([$userId]);
            $u = $stmt->fetch();
            if (!$u) {
                if ($ownTx) {
                    $db->rollBack();
                }
                return -1;
            }
            $today = date('Y-m-d');
            $paid = (int) $u['credits'];
            $free = ((string) ($u['free_credits_reset'] ?? '') !== $today) ? self::DAILY_FREE : (int) $u['free_credits'];
            $total = $free + $paid;
            if ($total < $n && !$allowPartial) {
                if ($ownTx) {
                    $db->rollBack();
                }
                return -1;
            }
            $take = min($n, $total);
            $fromFree = min($free, $take);
            $fromPaid = $take - $fromFree;
            $db->prepare('UPDATE users SET free_credits = ?, free_credits_reset = ?, credits = ? WHERE id = ?')
               ->execute([$free - $fromFree, $today, $paid - $fromPaid, $userId]);
            if ($take > 0) {
                $db->prepare(
                    'INSERT INTO credit_transactions (user_id, amount, reason, project_id, created_at) VALUES (?, ?, ?, ?, NOW())'
                )->execute([$userId, -$take, $reason, $projectId]);
            }
            if ($ownTx) {
                $db->commit();
            }
            return $take;
        } catch (\Throwable $e) {
            if ($ownTx && $db->inTransaction()) {
                $db->rollBack();
            }
            throw $e;
        }
    }
}
