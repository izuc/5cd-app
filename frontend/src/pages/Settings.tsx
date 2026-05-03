import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuthStore } from '../store/authStore';
import { Icon } from '../components/Icon';
import { usePageTitle } from '../hooks/usePageTitle';

export function Settings() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  usePageTitle('Settings');

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [pwMsg, setPwMsg] = useState('');
  const [pwErr, setPwErr] = useState('');
  const [pwBusy, setPwBusy] = useState(false);

  const [deletePassword, setDeletePassword] = useState('');
  const [deleteErr, setDeleteErr] = useState('');
  const [deleting, setDeleting] = useState(false);

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwErr('');
    setPwMsg('');
    setPwBusy(true);
    try {
      const res = await api.changePassword(currentPassword, newPassword);
      setPwMsg(res.message);
      setCurrentPassword('');
      setNewPassword('');
    } catch (err: any) {
      setPwErr(err.message || 'Failed to change password');
    } finally {
      setPwBusy(false);
    }
  };

  const handleDeleteAccount = async () => {
    setDeleteErr('');
    setDeleting(true);
    try {
      await api.deleteAccount(deletePassword);
      logout();
      navigate('/');
    } catch (err: any) {
      setDeleteErr(err.message || 'Failed to delete account');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12 space-y-8">
      <header>
        <h1 className="font-headline text-3xl sm:text-4xl font-black tracking-tighter">Settings</h1>
        <p className="text-on-surface-variant mt-1">{user?.email}</p>
      </header>

      <section className="bg-surface-container-lowest rounded-2xl p-6 space-y-4">
        <h2 className="font-headline font-bold text-lg">Change password</h2>
        {pwMsg && <div className="bg-primary-container/30 text-on-primary-container px-4 py-3 rounded-xl text-sm">{pwMsg}</div>}
        {pwErr && (
          <div className="bg-error-container/10 text-error border border-error/20 px-4 py-3 rounded-xl text-sm flex items-center gap-2">
            <Icon name="error" /> {pwErr}
          </div>
        )}
        <form onSubmit={handleChangePassword} className="space-y-3">
          <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required
            placeholder="Current password" autoComplete="current-password"
            className="w-full bg-surface-container-low rounded-xl p-3 focus:ring-2 focus:ring-primary/40 text-sm" />
          <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={6}
            placeholder="New password (min 6)" autoComplete="new-password"
            className="w-full bg-surface-container-low rounded-xl p-3 focus:ring-2 focus:ring-primary/40 text-sm" />
          <button type="submit" disabled={pwBusy}
            className="bg-primary text-on-primary px-5 py-2.5 rounded-xl font-headline font-bold text-sm disabled:opacity-50">
            {pwBusy ? 'Saving…' : 'Update password'}
          </button>
        </form>
      </section>

      <section className="bg-surface-container-lowest rounded-2xl p-6 space-y-4 border border-error/20">
        <h2 className="font-headline font-bold text-lg text-error">Danger zone</h2>
        <p className="text-sm text-on-surface-variant">Delete your account and all its data.</p>
        {deleteErr && (
          <div className="bg-error-container/10 text-error border border-error/20 px-4 py-3 rounded-xl text-sm flex items-center gap-2">
            <Icon name="error" /> {deleteErr}
          </div>
        )}
        <input type="password" value={deletePassword} onChange={(e) => setDeletePassword(e.target.value)}
          placeholder="Confirm with your password"
          className="w-full bg-surface-container-low rounded-xl p-3 focus:ring-2 focus:ring-error/40 text-sm" />
        <button onClick={handleDeleteAccount} disabled={deleting || !deletePassword}
          className="bg-error text-on-error px-5 py-2.5 rounded-xl font-headline font-bold text-sm disabled:opacity-50">
          {deleting ? 'Deleting…' : 'Delete account'}
        </button>
      </section>
    </main>
  );
}
