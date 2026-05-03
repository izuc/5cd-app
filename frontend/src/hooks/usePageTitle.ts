import { useEffect } from 'react';

export function usePageTitle(title: string) {
  useEffect(() => {
    const prev = document.title;
    document.title = title ? `${title} — 5cd` : '5cd — AI Design Studio';
    return () => { document.title = prev; };
  }, [title]);
}
