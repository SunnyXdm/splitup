import { describe, expect, it } from 'vitest';
import { hasInAppHistory, isChromelessPath, isTabRoot, parentPath } from './back-nav';

describe('back navigation', () => {
  it('knows the tab roots', () => {
    expect(isTabRoot('/')).toBe(true);
    expect(isTabRoot('/friends')).toBe(true);
    expect(isTabRoot('/friends/3')).toBe(false);
    expect(isTabRoot('/search')).toBe(false);
  });
  it('falls back to the parent tab', () => {
    expect(parentPath('/friends/3')).toBe('/friends');
    expect(parentPath('/groups/7')).toBe('/');
    expect(parentPath('/search')).toBe('/');
    expect(parentPath('/join/abc')).toBe('/');
  });
  it('detects an in-app previous entry from the router index', () => {
    expect(hasInAppHistory({ idx: 2, key: 'k' })).toBe(true);
    expect(hasInAppHistory({ idx: 0, key: 'k' })).toBe(false);
    expect(hasInAppHistory(null)).toBe(false);
    expect(hasInAppHistory({ usr: null })).toBe(false);
  });
  it('treats invite landings as chromeless', () => {
    expect(isChromelessPath('/join/abc')).toBe(true);
    expect(isChromelessPath('/friend/abc')).toBe(true);
    expect(isChromelessPath('/claim/abc')).toBe(true);
    expect(isChromelessPath('/friends/3')).toBe(false);
  });
});
