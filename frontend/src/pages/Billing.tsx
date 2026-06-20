import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuthStore } from '../store/authStore';
import { Icon } from '../components/Icon';
import { usePageTitle } from '../hooks/usePageTitle';

const BUNDLES: Array<{
  id: string;
  name: string;
  desc: string;
  price: string;
  credits: number;
  icon: string;
  featured?: boolean;
  badge?: string;
}> = [
  { id: 'starter', name: 'Starter Pack', desc: 'Quick one-off designs.', price: '$1.00', credits: 20, icon: 'bolt' },
  { id: 'popular', name: 'Popular Pack', desc: 'Sweet spot for active designers.', price: '$5.00', credits: 120, icon: 'stars', featured: true, badge: 'Most popular' },
  { id: 'pro', name: 'Pro Pack', desc: 'High-volume production.', price: '$10.00', credits: 260, icon: 'diamond', badge: 'Best value' },
];

export function Billing() {
  const { user, setCredits } = useAuthStore();
  usePageTitle('Billing & Credits');
  const [transactions, setTransactions] = useState<any[]>([]);
  const [purchasing, setPurchasing] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getCreditHistory().then((res) => setTransactions(res.transactions || []))
      .catch((err) => setError(err?.message || 'Could not load transaction history.'));
  }, []);

  const handlePurchase = async (bundle: string) => {
    setPurchasing(bundle);
    setError('');
    try {
      const res = await api.purchaseCredits(bundle);
      if (res.credits && user) setCredits(res.credits);
      const hist = await api.getCreditHistory();
      setTransactions(hist.transactions || []);
    } catch (err: any) {
      setError(err.message || 'Purchase failed');
    } finally {
      setPurchasing(null);
    }
  };

  return (
    <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12 space-y-12">
      <header className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="font-headline text-3xl sm:text-4xl font-black tracking-tighter">Credits</h1>
          <p className="text-on-surface-variant mt-1">Buy credits to export and run additional generations.</p>
        </div>
        <div className="bg-surface-container-lowest rounded-2xl p-5 shadow-sm">
          <p className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant">Current Balance</p>
          <p className="font-headline text-3xl font-extrabold mt-1">{user?.credits ?? 0}</p>
        </div>
      </header>

      {error && (
        <div className="bg-error-container/10 text-error border border-error/20 px-4 py-3 rounded-xl text-sm flex items-center gap-2">
          <Icon name="error" /> {error}
        </div>
      )}

      <section className="grid grid-cols-1 sm:grid-cols-3 gap-5">
        {BUNDLES.map((b) => (
          <div key={b.id} className={`relative bg-surface-container-lowest p-6 rounded-3xl border ${b.featured ? 'border-primary shadow-xl' : 'border-outline-variant/10'} flex flex-col`}>
            {b.badge && (
              <span className={`absolute -top-2.5 right-4 px-3 py-1 rounded-full font-label text-[10px] uppercase font-bold tracking-widest ${
                b.featured ? 'bg-primary text-on-primary' : 'bg-on-surface text-surface'
              }`}>{b.badge}</span>
            )}
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-primary-container/30 flex items-center justify-center">
                <Icon name={b.icon} className="text-primary text-2xl" />
              </div>
              <div>
                <h3 className="font-headline font-bold text-base">{b.name}</h3>
                <p className="text-xs text-on-surface-variant">{b.desc}</p>
              </div>
            </div>
            <p className="font-headline text-3xl font-black mb-1">{b.price}</p>
            <p className="text-on-surface-variant text-sm mb-6">{b.credits} credits</p>
            <button onClick={() => handlePurchase(b.id)} disabled={purchasing !== null}
              className="mt-auto bg-primary-container text-on-primary-container py-3 rounded-xl font-headline font-bold text-sm hover:scale-[1.02] active:scale-95 transition-all disabled:opacity-50">
              {purchasing === b.id ? 'Adding…' : 'Buy'}
            </button>
          </div>
        ))}
      </section>

      <section>
        <h2 className="font-headline text-xl font-bold tracking-tight mb-4">Recent transactions</h2>
        {transactions.length === 0 ? (
          <p className="text-on-surface-variant text-sm">No credit activity yet.</p>
        ) : (
          <div className="bg-surface-container-lowest rounded-2xl overflow-hidden border border-outline-variant/10">
            <table className="w-full text-sm">
              <thead className="bg-surface-container-low">
                <tr className="text-left">
                  <th className="px-4 py-3 font-label text-[10px] uppercase tracking-widest text-on-surface-variant">Date</th>
                  <th className="px-4 py-3 font-label text-[10px] uppercase tracking-widest text-on-surface-variant">Reason</th>
                  <th className="px-4 py-3 font-label text-[10px] uppercase tracking-widest text-on-surface-variant text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((tx) => (
                  <tr key={tx.id} className="border-t border-outline-variant/10">
                    <td className="px-4 py-3 text-on-surface-variant">{new Date(tx.created_at).toLocaleString()}</td>
                    <td className="px-4 py-3">{tx.reason}</td>
                    <td className={`px-4 py-3 text-right font-bold ${tx.amount > 0 ? 'text-primary' : 'text-error'}`}>
                      {tx.amount > 0 ? '+' : ''}{tx.amount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
