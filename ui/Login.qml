// SPDX-License-Identifier: MPL-2.0
import QtQuick
import QtQuick.Layouts
import Spool
import "../logic/connect-flow.mjs" as ConnectFlow

// Server/password and optional Emby Connect both produce ordinary local accounts.
FocusScope {
    id: root

    property var provider
    property bool validAddress: false
    property int validationGeneration: 0
    function validateAddress(input) {
        const generation = ++validationGeneration
        validAddress = false
        if (!String(input).trim() || !provider || provider.closed)
            return
        provider.request("serverCandidates", {
                             server: input
                         }).then(result => {
                             if (generation === validationGeneration)
                                 validAddress = result.servers && result.servers.length > 0
                         }, () => {})
    }
    property string step: "server"
    property var servers: []
    property bool busy: false
    property string error: ""
    property var server: ({})
    property int generation: 0
    property bool lanAvailable: false
    property bool lanSearching: false
    property int lanGeneration: 0
    property string lanStatus: ""
    property var connectFlow: null
    property var connectState: ({
                                    phase: "idle",
                                    pin: "",
                                    memberships: [],
                                    busy: false
                                })
    property var connectTimerCallback: null

    function startConnect() {
        cancelLocalSearch();
        ++generation
        error = ""
        step = "connect"
        if (!connectFlow) {
            connectFlow = ConnectFlow.createConnectFlow({
                                                            request: (operation, args) => provider.request(operation,
                                                                                                           args),
                                                            approve: address => provider.allowOrigin(address),
                                                            closed: () => !provider || provider.closed,
                                                            complete: account => provider.complete(account),
                                                            stopTimer: () => {
                                                                connectTimer.stop()
                                                                connectTimerCallback = null
                                                            },
                                                            schedule: (callback, milliseconds) => {
                                                                connectTimerCallback = callback
                                                                connectTimer.interval = milliseconds
                                                                connectTimer.restart()
                                                            },
                                                            changed: state => {
                                                                connectState = state
                                                                busy = state.busy
                                                                error = state.error ? (messages[state.error]
                                                                                       || "Emby Connect couldn't be reached. Try again or use server sign-in.") :
                                                                                      ""
                                                                if (state.phase === "pin" || state.phase === "error")
                                                                    Qt.callLater(() => InputKeys.focus(connectRetry))
                                                                else if (state.phase === "members")
                                                                    Qt.callLater(() => InputKeys.focus(connectBack))
                                                            }
                                                        })
        }
        connectFlow.start()
    }

    function cancelConnect() {
        if (connectFlow)
            connectFlow.cancel()
        connectState = {
            phase: "idle",
            pin: "",
            memberships: [],
            busy: false
        }
    }

    Timer {
        id: connectTimer
        repeat: false
        onTriggered: {
            const callback = root.connectTimerCallback
            root.connectTimerCallback = null
            if (callback)
                callback()
        }
    }

    function mergeServers(found) {
        const merged = servers.slice()
        const ids = new Set(merged.map(entry => entry.id))
        for (const entry of found) {
            if (!ids.has(entry.id)) {
                ids.add(entry.id)
                merged.push(entry)
            }
        }
        servers = merged
    }

    function cancelLocalSearch() {
        if (!lanSearching)
            return
        ++lanGeneration
        lanSearching = false
        lanStatus = "Search cancelled"
        if (provider && !provider.closed)
            provider.cancelLanDiscovery()
    }

    function searchLocalNetwork() {
        if (lanSearching || busy || step !== "server")
            return
        const request = ++lanGeneration
        lanSearching = true
        lanStatus = "Searching local network…"
        error = ""
        let pages = 0
        const cursors = new Set()
        function next(cursor) {
            if (request !== lanGeneration || provider.closed)
                return Promise.resolve()
            lanStatus = "Searching local network…"
            return provider.request("discoverMore", cursor ? {
                                                                 "cursor": cursor
                                                             } : {}).then(result => {
                                                                 if (request !== lanGeneration || provider.closed)
                                                                     return
                                                                 ++pages
                                                                 mergeServers(result.servers || [])
                                                                 lanStatus = servers.length + " servers found"
                                                                 if (result.exhausted === true) {
                                                                     lanSearching = false
                                                                     return
                                                                 }
                                                                 if (typeof result.cursor !== "string" ||
                                                                         !result.cursor || cursors.has(result.cursor)
                                                                         || pages >= 512)
                                                                     throw "invalid_pagination"
                                                                 cursors.add(result.cursor)
                                                                 return next(result.cursor)
                                                             })
        }
        provider.request("discover").then(result => {
            if (generation === lanGeneration && !provider.closed)
                mergeServers(result.servers || [])
        }, () => {}).then(() => {
            if (generation !== lanGeneration || provider.closed)
                return
            if (!lanAvailable) {
                lanSearching = false
                lanStatus = servers.length + " servers found"
                return
            }
            lanStatus = "Waiting for local network permission"
            return provider.allowLanDiscovery().then(() => next(null))
        }).catch(code => {
            if (request !== lanGeneration || provider.closed)
                return
            cancelLocalSearch()
            lanStatus = code === "cancelled" || code === "discovery_denied"
                    ? "Local search was not allowed. Use a discovered server or enter an address." :
                      "Local search failed. You can retry or enter a server address."
        })
    }

    readonly property var messages: ({
                                         "http_401": "Wrong username or password",
                                         "invalid_credentials": "Wrong username or password",
                                         "not_emby": "Not an Emby server",
                                         "invalid_server": "Enter a valid HTTP or HTTPS server address",
                                         "origin_denied": "Not a server address",
                                         "connect_expired": "This code has expired. Get a new code to try again.",
                                         "connect_server_mismatch":
                                         "This address belongs to a different server. No account was added.",
                                         "connect_unavailable":
                                         "Emby Connect or the selected server couldn't be reached. Try again.",
                                         "invalid_connect_response":
                                         "Emby Connect or the selected server returned an invalid sign-in response."
                                     })

    function fail(code) {
        busy = false
        error = messages[code] || "Couldn't reach the server"
    }

    function connect(input) {
        if (busy || String(input).trim().length === 0)
            return
        cancelLocalSearch()
        const request = ++generation
        busy = true
        error = ""
        // Each fallback gets its own origin approval, before any HTTP request.
        // Explicit HTTPS produces only one candidate and never downgrades.
        function attempt(candidates, index) {
            if (request !== generation)
                return Promise.reject("cancelled")
            const address = candidates[index]
            return provider.allowOrigin(address).then(() => {
                if (request !== generation)
                    return Promise.reject("cancelled")
                return provider.request("probe", {
                                            "server": address
                                        }).then(result => result, code => {
                                            if (request !== generation || code === "cancelled" || code
                                                    === "origin_denied" || index + 1 >= candidates.length)
                                                return Promise.reject(code)
                                            return attempt(candidates, index + 1)
                                        })
            })
        }
        provider.request("serverCandidates", {
                             "server": input
                         }).then(result => attempt(result.servers, 0)).then(result => {
                             if (request !== generation)
                                 return
                             busy = false
                             server = result
                             usernameField.text = ""
                             passwordField.text = ""
                             step = "account"
                             Qt.callLater(() => userProfiles.count > 0 ? InputKeys.focus(userProfiles.itemAt(0)) :
                                                                         usernameField.focusRow())
                         }, code => {
                             if (request === generation)
                                 fail(code)
                         })
    }

    function signIn(name, password) {
        if (busy || !String(name).trim())
            return
        const request = ++generation
        busy = true
        error = ""
        provider.request("authenticate", {
                             "server": server.server,
                             "username": String(name).trim(),
                             "password": password
                         }).then(account => {
                             if (request === generation) {
                                 passwordField.text = ""
                                 provider.complete(account)
                             }
                         }, code => {
                             if (request === generation)
                                 fail(code)
                         })
    }

    function back() {
        if (lanSearching) {
            cancelLocalSearch()
            return true
        }
        if (step === "server")
            return false
        ++generation
        cancelConnect()
        busy = false
        passwordField.text = ""
        error = ""
        step = "server"
        Qt.callLater(address.focusRow)
        return true
    }

    function activate() {
        const item = Window.activeFocusItem
        if (item && typeof item.activate === "function")
            item.activate()
        else if (item && typeof item.clicked === "function")
            item.clicked()
        else if (item && typeof item.accepted === "function")
            item.accepted()
    }

    Component.onCompleted: {
        provider.request("discover").then(result => {
            if (!provider.closed)
                mergeServers(result.servers || [])
        }, () => {})
        provider.request("extensionStatus").then(result => {
            lanAvailable = !provider.closed && result.enabled && result.enabled["spool.lan-probe"] === 1
        }, () => {})
        Qt.callLater(address.focusRow)
    }

    Component.onDestruction: {
        ++generation
        cancelLocalSearch()
        cancelConnect()
    }

    Connections {
        target: root.provider
        function onClosedChanged() {
            if (root.provider.closed) {
                ++root.generation
                root.cancelConnect()
                root.cancelLocalSearch()
                root.lanAvailable = false
            }
        }
    }

    Timer {
        id: addressValidation
        interval: 150
        onTriggered: root.validateAddress(address.text)
    }

    Flickable {
        anchors.fill: parent
        contentHeight: column.implicitHeight + Metrics.pageMarginPx * 2
        boundsBehavior: Flickable.StopAtBounds
        clip: true

        ColumnLayout {
            id: column
            x: Math.max(Metrics.pageMarginPx, (parent.width - width) / 2)
            y: Metrics.pageMarginPx
            width: Math.min(root.width - Metrics.pageMarginPx * 2, Metrics.scaled(560))
            spacing: Metrics.scaled(12)

            SecondaryText {
                Layout.fillWidth: true
                text: "Independent Spool integration for Emby"
                wrapMode: Text.Wrap
            }

            CompatibilityNotice {
                Layout.fillWidth: true
                provider: root.provider
            }

            AppText {
                Layout.fillWidth: true
                Layout.bottomMargin: Metrics.scaled(8)
                visible: root.step === "account"
                text: root.server.name || ""
                font.pixelSize: Metrics.titleSizePx
                font.weight: Font.DemiBold
                elide: Text.ElideRight
            }

            Repeater {
                model: root.step === "server" ? root.servers : []
                delegate: ServerCard {
                    required property var modelData
                    Layout.fillWidth: true
                    title: modelData.name
                    serverAddress: modelData.address
                    enabled: !root.busy
                    onAccepted: root.connect(modelData.address)
                }
            }
            ActionButton {
                Layout.alignment: Qt.AlignLeft
                visible: root.step === "server"
                enabled: !root.busy
                text: "Sign in with Emby Connect"
                onClicked: root.startConnect()
            }

            AppText {
                Layout.fillWidth: true
                visible: root.step === "connect"
                text: "Emby Connect"
                font.pixelSize: Metrics.titleSizePx
                font.weight: Font.DemiBold
            }

            SecondaryText {
                Layout.fillWidth: true
                visible: root.step === "connect" && root.connectState.phase === "pin"
                text: "Open emby.media/pin on another device and enter this code:"
                wrapMode: Text.Wrap
            }

            AppText {
                Layout.fillWidth: true
                visible: root.step === "connect" && root.connectState.pin.length > 0
                text: root.connectState.pin
                font.pixelSize: Metrics.titleSizePx
                font.weight: Font.DemiBold
            }

            SecondaryText {
                Layout.fillWidth: true
                visible: root.step === "connect" && root.connectState.phase === "members"
                text: root.connectState.memberships.length
                      ? "Choose a server connection. Only the address you choose will be approved." :
                        "No server memberships are available for this Emby Connect account."
                wrapMode: Text.Wrap
            }

            Repeater {
                model: root.step === "connect" ? root.connectState.memberships : []
                delegate: ColumnLayout {
                    id: membershipRow
                    required property var modelData
                    required property int index
                    Layout.fillWidth: true
                    Repeater {
                        model: membershipRow.modelData.addresses
                        delegate: ServerCard {
                            required property string modelData
                            required property int index
                            Layout.fillWidth: true
                            title: membershipRow.modelData.name
                            serverAddress: modelData
                            enabled: !root.busy
                            onAccepted: root.connectFlow.select(membershipRow.index, index)
                        }
                    }
                }
            }

            ActionButton {
                id: connectRetry
                Layout.alignment: Qt.AlignLeft
                visible: root.step === "connect"
                text: "Get a new code"
                onClicked: root.startConnect()
            }

            ActionButton {
                id: connectBack
                Layout.alignment: Qt.AlignLeft
                visible: root.step === "connect"
                kind: "flat"
                text: "Back to server sign-in"
                onClicked: root.back()
            }

            ActionButton {
                Layout.alignment: Qt.AlignLeft
                visible: root.step === "server"
                enabled: !root.busy
                text: root.lanSearching ? "Cancel local search" : "Search local network"
                kind: "flat"
                onClicked: root.lanSearching ? root.cancelLocalSearch() : root.searchLocalNetwork()
            }

            SecondaryText {
                Layout.fillWidth: true
                visible: root.step === "server" && root.lanStatus.length > 0
                text: root.lanStatus
                wrapMode: Text.Wrap
            }

            TextFieldRow {
                id: address
                onTextChanged: {
                    root.validAddress = false
                    addressValidation.restart()
                }
                Layout.fillWidth: true
                visible: root.step === "server"
                enabled: !root.busy
                label: "Server"
                placeholderText: "192.168.1.20"
                inputMethodHints: Qt.ImhUrlCharactersOnly | Qt.ImhNoAutoUppercase | Qt.ImhNoPredictiveText
                onAccepted: root.connect(text)
            }

            ActionButton {
                Layout.alignment: Qt.AlignRight
                visible: root.step === "server"
                kind: "primary"
                text: "Connect"
                enabled: !root.busy && root.validAddress
                onClicked: root.connect(address.text)
            }

            Flow {
                id: users
                Layout.fillWidth: true
                visible: root.step === "account" && (root.server.users || []).length > 0
                spacing: Metrics.scaled(16)
                Repeater {
                    id: userProfiles
                    model: users.visible ? root.server.users : []
                    delegate: ProfileTile {
                        required property var modelData
                        tileSize: Metrics.scaled(96)
                        username: modelData.name
                        enabled: !root.busy
                        onAccepted: {
                            usernameField.text = modelData.name
                            if (modelData.hasPassword)
                                passwordField.focusRow()
                            else
                                root.signIn(modelData.name, "")
                        }
                    }
                }
            }

            TextFieldRow {
                id: usernameField
                Layout.fillWidth: true
                visible: root.step === "account"
                enabled: !root.busy
                label: "Username"
                inputMethodHints: Qt.ImhNoAutoUppercase | Qt.ImhNoPredictiveText
                onAccepted: passwordField.focusRow()
            }

            TextFieldRow {
                id: passwordField
                Layout.fillWidth: true
                visible: root.step === "account"
                enabled: !root.busy
                label: "Password"
                echoMode: TextInput.Password
                onAccepted: root.signIn(usernameField.text, text)
            }

            ActionButton {
                Layout.alignment: Qt.AlignRight
                visible: root.step === "account"
                kind: "primary"
                text: "Sign in"
                enabled: !root.busy && usernameField.text.trim().length > 0
                onClicked: root.signIn(usernameField.text, passwordField.text)
            }

            ActionButton {
                Layout.alignment: Qt.AlignRight
                visible: root.step === "account"
                kind: "flat"
                text: "Change server"
                onClicked: root.back()
            }

            BusySpinner {
                Layout.alignment: Qt.AlignHCenter
                Layout.preferredWidth: Metrics.scaled(24)
                Layout.preferredHeight: Metrics.scaled(24)
                running: root.busy
                visible: running
            }

            SecondaryText {
                Layout.fillWidth: true
                visible: root.error.length > 0
                text: root.error
                color: Theme.errorText
                wrapMode: Text.Wrap
            }
        }
    }
}
