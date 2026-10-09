// SPDX-License-Identifier: MPL-2.0
pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Layouts
import Spool

FocusScope {
    id: root
    property var provider
    readonly property var account: provider ? Providers.accounts.find(entry => entry.id === provider.sourceId) : null
    property var values: ({})
    property var edits: ({})
    property var writable: []
    property bool loaded: false
    property bool busy: false
    property int generation: 0
    property string problem: ""
    property string status: ""
    property string choiceField: ""
    property Item choiceAnchor: null
    readonly property var audioModes: ["Default", "Smart"]
    readonly property var subtitleModes: ["Default", "Smart", "OnlyForced", "Always", "None"]
    readonly property bool dirty: Object.keys(edits).length > 0
    readonly property bool validEdits: Object.keys(edits).every(field => {
        const value = edits[field]
        return writable.indexOf(field) >= 0 && (field !== "audioLanguage" && field !== "subtitleLanguage"
                                                || value === "" || /^[a-z]{3}$/.test(value))
    })
    readonly property real keyboardInset: {
        if (!Qt.inputMethod.visible)
            return 0
        const keyboard = Qt.inputMethod.keyboardRectangle
        if (keyboard.height <= 0)
            return 0
        const pageBottom = root.mapToItem(null, 0, root.height).y
        return Math.max(0, Math.min(root.height, pageBottom - keyboard.y))
    }

    function current(field) {
        return Object.prototype.hasOwnProperty.call(edits, field) ? edits[field] : values[field]
    }
    function canEdit(field) {
        return loaded && !busy && writable.indexOf(field) >= 0
                && Object.prototype.hasOwnProperty.call(values, field)
    }
    function edit(field, value) {
        if (!canEdit(field))
            return
        const next = Object.assign({}, edits)
        if (value === values[field])
            delete next[field]
        else
            next[field] = value
        edits = next
        status = ""
    }
    function message(reason) {
        const code = String(reason && (reason.code || reason.message) || reason)
        if (code === "permission_denied" || code === "preference_read_only")
            return "The server does not allow this change. Your edits are retained; reload to check current permissions."
        if (code === "http_401" || code === "not_signed_in")
            return "Your session has expired. Close this screen and sign in again."
        if (code === "preferences_unavailable" || code === "unsupported_capability")
            return "User preferences are unavailable on this server."
        if (code === "invalid_preferences")
            return "The server could not accept these preferences. Languages must be three-letter ISO 639-2 codes or empty."
        return "Couldn't access user preferences. Check the connection and reload. Your edits are retained."
    }
    function reload(afterSave) {
        if (busy || !provider || provider.closed)
            return
        const stamp = ++generation
        busy = true
        problem = ""
        if (!afterSave)
            status = ""
        provider.request("preferencesRead").then(result => {
            if (stamp !== generation || provider.closed)
                return
            values = result.values || {}
            writable = result.writable || []
            const next = Object.assign({}, edits)
            for (const field of Object.keys(next)) {
                if (next[field] === values[field])
                    delete next[field]
            }
            edits = next
            loaded = true
            busy = false
            status = afterSave ? "Saved to this user's server preferences." : dirty ? "Reloaded. Your unsaved edits are retained." : ""
            Qt.callLater(() => InputKeys.focus(canEdit("audioLanguage") ? audioLanguage : reloadButton))
        }, reason => {
            if (stamp !== generation || provider.closed)
                return
            busy = false
            problem = afterSave ? "Saved, but couldn't refresh the server values. Reload to check them." : message(reason)
            Qt.callLater(() => InputKeys.focus(reloadButton))
        })
    }
    function save() {
        if (busy || !dirty || !validEdits || provider.closed)
            return
        const submitted = Object.assign({}, edits)
        const stamp = ++generation
        busy = true
        problem = ""
        status = "Saving…"
        Qt.inputMethod.hide()
        InputKeys.focus(cancelButton)
        provider.request("preferencesWrite", { values: submitted }).then(() => {
            if (stamp !== generation || provider.closed)
                return
            values = Object.assign({}, values, submitted)
            edits = ({})
            busy = false
            status = "Saved to this user's server preferences."
            reload(true)
        }, reason => {
            if (stamp !== generation || provider.closed)
                return
            busy = false
            status = ""
            problem = message(reason)
            const code = String(reason && (reason.code || reason.message) || reason)
            if (code === "permission_denied" || code === "preference_read_only")
                writable = []
            Qt.callLater(() => InputKeys.focus(reloadButton))
        })
    }
    function closeChoice() {
        const anchor = choiceAnchor
        choiceField = ""
        Qt.callLater(() => InputKeys.focus(anchor))
    }
    function openChoice(field, anchor) {
        if (!canEdit(field))
            return
        Qt.inputMethod.hide()
        choiceAnchor = anchor
        choiceField = field
    }
    function controls() {
        return [audioLanguage, audioMode, subtitleLanguage, subtitleMode, saveButton, discardButton,
                reloadButton, cancelButton].filter(item => item.visible && item.enabled)
    }
    function revealFocus() {
        const focused = root.Window.window ? root.Window.window.activeFocusItem : null
        let ancestor = focused
        while (ancestor && ancestor !== root)
            ancestor = ancestor.parent
        if (!focused || ancestor !== root || choiceField.length)
            return
        const bounds = focused.mapToItem(viewport.contentItem, 0, 0, focused.width, focused.height)
        const margin = Metrics.scaled(12)
        let offset = viewport.contentY
        if (bounds.y < offset + margin)
            offset = bounds.y - margin
        else if (bounds.y + bounds.height > offset + viewport.height - margin)
            offset = bounds.y + bounds.height - viewport.height + margin
        viewport.contentY = Math.max(0, Math.min(Math.max(0, viewport.contentHeight - viewport.height), offset))
    }
    function routeKey(key, phase, repeat) {
        if (choiceLoader.item)
            return choiceLoader.item.routeKey(key, phase, repeat)
        if (!InputKeys.isDirection(key))
            return false
        const focused = root.Window.window ? root.Window.window.activeFocusItem : null
        if (InputKeys.isTextInputItem(focused) && InputKeys.isHorizontal(key))
            return false
        if (phase !== "press")
            return true
        const items = controls()
        const index = items.findIndex(item => item.activeFocus || item.editing === true)
        const next = index < 0 ? 0 : Math.max(0, Math.min(items.length - 1,
            index + (key === Qt.Key_Up || key === Qt.Key_Left ? -1 : 1)))
        if (items[next])
            InputKeys.focus(items[next])
        return true
    }
    function activate() {
        if (choiceLoader.item)
            return choiceLoader.item.activate()
        const item = controls().find(control => control.activeFocus || control.editing === true)
        if (item && typeof item.activate === "function")
            item.activate()
        else if (item)
            item.clicked()
    }
    function back() {
        if (choiceField.length) {
            closeChoice()
            return true
        }
        if (audioLanguage.releaseTextInput() || subtitleLanguage.releaseTextInput())
            return true
        Qt.inputMethod.hide()
        ++generation
        provider.close()
        return true
    }
    Component.onCompleted: {
        reload(false)
        Qt.callLater(() => InputKeys.focus(cancelButton))
    }
    Component.onDestruction: ++generation
    Connections {
        target: root.Window.window
        function onActiveFocusItemChanged() { Qt.callLater(root.revealFocus) }
    }
    Connections {
        target: Qt.inputMethod
        function onVisibleChanged() { Qt.callLater(root.revealFocus) }
        function onKeyboardRectangleChanged() { Qt.callLater(root.revealFocus) }
    }

    Flickable {
        id: viewport
        anchors.fill: parent
        anchors.bottomMargin: root.keyboardInset
        contentWidth: width
        contentHeight: column.implicitHeight + Metrics.pageMarginPx * 2
        boundsBehavior: Flickable.StopAtBounds
        clip: true
        onHeightChanged: Qt.callLater(root.revealFocus)
        ColumnLayout {
            id: column
            x: (viewport.width - width) / 2
            y: Metrics.pageMarginPx
            width: Math.max(0, Math.min(viewport.width - Metrics.pageMarginPx * 2, Metrics.scaled(760)))
            spacing: Metrics.scaled(12)
            AppText {
                Layout.fillWidth: true
                text: "Emby user preferences"
                font.pixelSize: Metrics.titleSizePx
                font.weight: Font.DemiBold
                wrapMode: Text.WordWrap
            }
            SecondaryText {
                Layout.fillWidth: true
                text: "Signed-in user: " + (root.account ? root.account.label : "this account")
                      + (root.account && root.account.detail ? " · " + root.account.detail : "")
                      + ". These preferences belong to this user on this server and affect other Emby clients."
                wrapMode: Text.WordWrap
            }
            SecondaryText {
                Layout.fillWidth: true
                text: "Spool's local playback and appearance options remain in Spool settings. Language preferences use three-letter ISO 639-2 codes, such as eng, fra or deu. Leave empty for no language preference; existing server codes are preserved unless edited."
                wrapMode: Text.WordWrap
            }
            SecondaryText {
                Layout.fillWidth: true
                visible: root.loaded && root.writable.length === 0
                text: "Read-only: the server's user policy does not allow preference changes, or these fields are unsupported."
                wrapMode: Text.WordWrap
            }
            TextFieldRow {
                id: audioLanguage
                Layout.fillWidth: true
                enabled: root.canEdit("audioLanguage")
                label: "Preferred audio language" + (enabled ? "" : " (read-only)")
                text: String(root.current("audioLanguage") || "")
                placeholderText: root.values.audioLanguage === undefined ? "Unavailable from server" : "No preference"
                inputMethodHints: Qt.ImhLatinOnly | Qt.ImhNoAutoUppercase | Qt.ImhNoPredictiveText
                onTextEdited: text => root.edit("audioLanguage", text)
                onAccepted: InputKeys.focus(audioMode.enabled ? audioMode : reloadButton)
            }
            SelectRow {
                id: audioMode
                Layout.fillWidth: true
                enabled: root.canEdit("audioMode")
                title: "Audio mode"
                description: enabled ? "Default uses the default track; Smart prefers the chosen language." : "Read-only or unsupported by this server."
                options: root.current("audioMode") === undefined ? ["Unavailable"] : root.audioModes
                currentIndex: Math.max(0, options.indexOf(root.current("audioMode")))
                onOpened: root.openChoice("audioMode", audioMode)
            }
            TextFieldRow {
                id: subtitleLanguage
                Layout.fillWidth: true
                enabled: root.canEdit("subtitleLanguage")
                label: "Preferred subtitle language" + (enabled ? "" : " (read-only)")
                text: String(root.current("subtitleLanguage") || "")
                placeholderText: root.values.subtitleLanguage === undefined ? "Unavailable from server" : "No preference"
                inputMethodHints: Qt.ImhLatinOnly | Qt.ImhNoAutoUppercase | Qt.ImhNoPredictiveText
                onTextEdited: text => root.edit("subtitleLanguage", text)
                onAccepted: InputKeys.focus(subtitleMode.enabled ? subtitleMode : reloadButton)
            }
            SelectRow {
                id: subtitleMode
                Layout.fillWidth: true
                enabled: root.canEdit("subtitleMode")
                title: "Subtitle mode"
                description: enabled ? "Default, Smart, forced only, always, or no subtitles." : "Read-only or unsupported by this server."
                options: root.current("subtitleMode") === undefined ? ["Unavailable"] : root.subtitleModes
                currentIndex: Math.max(0, options.indexOf(root.current("subtitleMode")))
                onOpened: root.openChoice("subtitleMode", subtitleMode)
            }
            SecondaryText {
                Layout.fillWidth: true
                visible: root.dirty && !root.validEdits
                text: "Each edited language must be empty or three lowercase letters. Read-only edits cannot be saved; reload to check permissions or discard your edits."
                color: Theme.errorText
                wrapMode: Text.WordWrap
            }
            SecondaryText {
                Layout.fillWidth: true
                visible: root.problem.length > 0
                text: root.problem
                color: Theme.errorText
                wrapMode: Text.WordWrap
            }
            SecondaryText {
                Layout.fillWidth: true
                visible: root.busy || root.status.length > 0
                text: root.status || "Loading user preferences…"
                wrapMode: Text.WordWrap
            }
            ActionButton {
                id: saveButton
                Layout.fillWidth: true
                text: "Save changes"
                kind: "primary"
                enabled: !root.busy && root.dirty && root.validEdits
                onClicked: root.save()
            }
            ActionButton {
                id: discardButton
                Layout.fillWidth: true
                text: "Discard unsaved edits"
                visible: root.dirty
                enabled: !root.busy
                onClicked: {
                    root.edits = ({})
                    root.problem = ""
                    root.status = "Unsaved edits discarded."
                    InputKeys.focus(reloadButton)
                }
            }
            ActionButton {
                id: reloadButton
                Layout.fillWidth: true
                text: "Reload from server"
                enabled: !root.busy
                onClicked: root.reload(false)
            }
            ActionButton {
                id: cancelButton
                Layout.fillWidth: true
                text: root.dirty || root.busy ? "Cancel / close" : "Close"
                kind: "flat"
                onClicked: {
                    Qt.inputMethod.hide()
                    ++root.generation
                    root.provider.close()
                }
            }
        }
    }
    Loader {
        id: choiceLoader
        anchors.fill: parent
        active: root.choiceField.length > 0
        sourceComponent: OptionPickerDialog {
            visible: true
            anchorItem: root.choiceAnchor
            title: root.choiceField === "audioMode" ? "Audio mode" : "Subtitle mode"
            options: root.choiceField === "audioMode" ? root.audioModes : root.subtitleModes
            currentIndex: Math.max(0, options.indexOf(root.current(root.choiceField)))
            onSelected: index => {
                root.edit(root.choiceField, options[index])
                root.closeChoice()
            }
            onDismissed: root.closeChoice()
            onSpaceBelowRequired: pixels => {
                viewport.contentY = Math.min(Math.max(0, viewport.contentHeight - viewport.height),
                                             Math.max(0, viewport.contentY + pixels))
                Qt.callLater(choiceLoader.item.completePresentation)
            }
        }
    }
}
