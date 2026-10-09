# Emby for Spool

The Emby provider for [Spool](https://github.com/spool-player/spool): sign in to an Emby server, browse
and search its libraries, play with the server's own transcoding when needed, keep watched state and
resume points in sync, skip intros and credits Emby has marked, and let other Emby clients control
Spool.

| | |
| --- | --- |
| `manifest.json` | Identity, capabilities, screens and item actions (package format 3) |
| `logic/provider.mjs` | Sign-in, catalogue, playback, item actions |
| `logic/items.mjs` | Emby JSON to Spool's item shape; intro and credit chapters to segments |
| `logic/profile.mjs` | The DeviceProfile sent with every playback request |
| `logic/events.mjs` | The server's websocket, as remote-control and change events |
| `logic/settings.mjs` | Optional native preferences and application-owned DisplayPreferences documents |
| `logic/remote.mjs` | Negotiated outbound session control and occurrence-aware remote queues |
| `logic/connect.mjs`, `logic/connect-flow.mjs` | Emby Connect transport and transient login-screen state |
| `ui/Login.qml` | Emby Connect adapter and service labels for Spool's compiled login/linking surfaces |
| `ui/Picker.qml` | Service command mappings for compiled item pickers and device controls |
| `ui/Settings.qml` | Signed-in server user's native audio/subtitle preferences |

Several users and several servers can be signed in at once. Users of the same server are alternatives
to each other in Spool; different servers are shown together. Watching together is not supported.

### Seek previews

Playback results expose available seek thumbnails as `{format: 'bif', url, headers}`.
Discovery uses Emby's authenticated
[`/Items/{Id}/ThumbnailSet?Width=320`](https://dev.emby.media/reference/RestAPI/BifService/getItemsByIdThumbnailset.html);
nonempty thumbnail sets use the whole
[`/Videos/{Id}/index.bif?Width=320`](https://dev.emby.media/reference/RestAPI/BifService/getVideosByIdIndexBif.html)
sequence. Spool decodes its timestamps and images natively and caches the sequence
for subsequent seeks. Empty sets, unsupported endpoints or failed preview loads
leave previews unavailable without interrupting playback.

The device-local **Seek previews** preference is passed as `videoPreviews`.
When false, local and remote operations omit descriptors and make no
`ThumbnailSet` requests, including after a cached enabled remote session.
Ordinary item details, playback tracks and chapter markers remain available.

These documented endpoints select an **item**, not a `MediaSourceId`. Previews
are offered only when the known playing source ID identifies that item, or item
metadata has one source matching the selected ID. Unknown source IDs, mismatched
item metadata and ambiguous alternate editions do not borrow another index. BIF
URLs stay on the configured server and contain no token; `X-Emby-Token` remains
in account-scoped request headers.

### Offline downloads

Original downloads select an exact finite local `File` media source using
`/Videos/{Id}/stream?Static=true&MediaSourceId=…` (or `/Audio/` for audio).
Multiple editions open the provider-owned **Choose version** picker; selecting
a version returns only its ID, preserving native mode and quality choices.
Missing editions, multipart items, live/openable sources and disc images are
rejected rather than silently saving a partial or different edition.

Server-transcoded downloads negotiate a separate HTTP MP4/H.264/AAC
`DeviceProfile` through `PlaybackInfo`, with direct playback/stream-copy
disabled and the chosen bitrate/height ceilings. The accepted result must be a
same-origin [`/Videos/{Id}/stream.mp4`](https://dev.emby.media/reference/RestAPI/VideoService/getVideosByIdStreamByContainer.html)
HTTP progressive endpoint, never playback HLS or DASH. Transfer starts at zero,
finishes at EOF and keeps the account token in request headers. An unavailable
progressive profile fails explicitly; no playlist-to-file fallback is used.
Audio originals are supported, but this video encoding profile does not offer
audio-only conversion.

Every request rechecks `EnableContentDownloading` and item download denial.
Conversion also requires video/audio transcoding permission and respects
explicit `EnableSyncTranscoding: false`. The server still enforces its own
licensing, concurrency and access rules. Download devices/sessions are separate
from playback: `downloadRelease` deletes only the generated encoder matching
both device ID and play-session ID on success, failure or cancellation, without
playback reports or watched-state changes.

Native host diagnostics report profile negotiation, protocol/permission
outcomes and local/remote preview availability. Trace fields use native
`isLogEnabled` guards; messages never include media URLs, credentials,
filesystem paths or raw server responses.

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
when an origin is approved. This is a baseline current format-3 custom-operation flow and
does not require an accountActivation capability or new host authentication API.
Stateful contracts cover cloud/local credential separation, source recreation,
selected-origin exchange, identity mismatch, stale/cancelled polls and expiry.
Protocol references: [Connect membership and exchange](https://raw.githubusercontent.com/MediaBrowser/Emby.SDK/master/Documentation/doc/restapi/Emby-Connect.html)
and [official Roku PIN flow](https://raw.githubusercontent.com/MediaBrowser/Emby.Roku/master/source/EmbyConnectScreen.brs).
Live Connect/server behavior requires separate authorized service verification.

Optional features use exact boolean declarations: `artworkOwners` for
inherited thumbnail/backdrop ownership and `speedTest` for native throughput
probes. Feature availability comes from exact host/account negotiation, not the
application version. Without owner support, own images and ordinary series/album
poster fallbacks remain available, but inherited child tags are omitted. Current
provider builds require the current Spool host contract, including native logging;
older hosts are not supported.

Playlist rows also preserve `PlaylistItemId` as an opaque `entryId`, so repeated
occurrences of the same media item remain distinguishable.

Version-one `suggestions`, `itemActions`,
`collectionEditing` and `playbackQueueReporting` add bounded
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

`remoteTargets` adds outbound control independently of inbound remote
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
advertised navigation, text and service-specific controls. Remote previews use
the same item-scoped BIF discovery and version restrictions as local playback,
without changing local playback or transmitting account credentials to the peer.

Protocol references: [sessions](https://dev.emby.media/reference/RestAPI/SessionsService/getSessions.html),
[play queue](https://dev.emby.media/reference/RestAPI/SessionsService/getSessionsPlayqueue.html),
[play](https://dev.emby.media/reference/RestAPI/SessionsService/postSessionsByIdPlaying.html)
and [playstate](https://dev.emby.media/reference/RestAPI/SessionsService/postSessionsByIdPlayingByCommand.html).
Fixtures and loopback exercises do not establish live-client support; the
peer's actual capabilities and server authorization remain authoritative.

`playbackPreferences` exposes the signed-in user's audio/subtitle languages,
Default/Smart audio mode and Default/Smart/OnlyForced/Always/None subtitle mode.
Writes freshly fetch the full user `Configuration` and `Policy`, honor
`EnableUserPreferenceAccess`, and merge only the four mapped fields before posting
`/emby/Users/{id}/Configuration`. Unrelated settings and policy are preserved;
administrator policy is never written. Unknown/missing enum values (including
Emby's service-specific HearingImpaired mode) remain read-only in this normalized
contract. Spool handles two-letter language normalization.

The provider settings screen edits these server-user preferences, not Spool's
device-local playback or appearance settings. Changes affect this signed-in
user on this Emby server and can affect other Emby clients. It saves only edited
fields after server acceptance, retains drafts on failures, and shows policy-
restricted or unsupported fields as read-only. Language inputs accept empty
values or lowercase ISO-639-2 codes such as `eng`; unknown server modes are not
replaced. Closing the screen uses the host's context cancellation.

`settingsStorage` stores arbitrary application JSON in
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

The provider's thin QML adapters use Spool's precompiled login, linking, picker and
device-control surfaces; they require the matching host build. Emby Connect and
the server-user preferences screen remain service-specific. Playback/appearance
settings local to this device live in Spool. Login supports discovered servers,
HTTP(S) reverse-proxy paths, IPv6 addresses, public profiles and manual usernames.
Credentials are kept in the account configuration, never in artwork or probe
URLs. Emby Connect is not needed for direct server sign-in.
Bare DNS addresses try HTTPS first, then HTTP on port 8096 and the default HTTP
port. Private literals and localhost try HTTP 8096 first. Supplied ports and proxy
paths are preserved; an explicit scheme selects only that address and HTTPS is
never silently downgraded. Each attempted origin is approved before probing it.
UDP replies use the sender in place of a different advertised literal IP, while
DNS names, schemes, ports and base paths remain intact.

Hosts negotiating `lanProbe` version 1 also offer **Search local network**
in login. Only an explicit viewer request followed by Spool's host-owned consent
starts probing `/emby/System/Info/Public` on port 8096, in bounded pages of at most
32 targets. Public information is validated (Jellyfin responses are excluded),
and IDs are deduplicated across pages and UDP replies. Login shows progress and
supports Cancel/Back; closing login cancels the search. No authenticated origin
is granted by discovery. Selecting a result still uses normal origin approval.
When LAN probing is unavailable, UDP/manual login remains available. The subnet
search never runs at app launch or in the background.

## Development

The SDK under `sdk/` is pinned from Spool (`sdk.lock.json`; `tools/check-sdk.py` verifies it).

```
python3 tools/check-sdk.py
cmake -S sdk -B build/sdk -G Ninja && cmake --build build/sdk
timeout 20s build/sdk/provider-contract-runner tests/contract.mjs
QV4_FORCE_INTERPRETER=1 timeout 20s build/sdk/provider-contract-runner tests/contract.mjs
VERSION=$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')
python3 sdk/spool-provider.py build . --output "dist/spool.emby-$VERSION.szo"
python3 sdk/spool-provider.py validate "dist/spool.emby-$VERSION.szo"
```

Future packages use `.szo` (Spool Zstandard Object): the same format-3 zstd USTAR
bytes, selected with the pinned SDK's existing `--output` option. SDK revision
`6185eaa895f2df9b9fcb56c39a1eae35447595b5` and its locked files are unchanged.
Published package names, release/feed URLs and SHA pins remain immutable.

To try a checkout in Spool without releasing it, configure Spool with
`-DSPOOL_PROVIDER_OVERRIDES=spool.emby=/path/to/spool-emby`.

Requires Python 3, CMake, Ninja, Qt 6 Core/Qml development packages and `zstd`.
The contract uses synthetic server responses to cover account isolation, catalogue paging,
selected editions, quality precedence/boundaries, remux safety, audio routing and session cleanup.
It does not replace a smoke run against an authorized Emby server or an offscreen Spool check of the QML screens.

The optional `node tests/transfer.mjs` smoke requires Node.js and FFmpeg/ffprobe.
It uses a local Emby-shaped HTTP fixture with actual server-side encoding,
streams the progressive MP4 to disk, checks media duration/height and cleanup,
and compares original bytes. This is network/transfer proof, not certification
against an authorized real Emby server.

## Releasing

Next-UX source version: **0.1.8**, adding the signed-in server-user preferences
screen and `.szo` names for future package artifacts. This source work does not
publish a release, tag or feed entry, or replace canonical packages.

Keep the SDK pin current, bump `version` in `manifest.json`, then push a matching `v<version>` tag.
After validation, use the version in the current manifest:

```sh
git push -u origin main
VERSION=$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')
git tag "v$VERSION"
git push origin "v$VERSION"
```

`.github/workflows/release.yml` runs both Qt contract modes, verifies the SDK, builds and validates
the archive, and attaches `spool.emby-<version>.szo` plus `spool-provider.json` to a GitHub release
with build provenance. It rejects tags that disagree with the manifest version.
The optional `STORE_DISPATCH_TOKEN` secret asks `spool-player/spool-providers` to refresh immediately;
without it, the store relies on its scheduled refresh. Release publication needs Actions enabled and
the workflow's `contents: write`, `id-token: write`, and `attestations: write` permissions.

MPL-2.0; see LICENSE and NOTICE.

## Service icon

The Emby logo belongs to Emby. Its team permits using the logo to identify connections to Emby servers: https://emby.media/community/topic/50879-logo-usage-guidelines/. The icon identifies the connected service; this is an independent Spool integration, not an official Emby client. See [asset attribution](assets/BRANDING.md).
