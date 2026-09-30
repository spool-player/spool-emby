// SPDX-License-Identifier: MPL-2.0
import QtQuick
import Spool

ProviderActionPicker {
    id: root
    remoteControls: Component {
        ProviderRemoteControls {
            provider: root.provider
            textCommand: "SendString"
            messageCommand: "DisplayMessage"
        }
    }
}
