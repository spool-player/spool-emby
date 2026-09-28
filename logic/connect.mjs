// SPDX-License-Identifier: MPL-2.0
// Stateless setup operations: the login screen owns the short-lived PIN and
// memberships, so adding an approved origin may recreate the draft source.
const origin = 'https://connect.emby.media';

function text(value) {
    if (typeof value !== 'string' || !value || value.length > 4096 || /[\r\n]/.test(value))
        throw new Error('invalid_connect_response');
    return value;
}

function form(values) {
    return Object.keys(values).map(key => encodeURIComponent(key) + '=' + encodeURIComponent(values[key])).join('&');
}

function json(response) {
    if (response.status < 200 || response.status >= 300)
        throw new Error(response.status === 404 || response.status === 410 ? 'connect_expired' : 'connect_unavailable');
    try { return JSON.parse(response.body); }
    catch (error) { throw new Error('invalid_connect_response'); }
}

export function createConnect(device, normalizeServer, headers, info) {
    function serverAddress(value) {
        if (typeof value !== 'string' || !/^https?:\/\//i.test(value))
            throw new Error('invalid_server');
        const base = normalizeServer(value);
        // Cloud and local authentication roles must never cross, even if a
        // malformed membership advertises Connect itself as a media server.
        if (/^https?:\/\/connect\.emby\.media(?::\d+)?(?:\/|$)/i.test(base))
            throw new Error('invalid_server');
        return base;
    }

    function cloud(host, method, path, values, token) {
        const requestHeaders = { Accept: 'application/json', 'X-Application': 'Spool/' + (device.version || '0') };
        if (token)
            requestHeaders['X-Connect-UserToken'] = text(token);
        const encoded = form(values || {});
        if (method === 'POST')
            requestHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
        return host.http(origin + '/service/' + path + (method === 'GET' && encoded ? '?' + encoded : ''), {
            method: method, headers: requestHeaders, body: method === 'POST' ? encoded : ''
        }).then(json);
    }

    function pinFields(args) {
        return { pin: text(args.pin), deviceId: text(device.id) };
    }

    return {
        connectPin: (args, host) => cloud(host, 'POST', 'pin', { deviceId: text(device.id) }).then(result => {
            if (!result || result.IsExpired === true)
                throw new Error('connect_expired');
            return { pin: text(result.Pin) };
        }),
        connectPoll: (args, host) => cloud(host, 'GET', 'pin', pinFields(args)).then(result => {
            if (!result || typeof result.IsConfirmed !== 'boolean' && result.IsExpired !== true)
                throw new Error('invalid_connect_response');
            return { expired: result.IsExpired === true, confirmed: result.IsConfirmed === true };
        }),
        connectAuthenticate: (args, host) => cloud(host, 'POST', 'pin/authenticate', pinFields(args)).then(result => {
            const userId = text(result.UserId);
            const cloudToken = text(result.AccessToken);
            return cloud(host, 'GET', 'servers', { userId: userId }, cloudToken).then(servers => {
                if (!Array.isArray(servers) || servers.length > 128)
                    throw new Error('invalid_connect_response');
                const memberships = [];
                for (const entry of servers) {
                    const addresses = [];
                    for (const value of [entry.LocalAddress, entry.Url]) {
                        if (!value)
                            continue;
                        try {
                            const address = serverAddress(value);
                            if (addresses.indexOf(address) < 0)
                                addresses.push(address);
                        } catch (error) {}
                    }
                    if (addresses.length)
                        memberships.push({ id: text(entry.SystemId), name: String(entry.Name || entry.SystemId),
                            addresses: addresses, accessKey: text(entry.AccessKey), userId: userId });
                }
                // The Connect account token is deliberately not returned to QML.
                return { memberships: memberships };
            });
        }),
        connectExchange: (args, host) => {
            const base = serverAddress(args.server);
            const serverId = text(args.serverId);
            const connectUserId = text(args.userId);
            const accessKey = text(args.accessKey);
            return info(host, base).then(found => {
                if (found.Id !== serverId)
                    throw new Error('connect_server_mismatch');
                const exchangeHeaders = headers(false);
                exchangeHeaders['X-Emby-Token'] = accessKey;
                return host.http(base + '/emby/Connect/Exchange?' + form({ format: 'json', ConnectUserId: connectUserId }), {
                    method: 'GET', headers: exchangeHeaders
                }).then(json).then(result => {
                    const localUserId = text(result.LocalUserId);
                    const localToken = text(result.AccessToken);
                    if (result.ServerId && result.ServerId !== serverId)
                        throw new Error('connect_server_mismatch');
                    const localHeaders = headers(false);
                    localHeaders['X-Emby-Token'] = localToken;
                    return host.http(base + '/emby/Users/' + encodeURIComponent(localUserId), {
                        method: 'GET', headers: localHeaders
                    }).then(json).then(user => {
                        if (!user || user.Id !== localUserId)
                            throw new Error('invalid_connect_response');
                        return { account: localUserId + '@' + serverId, group: serverId, label: user.Name || '',
                            detail: found.ServerName || base.replace(/^https?:\/\//, ''),
                            configuration: { server: base, userId: localUserId, token: localToken,
                                userName: user.Name || '', serverId: serverId, serverName: found.ServerName || '' } };
                    });
                });
            });
        }
    };
}
