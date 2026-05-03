import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { Icon } from '../components/Icon';
import { usePageTitle } from '../hooks/usePageTitle';

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuthStore();
  const navigate = useNavigate();
  usePageTitle('Sign In');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      navigate('/dashboard');
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-[calc(100vh-72px)] flex items-center justify-center px-6 py-12 bg-surface">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <h1 className="font-headline text-4xl font-black tracking-tighter text-on-surface">Welcome back</h1>
          <p className="text-on-surface-variant mt-2">Sign in to your 5cd account</p>
        </div>
        <form onSubmit={handleSubmit} className="bg-surface-container-lowest p-8 rounded-3xl shadow-[0_20px_40px_rgba(30,30,30,0.06)] space-y-6">
          {error && (
            <div className="bg-error-container/10 text-error border border-error/20 px-4 py-3 rounded-xl text-sm flex items-center gap-2">
              <Icon name="error" className="text-lg" /> {error}
            </div>
          )}
          <div className="space-y-2">
            <label className="font-label text-xs uppercase tracking-widest text-on-surface-variant font-bold ml-1">Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required
              className="w-full bg-surface-container-low border-none rounded-xl p-4 focus:ring-2 focus:ring-primary/40 text-on-surface font-medium placeholder:text-outline-variant transition-all"
              placeholder="you@example.com" />
          </div>
          <div className="space-y-2">
            <label className="font-label text-xs uppercase tracking-widest text-on-surface-variant font-bold ml-1">Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6}
              className="w-full bg-surface-container-low border-none rounded-xl p-4 focus:ring-2 focus:ring-primary/40 text-on-surface font-medium placeholder:text-outline-variant transition-all"
              placeholder="Enter your password" />
          </div>
          <button type="submit" disabled={loading}
            className="w-full bg-primary-container text-on-primary-container py-4 rounded-xl font-headline font-bold text-lg hover:scale-[1.01] active:scale-95 transition-all disabled:opacity-50 flex items-center justify-center gap-2">
            {loading ? 'Signing in...' : 'Sign In'}
            {!loading && <Icon name="arrow_forward" />}
          </button>
        </form>
        <p className="text-center text-on-surface-variant">
          Don't have an account?{' '}
          <Link to="/register" className="text-primary font-bold hover:underline">Sign up free</Link>
        </p>
      </div>
    </main>
  );
}
