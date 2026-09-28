// SPDX-License-Identifier: MPL-2.0
import { createSource } from '../logic/provider.mjs';
import { createConnectFlow } from '../logic/connect-flow.mjs';

function check(value, message) {
    if (!value)
        throw new Error('Connect contract: ' + message);
}
function response(body) { return Promise.resolve({ status: 200, body: JSON.stringify(body) }); }
function failure(operation, expected) {
    return Promise.resolve().then(operation).then(() => { throw new Error('Expected ' + expected); },
        error => check(error.message === expected, 'expected ' + expected + ', got ' + error.message));
}
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise: promise, resolve: resolve };
}

export function connectContracts() {
    const device = { id: 'device & one', version: '1.2', name: 'Spool' };
    let source = createSource({}, { device: device }); // Deliberately API 0.2: no extensions.
    let approved = false;
    let pinApproved = false;
    let advertisedId = 'server-one';
    let exchanges = 0;
    const calls = [];
    const host = { http: (url, options) => {
        calls.push({ url: url, options: options });
        const h = options.headers;
        if (url.indexOf('https://connect.emby.media/') === 0) {
            check(!h['X-Emby-Token'] && !h['X-Emby-Authorization'], 'local credentials never reach Connect');
            check(h['X-Application'] === 'Spool/1.2', 'cloud client application header');
            if (url === 'https://connect.emby.media/service/pin' && options.method === 'POST') {
                check(options.body === 'deviceId=device%20%26%20one'
                    && h['Content-Type'] === 'application/x-www-form-urlencoded', 'PIN creation form');
                return response({ Pin: 'AB CD', DeviceId: device.id });
            }
            if (url === 'https://connect.emby.media/service/pin?pin=AB%20CD&deviceId=device%20%26%20one')
                return response({ IsExpired: false, IsConfirmed: pinApproved });
            if (url === 'https://connect.emby.media/service/pin/authenticate') {
                check(pinApproved && options.method === 'POST' && options.body === 'pin=AB%20CD&deviceId=device%20%26%20one'
                    && h['Content-Type'] === 'application/x-www-form-urlencoded', 'approved PIN exchange form');
                return response({ UserId: 'connect-user', AccessToken: 'cloud-secret' });
            }
            if (url === 'https://connect.emby.media/service/servers?userId=connect-user') {
                check(h['X-Connect-UserToken'] === 'cloud-secret', 'cloud token only authorizes membership retrieval');
                return response([
                    { SystemId: 'server-one', Name: 'My server', AccessKey: 'membership-secret',
                        LocalAddress: 'http://192.168.1.10:8096', Url: 'https://selected.example/base/emby' },
                    { SystemId: 'other-server', AccessKey: 'other-key', Url: 'https://unselected.example' },
                    { SystemId: 'unsafe', AccessKey: 'unsafe-key', Url: 'https://connect.emby.media' }
                ]);
            }
        } else {
            check(approved && url.indexOf('https://selected.example/base/emby/') === 0,
                'only the explicitly selected and approved connection receives requests');
            check(!h['X-Connect-UserToken'] && JSON.stringify(options).indexOf('cloud-secret') < 0,
                'Connect token never reaches a media server');
            check(h['X-Emby-Authorization'].indexOf('Client="Spool"') >= 0, 'normal client authorization accompanies local calls');
            if (url.endsWith('/System/Info/Public')) {
                check(!h['X-Emby-Token'], 'verify advertised identity before disclosing membership AccessKey');
                return response({ Id: advertisedId, ServerName: 'My server' });
            }
            if (url.endsWith('/Connect/Exchange?format=json&ConnectUserId=connect-user')) {
                ++exchanges;
                check(h['X-Emby-Token'] === 'membership-secret', 'exchange uses selected membership key, not cloud/local token');
                return response({ LocalUserId: 'local-user', AccessToken: 'local-secret' });
            }
            if (url.endsWith('/Users/local-user')) {
                check(h['X-Emby-Token'] === 'local-secret', 'local user request uses exchanged local token');
                return response({ Id: 'local-user', Name: 'Local name' });
            }
        }
        throw new Error('Unexpected Connect request');
    } };
    let membership;
    return source.connectPin({}, host).then(result => {
        check(result.pin === 'AB CD', 'PIN display code');
        return source.connectPoll(result, host);
    }).then(result => {
        check(!result.confirmed && !result.expired, 'pending code remains pending');
        pinApproved = true;
        return source.connectPoll({ pin: 'AB CD' }, host);
    }).then(result => {
        check(result.confirmed, 'approval becomes visible');
        return source.connectAuthenticate({ pin: 'AB CD' }, host);
    }).then(result => {
        check(result.memberships.length === 2 && JSON.stringify(result).indexOf('cloud-secret') < 0,
            'cloud token is discarded and invalid cloud-as-media membership omitted');
        membership = result.memberships[0];
        check(calls.every(call => call.url.indexOf('https://connect.emby.media/') === 0),
            'listing memberships never probes or approves their servers');
        approved = true;
        source = createSource({}, { device: device }); // allowOrigin recreates the setup source.
        return source.connectExchange({ server: membership.addresses[1], serverId: membership.id,
            userId: membership.userId, accessKey: membership.accessKey }, host);
    }).then(account => {
        check(account.account === 'local-user@server-one' && account.group === 'server-one'
            && account.label === 'Local name' && account.configuration.server === 'https://selected.example/base'
            && account.configuration.token === 'local-secret', 'ordinary local account survives setup source recreation');
        const saved = JSON.stringify(account);
        check(saved.indexOf('membership-secret') < 0 && saved.indexOf('cloud-secret') < 0
            && saved.indexOf('AB CD') < 0 && saved.indexOf('connect-user') < 0,
            'neither PIN nor intermediate Connect credentials are persisted');
        advertisedId = 'wrong-server';
        return failure(() => source.connectExchange({ server: membership.addresses[1], serverId: membership.id,
            userId: membership.userId, accessKey: membership.accessKey }, host), 'connect_server_mismatch');
    }).then(() => {
        check(exchanges === 1, 'wrong advertised identity rejected before sending the membership key');
        return failure(() => source.connectExchange({ server: 'https://connect.emby.media', serverId: 'id',
            userId: 'connect-user', accessKey: 'membership-secret' }, host), 'invalid_server');
    }).then(flowContracts);
}

function flowContracts() {
    let state;
    let timer = null;
    let closed = false;
    let pending = null;
    let pendingOperation = '';
    let requestCount = 0;
    let completeCount = 0;
    let approval;
    const flow = createConnectFlow({
        closed: () => closed,
        changed: value => { state = value; },
        schedule: (callback, delay) => {
            check(delay === 2000 && !timer, 'exactly one serial two-second poll is scheduled');
            timer = callback;
        },
        stopTimer: () => { timer = null; },
        request: (operation, args) => {
            ++requestCount;
            pendingOperation = operation;
            pending = deferred();
            return pending.promise;
        },
        approve: address => {
            check(address === 'https://chosen.example', 'approval names only the selected connection');
            approval = deferred();
            return approval.promise;
        },
        complete: () => { ++completeCount; }
    });
    function fire() {
        const callback = timer;
        check(callback, 'waiting for the next poll');
        timer = null;
        return callback();
    }
    let operation = flow.start();
    pending.resolve({ pin: 'old' });
    return operation.then(() => {
        const poll = fire();
        check(pendingOperation === 'connectPoll' && !timer, 'no overlapping poll during pending HTTP');
        flow.cancel();
        pending.resolve({ confirmed: true, expired: false });
        return poll;
    }).then(() => {
        check(requestCount === 2 && completeCount === 0 && !timer,
            'cancelled approval response never exchanges credentials or completes');
        const stale = flow.start();
        const oldRequest = pending;
        const fresh = flow.start();
        pending.resolve({ pin: 'fresh' });
        oldRequest.resolve({ pin: 'stale' });
        return Promise.all([stale, fresh]);
    }).then(() => {
        check(state.pin === 'fresh', 'new-code request supersedes stale creation');
        const poll = fire();
        pending.resolve({ confirmed: false, expired: false });
        return poll;
    }).then(() => {
        check(timer && state.pin === 'fresh', 'pending result schedules another poll only after completion');
        const poll = fire();
        pending.resolve({ confirmed: true, expired: true });
        return poll;
    }).then(() => {
        check(state.phase === 'error' && state.error === 'connect_expired' && !state.pin && !timer,
            'expired code clears secret, stops polling and never authenticates even if confirmed');
        operation = flow.start();
        pending.resolve({ pin: 'approved' });
        return operation;
    }).then(() => {
        operation = fire();
        pending.resolve({ confirmed: true, expired: false });
        return Promise.resolve();
    }).then(() => {
        check(pendingOperation === 'connectAuthenticate', 'approval begins credential exchange');
        pending.resolve({ memberships: [{ id: 'chosen', name: 'Chosen', userId: 'user', accessKey: 'key',
            addresses: ['https://chosen.example', 'http://unselected.example'] }] });
        return operation;
    }).then(() => {
        check(state.phase === 'members' && !state.pin && !timer, 'membership choice ends PIN polling');
        const selected = flow.select(0, 0);
        const before = requestCount;
        flow.cancel();
        approval.resolve();
        return selected.then(() => check(requestCount === before && !completeCount,
            'cancelled origin approval cannot begin a media-server exchange'));
    }).then(() => {
        operation = flow.start();
        pending.resolve({ pin: 'closing' });
        return operation;
    }).then(() => {
        const poll = fire();
        closed = true;
        pending.resolve({ confirmed: true, expired: false });
        return poll;
    }).then(() => check(!timer && !completeCount && pendingOperation === 'connectPoll',
        'closed context discards pending confirmation without authentication'));
}
