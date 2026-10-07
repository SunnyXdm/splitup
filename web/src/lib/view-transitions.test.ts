import { describe, expect, it } from 'vitest';
import { routeTransitionKind, tabSection } from './view-transitions';

describe('tabSection', () => {
  it('maps paths to their bottom-nav section', () => {
    expect(tabSection('/')).toBe('/');
    expect(tabSection('/groups/3')).toBe('/');
    expect(tabSection('/friends/7')).toBe('/friends');
    expect(tabSection('/account')).toBe('/account');
    expect(tabSection('/search')).toBeNull();
  });
});

describe('routeTransitionKind', () => {
  it('never animates a same-path change (search params, overlay history entries)', () => {
    expect(routeTransitionKind('/groups/1', '/groups/1', 'POP', 0)).toBeNull();
    expect(routeTransitionKind('/groups/1', '/groups/1', 'REPLACE', null)).toBeNull();
  });

  it('pushes forward and pops back', () => {
    expect(routeTransitionKind('/', '/groups/1', 'PUSH', null)).toBe('forward');
    expect(routeTransitionKind('/groups/1', '/', 'POP', -1)).toBe('back');
    expect(routeTransitionKind('/', '/groups/1', 'POP', 1)).toBe('forward');
  });

  it('cross-fades between tabs', () => {
    expect(routeTransitionKind('/', '/friends', 'PUSH', null)).toBe('tab');
    expect(routeTransitionKind('/friends/2', '/', 'PUSH', null)).toBe('tab');
    expect(routeTransitionKind('/search', '/activity', 'POP', -1)).toBe('tab');
  });
});
