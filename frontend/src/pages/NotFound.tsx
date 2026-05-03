import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { usePageTitle } from '../hooks/usePageTitle';

export function NotFound() {
  usePageTitle('Not Found');
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="text-center space-y-6 max-w-md">
        <Icon name="search_off" className="text-7xl text-outline-variant" />
        <h1 className="font-headline text-4xl font-black tracking-tighter">Page not found</h1>
        <p className="text-on-surface-variant">The link you followed is broken or has moved.</p>
        <Link to="/" className="inline-block bg-primary-container text-on-primary-container px-6 py-3 rounded-xl font-headline font-bold">
          Go home
        </Link>
      </div>
    </main>
  );
}
