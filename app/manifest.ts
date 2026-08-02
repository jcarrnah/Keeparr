import type { MetadataRoute } from 'next';
import { getAppTitle } from '@/lib/settings';

/**
 * PWA manifest (served at /manifest.webmanifest, auto-linked by Next).
 * Lets phones/desktops install Keeparr as a standalone app, with jump-list
 * shortcuts to the three main views. Colors match the dark theme (the
 * dominant one; manifests are static per install).
 */
export default function manifest(): MetadataRoute.Manifest {
  const title = getAppTitle();
  return {
    name: title,
    short_name: title,
    description: 'Decide what media to keep, and find what can be deleted.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0b1120', // app
    theme_color: '#0f172a', // rail
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
    shortcuts: [
      { name: 'Keep', url: '/', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      // FORK (3.8): the shortcut is "I want to swipe now", so it skips the
      // landing page and goes to the deck; movie night gets its own entry.
      { name: 'Swipe', url: '/swipe/deck', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      { name: 'Movie night', url: '/swipe?home=1', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      { name: 'Browse', url: '/library', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      { name: 'Big Picture', url: '/stats', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
    ],
  };
}
