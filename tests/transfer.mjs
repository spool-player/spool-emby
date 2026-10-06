// SPDX-License-Identifier: MPL-2.0
// Real HTTP/encoding fixture, not a live Emby-server certification.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createSource } from '../logic/provider.mjs';

const directory = await mkdtemp(join(tmpdir(), 'spool-emby-transfer-'));
const input = join(directory, 'original.mp4');
const output = join(directory, 'offline.mp4');
let releases = 0;
let encoder;
const media = { Id: 'edition', Protocol: 'File', Container: 'mp4', MediaStreams: [{ Type: 'Video', Codec: 'h264', Height: 240 }] };
const server = createServer(async (request, response) => {
    try {
        assert.equal(request.headers['x-emby-token'], 'fixture-token');
        const url = new URL(request.url, 'http://localhost');
        const json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
        if (url.pathname === '/emby/Users/u')
            return json({ Id: 'u', Policy: { EnableContentDownloading: true, EnableVideoPlaybackTranscoding: true,
                EnableAudioPlaybackTranscoding: true, EnableSyncTranscoding: true } });
        if (url.pathname === '/emby/Users/u/Items/film')
            return json({ Id: 'film', MediaType: 'Video', MediaSources: [media] });
        if (url.pathname === '/emby/Items/film/PlaybackInfo') {
            let body = '';
            for await (const chunk of request) body += chunk;
            const args = JSON.parse(body);
            assert.equal(args.DeviceProfile.TranscodingProfiles[0].Protocol, 'http');
            return json({ PlaySessionId: 'offline', MediaSources: [{ ...media, SupportsTranscoding: true,
                TranscodingContainer: 'mp4', TranscodingSubProtocol: 'http',
                TranscodingUrl: '/Videos/film/stream.mp4?VideoCodec=h264&AudioCodec=aac' }] });
        }
        if (url.pathname === '/emby/Videos/film/stream') {
            assert.equal(url.searchParams.get('Static'), 'true');
            assert.equal(url.searchParams.get('MediaSourceId'), 'edition');
            return createReadStream(input).pipe(response);
        }
        if (url.pathname === '/emby/Videos/film/stream.mp4') {
            assert.equal(url.searchParams.get('Static'), 'false');
            assert.equal(url.searchParams.get('EnableAutoStreamCopy'), 'false');
            assert.equal(url.searchParams.get('StartTimeTicks'), '0');
            assert.notEqual(url.searchParams.get('DeviceId'), 'viewer');
            response.setHeader('Content-Type', 'video/mp4');
            encoder = spawn('ffmpeg', ['-v', 'error', '-i', input, '-vf', 'scale=-2:' + url.searchParams.get('MaxHeight'),
                '-c:v', 'libx264', '-b:v', url.searchParams.get('VideoBitRate'), '-c:a', 'aac',
                '-b:a', url.searchParams.get('AudioBitRate'), '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1']);
            encoder.stderr.resume();
            encoder.stdout.pipe(response, { end: false });
            encoder.on('close', code => { if (code === 0) response.end(); else response.destroy(new Error('encoding failed')); });
            return;
        }
        if (url.pathname === '/emby/Videos/ActiveEncodings') {
            assert.equal(request.method, 'DELETE');
            assert.equal(url.searchParams.get('PlaySessionId'), 'offline');
            assert.match(url.searchParams.get('DeviceId'), /^viewer-download-/);
            ++releases;
            return json({});
        }
        response.writeHead(404).end();
    } catch (error) { response.destroy(error); }
});
try {
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=12',
        '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-y', input]);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const host = { device: { id: 'viewer' }, log: () => {}, isLogEnabled: () => false,
        http: async (url, options) => {
            const response = await fetch(url, { ...options, body: options.body || undefined });
            return { status: response.status, body: await response.text() };
        } };
    const source = createSource({ server: origin, userId: 'u', token: 'fixture-token' }, host);
    const original = await source.download({ itemId: 'film', mode: 'original' }, host);
    const originalResponse = await fetch(original.url, { headers: original.headers });
    assert.equal(originalResponse.status, 200);
    assert.deepEqual(Buffer.from(await originalResponse.arrayBuffer()), await readFile(input));
    const plan = await source.download({ itemId: 'film', mode: 'transcoded', maxBitrate: 500000, maxHeight: 120 }, host);
    const response = await fetch(plan.url, { headers: plan.headers });
    assert.equal(response.status, 200);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(output));
    const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output]));
    assert.equal(info.streams.find(stream => stream.codec_type === 'video').codec_name, 'h264');
    assert.equal(info.streams.find(stream => stream.codec_type === 'video').height, 120);
    assert.ok(Number(info.format.duration) >= 2);
    await source.downloadRelease({ cleanup: plan.cleanup }, host);
    assert.equal(releases, 1);
    console.log('Emby finite HTTP fixture transfer passed: exact original, progressive encoded MP4, EOF, height, cleanup');
} finally {
    encoder?.kill();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
}
