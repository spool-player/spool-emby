// SPDX-License-Identifier: MPL-2.0
import QtQuick
import QtQuick.Layouts
import Spool

// Signing in to an Emby server: one found on the network or typed, then a
// user and password.
FocusScope {
    id: root

    property var provider
    property string step: "server"
    property var servers: []
    property bool busy: false
    property string error: ""
    property var server: ({})
    property int generation: 0

    readonly property var messages: ({
                                         "http_401": "Wrong username or password",
                                         "invalid_credentials": "Wrong username or password",
                                         "not_emby": "Not an Emby server",
                                         "invalid_server": "Enter a valid HTTP or HTTPS server address",
                                         "origin_denied": "Not a server address"
                                     })

    function fail(code) {
        busy = false
        error = messages[code] || "Couldn't reach the server"
    }

    // Same rule as normalizeServer() in logic/provider.mjs, so the origin
    // allowed here is the one requests go to.
    function normalized(input) {
        let text = String(input || "").trim().replace(/\/+$/, "").replace(/\/emby$/i, "")
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text))
            text = "http://" + text
        const parts = /^(https?):\/\/(\[[0-9a-f:]+\]|[^/:?#@\s\\]+)(:\d+)?(\/[^?#\\\s]*)?$/i.exec(text)
        if (!parts || (parts[3] && (Number(parts[3].slice(1)) < 1 || Number(parts[3].slice(1)) > 65535)))
            throw new Error("invalid_server")
        return parts[1].toLowerCase() + "://" + parts[2] + (parts[3] || (parts[1].toLowerCase() === "http" && !parts[4]
                                                                         ? ":8096" : "")) + (parts[4] || "")
    }

    function connect(input) {
        if (busy || String(input).trim().length === 0)
            return
        let address
        try {
            address = normalized(input)
        } catch (failure) {
            fail(failure.message)
            return
        }
        const request = ++generation
        busy = true
        error = ""
        provider.allowOrigin(address).then(() => provider.request("probe", {
                                                                      "server": address
                                                                  })).then(result => {
                                                                      if (request !== generation)
                                                                          return
                                                                      busy = false
                                                                      server = result
                                                                      usernameField.text = ""
                                                                      passwordField.text = ""
                                                                      step = "account"
                                                                      Qt.callLater(() => userProfiles.count > 0
                                                                                         ? InputKeys.focus(
                                                                                               userProfiles.itemAt(0)) :
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
        if (step === "server")
            return false
        ++generation
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
        provider.request("discover").then(result => servers = result.servers || [], () => {})
        Qt.callLater(address.focusRow)
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

            TextFieldRow {
                id: address
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
                enabled: !root.busy && address.text.trim().length > 0
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
