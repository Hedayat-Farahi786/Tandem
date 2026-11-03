import { useEffect, useState } from 'react';
import type { Bootstrap } from './types';

/** The project whose chats the sidebar lists: the one in the address, else the last one used. */
export function useChatProject(boot: Bootstrap | undefined, search: URLSearchParams): string {
  const fromUrl = search.get('project');
  const [last, setLast] = useState(() => {
    try {
      return localStorage.getItem('tandem.project') ?? '';
    } catch {
      return '';
    }
  });
  useEffect(() => {
    if (!fromUrl || fromUrl === last) return;
    setLast(fromUrl);
    try {
      localStorage.setItem('tandem.project', fromUrl);
    } catch {
      // private mode: the sidebar still follows the address
    }
  }, [fromUrl, last]);
  const ids = boot?.projects.map((p) => p.id) ?? [];
  if (fromUrl && ids.includes(fromUrl)) return fromUrl;
  return ids.includes(last) ? last : (ids[0] ?? '');
}
