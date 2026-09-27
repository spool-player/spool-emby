# Emby for Spool

The Emby provider for [Spool](https://github.com/spool-player/spool): sign in to an Emby server, browse
and search its libraries, play with the server's own transcoding when needed, keep watched state and
resume points in sync, skip intros and credits Emby has marked, and let other Emby clients control
Spool.

| | |
| --- | --- |
| `manifest.json` | Identity, capabilities, screens and item actions (provider API 0.2) |
| `logic/provider.mjs` | Sign-in, catalogue, playback, item actions |
| `logic/items.mjs` | Emby JSON to Spool's item shape; intro and credit chapters to segments |
| `logic/profile.mjs` | The DeviceProfile sent with every playback request |
| `logic/events.mjs` | The server's websocket, as remote-control and change events |
| `ui/Login.qml` | Servers found on the network or typed in, then a user and password |
| `ui/Picker.qml` | Choosing a playlist or collection, renaming, confirming a delete |

Several users and several servers can be signed in at once. Users of the same server are alternatives
to each other in Spool; different servers are shown together. Emby Connect and watching together are
not supported.

Inherited thumbnails and backdrops preserve the parent image's item ID as well
as its tag. This needs Spool's `thumbItemId`/`backdropItemId` artwork contract;
home rails must not request a series or season image under an episode ID.

## Playback and automatic quality

Playback is negotiated through Emby's authenticated `/emby/Items/{id}/PlaybackInfo` API, with the
selected media-source ID preserved. Video and audio use their own stream endpoints. Remuxing uses
the server's negotiated URL, never an unbounded static-file fallback; forced transcoding disables
video copying. The device profile includes the viewer's codec and resolution restrictions.
Embedded subtitles are supported; external subtitle tracks are rendered into the video by Emby
because Spool's provider API does not deliver separate subtitle URLs.

The bitrate ceiling is chosen in this order:

1. An explicit quality selected in the player.
2. The unlimited-local-network preference, **only** when Emby's `/System/Endpoint` positively
   identifies the connection as local or in-network (represented by a 1 Gbps ceiling).
3. The standing bitrate preference.
4. This account's measured conservative bitrate.
5. 120 Mbps before a successful measurement.

The explicit height limit wins over the standing height preference. Neither unlimited LAN nor
remux preference removes height or codec restrictions. An unavailable LAN classification keeps
the ordinary preference/measured ceiling rather than guessing from the server's address.

The provider implements `speedTest` with Spool's native `host.speedTest` and Emby's documented
authenticated [`GET /Playback/BitrateTest?Size=…`](https://dev.emby.media/reference/RestAPI/MediaInfoService/getPlaybackBitratetest.html).
A nonce prevents cache reuse. Native code verifies that each response contains exactly the requested
bytes, measures one/two/four concurrent downloads, and reserves throughput headroom; binary probe
bodies never pass through JavaScript. Servers or proxies that deny this endpoint or alter the
payload fail the probe, leaving the existing preference/measurement unchanged.

Start, progress and stop reports preserve Emby's play session, media source and subtitle-off state.
Stopping also releases the session's encoder and any live source opened by playback negotiation.
Intro/credit skipping depends on chapters actually supplied by the server. Server permissions
still govern transcoding, collection/playlist edits and deletion.

Protocol references:
[`PlaybackInfoRequest`](https://github.com/MediaBrowser/Emby.ApiClients/blob/master/Clients/JavaScript/src/model/PlaybackInfoRequest.js),
[`MediaSourceInfo`](https://github.com/MediaBrowser/Emby.ApiClients/blob/master/Clients/JavaScript/src/model/MediaSourceInfo.js),
and Emby's [official JavaScript client](https://github.com/MediaBrowser/Emby.ApiClient.Javascript/blob/master/apiclient.js).

The provider owns both QML screens. Login supports discovered servers, HTTP(S) reverse-proxy paths,
IPv6 addresses, public profiles and manual usernames. Credentials are kept in the account configuration,
never in artwork or probe URLs. Emby Connect is not needed for direct server sign-in.

## Development

The SDK under `sdk/` is pinned from Spool (`sdk.lock.json`; `tools/check-sdk.py` verifies it).

```
python3 tools/check-sdk.py
cmake -S sdk -B build/sdk -G Ninja && cmake --build build/sdk
timeout 20s build/sdk/provider-contract-runner tests/contract.mjs
QV4_FORCE_INTERPRETER=1 timeout 20s build/sdk/provider-contract-runner tests/contract.mjs
python3 sdk/spool-provider.py build .          # dist/spool.emby-<version>.tar.zst
python3 sdk/spool-provider.py validate dist/*.tar.zst
```

To try a checkout in Spool without releasing it, configure Spool with
`-DSPOOL_PROVIDER_OVERRIDES=spool.emby=/path/to/spool-emby`.

Requires Python 3, CMake, Ninja, Qt 6 Core/Qml development packages and `zstd`.
The contract uses synthetic server responses to cover account isolation, catalogue paging,
selected editions, quality precedence/boundaries, remux safety, audio routing and session cleanup.
It does not replace a smoke run against an authorized Emby server or an offscreen Spool check of the QML screens.

## Releasing

Keep the SDK pin current, bump `version` in `manifest.json`, then push a matching `v<version>` tag.
For the initial `0.1.0` release, after validation:

```sh
git push -u origin main
git tag v0.1.0
git push origin v0.1.0
```

`.github/workflows/release.yml` runs both Qt contract modes, verifies the SDK, builds and validates
the archive, and attaches `spool.emby-<version>.tar.zst` plus `spool-provider.json` to a GitHub release
with build provenance. It rejects tags that disagree with the manifest version.
The optional `STORE_DISPATCH_TOKEN` secret asks `spool-player/spool-providers` to refresh immediately;
without it, the store relies on its scheduled refresh. Release publication needs Actions enabled and
the workflow's `contents: write`, `id-token: write`, and `attestations: write` permissions.

MPL-2.0; see LICENSE and NOTICE.
