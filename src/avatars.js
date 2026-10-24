// Avatars drawn locally with DiceBear (no network). Each AI picks a style and a
// seed; the same pair always draws the same picture. Only styles whose artwork is
// CC0 or "free for personal and commercial use" are included (no attribution needed).

import { createAvatar } from '@dicebear/core';
import * as bottts from '@dicebear/bottts';
import * as botttsNeutral from '@dicebear/bottts-neutral';
import * as avataaars from '@dicebear/avataaars';
import * as lorelei from '@dicebear/lorelei';
import * as notionists from '@dicebear/notionists';
import * as openPeeps from '@dicebear/open-peeps';
import * as pixelArt from '@dicebear/pixel-art';
import * as thumbs from '@dicebear/thumbs';
import * as shapes from '@dicebear/shapes';
import * as identicon from '@dicebear/identicon';
import * as rings from '@dicebear/rings';
import * as glass from '@dicebear/glass';
import * as icons from '@dicebear/icons';

export const AVATAR_STYLES = {
  bottts, 'bottts-neutral': botttsNeutral, avataaars, lorelei, notionists, 'open-peeps': openPeeps,
  'pixel-art': pixelArt, thumbs, shapes, identicon, rings, glass, icons,
};
export const AVATAR_STYLE_NAMES = Object.keys(AVATAR_STYLES);

/** Accepts "style", "style:seed" or {style, seed}; returns a valid {style, seed} or throws a helpful message. */
export function parseAvatar(input, fallbackSeed) {
  if (!input) return null;
  let style;
  let seed;
  if (typeof input === 'object') ({ style, seed } = input);
  else [style, ...seed] = String(input).split(':'), (seed = seed.join(':'));
  style = String(style || '').trim().toLowerCase();
  if (!AVATAR_STYLES[style]) throw new Error(`Unknown avatar style "${style}". Choose one of: ${AVATAR_STYLE_NAMES.join(', ')}.`);
  seed = String(seed || fallbackSeed || 'crewroom').trim().slice(0, 60);
  return { style, seed };
}

const cache = new Map();
export function avatarSvg({ style, seed }) {
  const key = `${style}:${seed}`;
  if (!cache.has(key)) {
    if (cache.size > 500) cache.clear();
    cache.set(key, createAvatar(AVATAR_STYLES[style], { seed, radius: 50 }).toString());
  }
  return cache.get(key);
}
