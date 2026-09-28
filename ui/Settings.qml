// SPDX-License-Identifier: MPL-2.0
import QtQuick
import QtQuick.Layouts
import Spool

FocusScope {
    id: root

    property var provider

    Component.onCompleted: Qt.callLater(() => InputKeys.focus(closeButton))

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: Metrics.pageMarginPx
        spacing: Metrics.scaled(12)

        AppText {
            Layout.fillWidth: true
            text: "Emby settings"
            font.pixelSize: Metrics.titleSizePx
            font.weight: Font.DemiBold
        }

        CompatibilityNotice {
            Layout.fillWidth: true
            provider: root.provider
        }

        AppText {
            Layout.fillWidth: true
            text: "Playback and appearance preferences are available in Spool settings."
            wrapMode: Text.WordWrap
        }

        Item { Layout.fillHeight: true }

        ActionButton {
            id: closeButton
            Layout.alignment: Qt.AlignRight
            text: "Close"
            onClicked: root.provider.close()
        }
    }
}
