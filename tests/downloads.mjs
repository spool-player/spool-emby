// SPDX-License-Identifier: MPL-2.0
import { createSource } from '../logic/provider.mjs';
const check = (value, message) => { if (!value) throw new Error('download contract: ' + message); };
const response = value => Promise.resolve({ status: 200, body: JSON.stringify(value) });
function parameters(url) {
    const result = {};
    for (const pair of (url.split('?')[1] || '').split('&')) {
        const parts = pair.split('=');
        if (parts[0]) result[decodeURIComponent(parts[0])] = decodeURIComponent(parts[1] || '');
    }
    return result;
}
function fails(operation, code) {
    return Promise.resolve().then(operation).then(() => { throw new Error('expected ' + code); },
        error => check(error.message === code, 'expected ' + code + ', got ' + error.message));
}
export function downloadContracts() {
    let policy = { EnableContentDownloading: true, EnableVideoPlaybackTranscoding: true,
        EnableAudioPlaybackTranscoding: true, EnableSyncTranscoding: true };
    let sources = ['theatrical', 'extended'].map(id => ({ Id: id, Name: id, Protocol: 'File', Container: 'mkv',
        Size: 1234567, MediaStreams: [{ Type: 'Video', Codec: 'hevc', Height: 2160 }] }));
    let multipart = false;
    let hls = false;
    const calls = [];
    const logs = [];
    const host = { device: { id: 'viewer' }, isLogEnabled: () => true,
        log: (level, message, fields) => logs.push({ level: level,
            message: typeof message === 'function' ? message() : message, fields: fields }),
        http: (url, options) => {
            const path = url.split('?')[0].replace('https://media.example/emby', '');
            const body = options.body ? JSON.parse(options.body) : {};
            const query = parameters(url);
            calls.push({ path: path, body: body, query: query, method: options.method });
            if (path === '/Users/u') return response({ Id: 'u', Policy: policy });
            if (path === '/Users/u/Items/film')
                return response({ Id: 'film', Name: 'Film', MediaType: 'Video', PartCount: multipart ? 2 : 1,
                    MediaSources: sources });
            if (path === '/Items/film/PlaybackInfo') {
                check(body.IsPlayback === false && !body.EnableDirectPlay && !body.EnableDirectStream
                    && !body.AutoOpenLiveStream && body.StartTimeTicks === 0,
                    'download negotiation neither starts playback nor opens a live source');
                const profile = body.DeviceProfile.TranscodingProfiles[0];
                check(profile.Protocol === 'http' && profile.Container === 'mp4' && profile.Context === 'Streaming'
                    && profile.VideoCodec === 'h264' && profile.AudioCodec === 'aac'
                    && profile.MaxHeight === 720 && body.MaxStreamingBitrate === 2000000,
                    'server receives a progressive encoding profile with chosen quality ceilings');
                return response({ PlaySessionId: 'offline-session', MediaSources: sources
                    .filter(source => source.Id === body.MediaSourceId).map(source => Object.assign({}, source, {
                        SupportsTranscoding: true, TranscodingContainer: 'mp4', TranscodingSubProtocol: hls ? 'hls' : 'http',
                        TranscodingUrl: hls ? '/Videos/film/master.m3u8' : '/Videos/film/stream.mp4?'
                            + 'api_key=secret&MediaSourceId=' + source.Id + '&VideoCodec=copy&StartTimeTicks=5000'
                            + '&DeviceId=viewer&AudioBitrate=128000&VideoBitrate=1900000'
                    })) });
            }
            if (path === '/Videos/ActiveEncodings') return response({});
            throw new Error('unexpected download request');
        } };
    const source = createSource({ server: 'https://media.example', userId: 'u', token: 'secret' }, host);
    const args = { itemId: 'film', mode: 'transcoded', maxBitrate: 2000000, maxHeight: 720 };
    let cleanup;
    return source.download({ itemId: 'film', mode: 'original' }, host).then(result => {
        check(result.pick.variants.map(value => value.id).join(',') === 'theatrical,extended'
            && !calls.some(call => call.path === '/Items/film/PlaybackInfo'),
            'multiple editions ask before negotiating any file');
        return source.download({ itemId: 'film', mode: 'original', variantId: 'extended' }, host);
    }).then(plan => {
        check(parameters(plan.url).MediaSourceId === 'extended' && parameters(plan.url).Static === 'true'
            && plan.container === 'mkv' && plan.size === 1234567 && !plan.cleanup,
            'original copy identifies the chosen source and never creates an encoder');
        return source.download(Object.assign({}, args, { variantId: 'extended' }), host);
    }).then(plan => {
        const query = parameters(plan.url);
        check(plan.container === 'mp4' && plan.url.indexOf('/stream.mp4?') > 0 && query.Static === 'false'
            && query.StartTimeTicks === '0' && query.VideoCodec === 'h264' && query.AudioCodec === 'aac'
            && query.EnableAutoStreamCopy === 'false' && query.MaxHeight === '720'
            && Number(query.VideoBitRate) + Number(query.AudioBitRate) === 2000000,
            'transcoded copy is a complete beginning-to-EOF progressive encoded file within ceilings');
        check(query.MediaSourceId === 'extended' && query.DeviceId !== 'viewer' && query.PlaySessionId === 'offline-session'
            && plan.url.indexOf('secret') < 0 && plan.headers['X-Emby-Token'] === 'secret',
            'download owns a distinct device/session and authorization remains in headers');
        cleanup = plan.cleanup;
        return source.downloadRelease({ cleanup: cleanup }, host);
    }).then(() => {
        const last = calls[calls.length - 1];
        check(last.path === '/Videos/ActiveEncodings' && last.method === 'DELETE'
            && last.query.DeviceId === cleanup.deviceId && last.query.PlaySessionId === cleanup.playSessionId
            && !calls.some(call => call.path.indexOf('/Sessions/Playing') === 0),
            'release targets only the offline encoder and never reports or stops playback');
        hls = true;
        return fails(() => source.download(Object.assign({}, args, { variantId: 'extended' }), host),
            'download_transcode_unavailable');
    }).then(() => {
        hls = false;
        multipart = true;
        return fails(() => source.download({ itemId: 'film', mode: 'original', variantId: 'extended' }, host),
            'download_finite_file_unavailable');
    }).then(() => {
        multipart = false;
        return fails(() => source.download({ itemId: 'film', mode: 'original', variantId: 'missing' }, host),
            'selected_variant_unavailable');
    }).then(() => {
        policy.EnableContentDownloading = false;
        const before = calls.filter(call => call.path === '/Items/film/PlaybackInfo').length;
        return fails(() => source.download(Object.assign({}, args, { variantId: 'extended' }), host),
            'download_not_permitted').then(() => check(calls.filter(call => call.path === '/Items/film/PlaybackInfo').length === before,
                'denied downloads do not negotiate an encoder'));
    }).then(() => {
        policy.EnableContentDownloading = true;
        policy.EnableVideoPlaybackTranscoding = false;
        return fails(() => source.download(Object.assign({}, args, { variantId: 'extended' }), host),
            'download_transcode_not_permitted');
    }).then(() => {
        const messages = JSON.stringify(logs);
        check(messages.indexOf('secret') < 0 && messages.indexOf('https://') < 0 && logs.length > 0,
            'useful native download diagnostics contain neither tokens nor endpoint URLs');
    });
}
