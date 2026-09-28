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
| `logic/settings.mjs` | Optional native preferences and application-owned DisplayPreferences documents |
| `logic/remote.mjs` | Negotiated outbound session control and occurrence-aware remote queues |
| `logic/connect.mjs`, `logic/connect-flow.mjs` | Emby Connect transport and transient login-screen state |
| `ui/Login.qml` | Network/manual server and password sign-in, or Emby Connect PIN and membership selection |
| `ui/Picker.qml` | Choosing a playlist or collection, renaming, confirming a delete |
| `ui/RemoteControls.qml` | Capability-gated navigation, text and service controls for the selected peer |

Several users and several servers can be signed in at once. Users of the same server are alternatives
to each other in Spool; different servers are shown together. Watching together is not supported.

### Emby Connect

Choose **Sign in with Emby Connect**, open `emby.media/pin` on another device,
and enter the displayed code. Polling is serial, two seconds after each pending
response. Expired codes stop polling; **Get a new code** retries, and **Back to
server sign-in** cancels without adding an account. Closing the screen or replacing
the code invalidates outstanding results.

After approval, choose a server membership and its local or remote connection.
Only that chosen connection is submitted for origin approval; listing memberships
does not probe or grant every advertised address. The server's public identity
must match the membership before its AccessKey is sent for exchange.

The only declared cloud origin is `https://connect.emby.media`. PIN creation and
authentication use form data with the client device ID and `X-Application`;
membership retrieval uses `X-Connect-UserToken`. That cloud token never reaches a
media server. The selected membership AccessKey is exchanged at
`/emby/Connect/Exchange?format=json&ConnectUserId=...` using `X-Emby-Token` and
the ordinary client authorization header. The resulting local user/token becomes
a normal server account. No PIN, cloud token, membership AccessKey or Connect user
ID is saved. If that local credential expires, use normal server sign-in or repeat
Connect linking.

The login screen owns transient PIN/membership state across draft-source recreation
when an origin is approved. This is a baseline API 0.2 custom-operation flow and
does not require an activation extension or new host authentication API.
Stateful contracts cover cloud/local credential separation, source recreation,
selected-origin exchange, identity mismatch, stale/cancelled polls and expiry.
Protocol references: [Connect membership and exchange](https://raw.githubusercontent.com/MediaBrowser/Emby.SDK/master/Documentation/doc/restapi/Emby-Connect.html)
and [official Roku PIN flow](https://raw.githubusercontent.com/MediaBrowser/Emby.Roku/master/source/EmbyConnectScreen.brs).
Live Connect/server behavior requires separate authorized service verification.

Optional features use exact version-one declarations: `spool.artwork-owners` for
inherited thumbnail/backdrop ownership and `spool.speed-test` for native throughput
probes. API 0.2 hosts without these extensions retain baseline login, browsing,
playback and reporting. They receive own images and baseline series/album poster
fallbacks, but no inherited thumbnail/backdrop tags that could target the wrong ID.
Speed testing is no longer a legacy capability. Login, settings and item pickers
use baseline `extensionStatus` to show “Update Spool to use all features of this
provider.” only when host support is missing, not for server permission failures.

Playlist rows also preserve `PlaylistItemId` as an opaque `entryId`, so repeated
occurrences of the same media item remain distinguishable.

Version-one `spool.suggestions`, `spool.item-actions`,
`spool.collection-editing` and `spool.playback-queue-reporting` add bounded
suggestions, permission-aware menus, occurrence-aware editing and native queue
reports. Search runs dedicated Series and expanded mixed-type queries concurrently,
prioritizes Series, deduplicates and returns a complete bounded top-N result.
Suggestions use the favorite/liked-plus-random video query, capped at 60, rather
than Continue Watching.

User policy is fetched lazily and invalidated after authorization failures,
user-change notifications and reconnects. `CanEditItems`/`CanDelete` denials are
respected; missing rights never imply administrator access. Baseline item actions
enforce the same checks. Playlist removal/movement addresses the opaque entry
identity (including numeric server IDs); collection membership can be removed but
not reordered. Start/progress reports reuse a source-owned immutable queue
snapshot and preserve duplicate media occurrences; stop/cleanup behavior remains
unchanged. These operations do not modify user preferences.

`spool.remote-targets` adds outbound control independently of inbound remote
commands. It requests `/emby/Sessions?ControllableByUserId=...`, filters documented
`SupportsRemoteControl` and flat `SupportedCommands`, excludes this installation,
and reads the exact selected session with `Id`. It does not assume Jellyfin's
nested capability shape or embedded queue: remote queues come from
`/emby/Sessions/PlayQueue?Id=...` and are paged from a bounded snapshot.
Numeric and string `PlaylistItemId` values preserve duplicate occurrences.

Selecting a device only reads state. Unknown volume/duration remain absent,
`CanSeek` and known playlist boundaries constrain transport, subtitle Off sends
native index `-1`, and exact decimal tick values never pass through a JavaScript
number. No queue revision or command acknowledgement is fabricated.

Remote queue edits **restart playback**, not in-place mutation. Surviving current
occurrences retain position; removing the current occurrence selects the nearest
surviving successor at zero, and an empty queue sends Stop. Paused state is
restored only after the new queue/current occurrence and position are confirmed.
Uncertain mutations are not blindly retried. The provider picker exposes only
advertised navigation, text and service-specific controls. Emby remote previews
are not advertised.

Protocol references: [sessions](https://dev.emby.media/reference/RestAPI/SessionsService/getSessions.html),
[play queue](https://dev.emby.media/reference/RestAPI/SessionsService/getSessionsPlayqueue.html),
[play](https://dev.emby.media/reference/RestAPI/SessionsService/postSessionsByIdPlaying.html)
and [playstate](https://dev.emby.media/reference/RestAPI/SessionsService/postSessionsByIdPlayingByCommand.html).
Fixtures and loopback exercises do not establish live-client support; the
peer's actual capabilities and server authorization remain authoritative.

`spool.playback-preferences` exposes the signed-in user's audio/subtitle languages,
Default/Smart audio mode and Default/Smart/OnlyForced/Always/None subtitle mode.
Writes freshly fetch the full user `Configuration` and `Policy`, honor
`EnableUserPreferenceAccess`, and merge only the four mapped fields before posting
`/emby/Users/{id}/Configuration`. Unrelated settings and policy are preserved;
administrator policy is never written. Unknown/missing enum values (including
Emby's service-specific HearingImpaired mode) remain read-only in this normalized
contract. Spool handles two-letter language normalization.

`spool.settings-storage` stores arbitrary application JSON in
`CustomPrefs["spool.data.v1"]`, with one canonical lowercase UUID DisplayPreferences
record per document and signed-in user under client `Spool`. GET uses `UserId` and
`Client`; POST uses `UserId` and keeps `Client` in the complete DTO. Writes/deletes
preserve every unrelated DTO and CustomPrefs field. JSON null is present data,
distinct from absence. Documents are limited to 64 KiB UTF-8 and 16 container
levels. Malformed, oversized or too-deep stored documents are never automatically
overwritten or deleted. DisplayPreferences is replacement-only:
`conditionalWrites:false` rejects any revision condition before HTTP, not a
pretend compare-and-swap. Backend unavailability and permission errors do not
become authentication failures or host-update notices.

Protocol references: Emby's [user configuration](https://dev.emby.media/reference/RestAPI/UserService/postUsersByIdConfiguration.html),
[DisplayPreferences GET](https://dev.emby.media/reference/RestAPI/DisplayPreferencesService/getDisplaypreferencesById.html)
and [DisplayPreferences POST](https://dev.emby.media/reference/RestAPI/DisplayPreferencesService/postDisplaypreferencesByDisplaypreferencesid.html).
Stateful fixtures cover unrelated-field preservation, account/document isolation,
all normalized enum modes, policy denial, null/absence, conditional rejection,
and document size/depth/corruption boundaries.

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
Playback negotiation, reports and resume writes encode decimal tick positions as
exact signed 64-bit JSON numbers, without a floating-point conversion. Malformed
or out-of-range positions fail before sending a request.
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
Bare DNS addresses try HTTPS first, then HTTP on port 8096 and the default HTTP
port. Private literals and localhost try HTTP 8096 first. Supplied ports and proxy
paths are preserved; an explicit scheme selects only that address and HTTPS is
never silently downgraded. Each attempted origin is approved before probing it.
UDP replies use the sender in place of a different advertised literal IP, while
DNS names, schemes, ports and base paths remain intact.

Hosts negotiating `spool.lan-probe` version 1 also offer **Search local network**
in login. Only an explicit viewer request followed by Spool's host-owned consent
starts probing `/emby/System/Info/Public` on port 8096, in bounded pages of at most
32 targets. Public information is validated (Jellyfin responses are excluded),
and IDs are deduplicated across pages and UDP replies. Login shows progress and
supports Cancel/Back; closing login cancels the search. No authenticated origin
is granted by discovery. Selecting a result still uses normal origin approval.
Older hosts hide this control and retain UDP/manual login. The subnet search
never runs at app launch or in the background.

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
