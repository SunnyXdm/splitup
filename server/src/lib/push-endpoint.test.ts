import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isPublicAddress, isPublicPushEndpoint, type HostLookup } from './push-endpoint';

const resolvesTo =
  (...addresses: string[]): HostLookup =>
  async () =>
    addresses.map((address) => ({ address }));

describe('push endpoint addresses', () => {
  it('accepts public addresses', () => {
    for (const ip of ['142.250.183.10', '8.8.8.8', '2607:f8b0:4004:c07::5f', '2a00:1450::1']) {
      assert.equal(isPublicAddress(ip), true, ip);
    }
  });

  it('refuses private, loopback, link-local, ULA and mapped-private addresses', () => {
    for (const ip of [
      '10.1.2.3',
      '127.0.0.1',
      '0.0.0.0',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '100.64.0.1',
      '224.0.0.1',
      '::',
      '::1',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      '::ffff:10.0.0.1',
      '::ffff:7f00:1',
      '64:ff9b::a00:1',
      'not-an-ip',
    ]) {
      assert.equal(isPublicAddress(ip), false, ip);
    }
  });
});

describe('isPublicPushEndpoint', () => {
  it('accepts an https endpoint on the default port resolving only to public hosts', async () => {
    assert.equal(
      await isPublicPushEndpoint(
        'https://fcm.googleapis.com/fcm/send/x',
        resolvesTo('142.250.183.10', '2607:f8b0:4004:c07::5f'),
      ),
      true,
    );
    assert.equal(
      await isPublicPushEndpoint('https://push.example.com:443/x', resolvesTo('8.8.8.8')),
      true,
    );
  });

  it('refuses any private answer, other ports, and lookup failures', async () => {
    assert.equal(
      await isPublicPushEndpoint('https://evil.example.com/x', resolvesTo('8.8.8.8', '10.0.0.1')),
      false,
    );
    assert.equal(
      await isPublicPushEndpoint('https://push.example.com:8443/x', resolvesTo('8.8.8.8')),
      false,
    );
    assert.equal(await isPublicPushEndpoint('https://push.example.com/x', resolvesTo()), false);
    assert.equal(
      await isPublicPushEndpoint('https://push.example.com/x', async () => {
        throw new Error('ENOTFOUND');
      }),
      false,
    );
    assert.equal(
      await isPublicPushEndpoint('http://push.example.com/x', resolvesTo('8.8.8.8')),
      false,
    );
  });
});
