import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { Icon } from '../components/Icon';
import { usePageTitle } from '../hooks/usePageTitle';

export function Register() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { register } = useAuthStore();
  const navigate = useNavigate();
  usePageTitle('Create Account');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await register(email, password, displayName);
      navigate('/dashboard');
    } catch (err: any) {
      setError(err.message || 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-[calc(100vh-72px)] flex items-center justify-center px-6 py-12 bg-surface">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <h1 className="font-headline text-4xl font-black tracking-tighter text-on-surface">Create your account</h1>
          <p className="text-on-surface-variant mt-2">5 free credits every day to design with</p>
        </div>
        <form onSubmit={handleSubmit} className="bg-surface-container-lowest p-8 rounded-3xl shadow-[0_20px_40px_rgba(30,30,30,0.06)] space-y-6">
          {error && (
            <div className="bg-error-container/10 text-error border border-error/20 px-4 py-3 rounded-xl text-sm flex items-center gap-2">
              <Icon name="error" className="text-lg" /> {error}
            </div>
          )}
          <div className="space-y-2">
            <label className="font-label text-xs uppercase tracking-widest text-on-surface-variant font-bold ml-1">Display Name</label>
            <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required
              className="w-full bg-surface-container-low border-none rounded-xl p-4 focus:ring-2 focus:ring-primary/40 text-on-surface font-medium placeholder:text-outline-variant transition-all"
              placeholder="Your name or business" />
          </div>
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
              placeholder="Min. 6 characters" />
          </div>
          <button type="submit" disabled={loading}
            className="w-full bg-primary-container text-on-primary-container py-4 rounded-xl font-headline font-bold text-lg hover:scale-[1.01] active:scale-95 transition-all disabled:opacity-50 flex items-center justify-center gap-2">
            {loading ? 'Creating account...' : 'Sign Up Free'}
            {!loading && <Icon name="auto_awesome" />}
          </button>
          <p className="text-center text-xs text-on-surface-variant">
            You'll get <span className="font-bold text-primary">5 free credits every day</span> — 1 credit per concept
          </p>
        </form>
        <p className="text-center text-on-surface-variant">
          Already have an account?{' '}
          <Link to="/login" className="text-primary font-bold hover:underline">Sign in</Link>
        </p>
      </div>
    </main>
  );
}
