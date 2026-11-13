import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import qs.Ui
import qs.Commons
import qs.Commons as Commons

// Read Aloud: local, private text-to-speech (Kokoro) in the bar.
//
// The panel is a thin client of the omarchy-read-aloud daemon. It keeps one
// connection to the daemon's private socket; the daemon pushes the text and
// playback state, and the panel sends commands. Text goes over that socket
// only, never through command arguments, files or logs.
Panel {
  id: root
  moduleName: "jebin2.read-aloud"
  ipcTarget: "jebin2.read-aloud"
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  Commons.Translations { id: strings; directory: Qt.resolvedUrl("i18n") }

  readonly property string socketPath: Quickshell.env("XDG_RUNTIME_DIR") + "/omarchy-read-aloud/control.sock"
  readonly property string binDir: decodeURIComponent(String(Qt.resolvedUrl("bin")).replace(/^file:\/\//, ""))
  readonly property string setupCmd: binDir + "/read-aloud-setup"

  // From `read-aloud-setup check`: is the engine installed, current, and is
  // the Super+Alt+R shortcut there.
  property var info: ({ loaded: false })
  readonly property bool installed: info.loaded === true && info.installed === true
  property bool setupRunning: false
  property string setupStep: ""      // the latest "step: …" line of a running setup
  property string setupMsg: ""       // the last line of a failed setup
  property bool shortcutBusy: false
  property bool confirmUninstall: false
  property bool uninstalling: false

  // Pushed by the daemon.
  property string phase: "offline"   // offline | empty | ready | loading | playing | paused
  property string engineState: "unloaded"
  property string spokenText: ""      // the text the daemon holds (RAM only)
  property int wordStart: -1          // the word being heard, char offsets
  property int wordEnd: -1
  property real progress: 0
  property string voice: "af_heart"
  property real speed: 1
  property var voices: []
  property string errorText: ""

  // What the editor shows. The editor lives inside the panel's content
  // component (its own scope), so the root owns the text and the editor syncs.
  property string draft: ""
  // True when the editor holds text the daemon has not been given yet.
  property bool draftDirty: false
  readonly property bool busy: phase === "playing" || phase === "loading"
  readonly property bool active: busy || phase === "paused"

  function send(msg) {
    if (!sock.connected) { ensureDaemon(); return }
    sock.write(JSON.stringify(msg) + "\n")
    sock.flush()
  }

  // Start the user service if the socket is not there (first use, or stopped).
  function ensureDaemon() {
    if (!root.installed) return
    Quickshell.execDetached(["systemctl", "--user", "start", "omarchy-read-aloud.service"])
    sock.connected = true
  }

  function handleLine(line) {
    var msg
    try { msg = JSON.parse(line) } catch (e) { return }
    if (msg.type === "text") {
      root.spokenText = typeof msg.text === "string" ? msg.text : ""
      // A new text from the shortcut (or a clear) replaces whatever is shown.
      if (!root.draftDirty || root.spokenText === "") {
        root.draft = root.spokenText
        root.draftDirty = false
      }
    } else if (msg.type === "word") {
      root.wordStart = msg.word ? Number(msg.word.start) : -1
      root.wordEnd = msg.word ? Number(msg.word.end) : -1
    } else if (msg.type === "state") {
      root.phase = String(msg.phase || "empty")
      root.engineState = String(msg.engine || "unloaded")
      root.progress = Number(msg.progress || 0)
      root.voice = String(msg.voice || "af_heart")
      root.speed = Number(msg.speed || 1)
      // Sent with the reply to subscribe only; it does not change.
      if (Array.isArray(msg.voices)) root.voices = msg.voices.slice(0, 100)
      root.errorText = String(msg.error || "").slice(0, 300)
    }
  }

  function playPause() {
    if (root.busy) return send({ cmd: "pause" })
    if (root.phase === "paused" && !root.draftDirty) return send({ cmd: "resume" })
    var t = root.draft
    if (!t.trim()) return
    if (root.draftDirty || t !== root.spokenText) {
      root.draftDirty = false
      send({ cmd: "speak", text: t })
    } else {
      send({ cmd: "speak" })
    }
  }

  function refresh() { if (!checkProc.running) checkProc.running = true }

  function runSetup() {
    if (root.setupRunning) return
    root.setupRunning = true
    root.setupStep = ""
    root.setupMsg = ""
    setupProc.running = true
  }

  function setShortcut(on) {
    if (shortcutProc.running) return
    root.shortcutBusy = true
    shortcutProc.command = ["bash", root.setupCmd, "shortcut", on ? "on" : "off"]
    shortcutProc.running = true
  }

  // Detached: the plugin removes itself at the end, which unloads this panel.
  function uninstall() {
    root.confirmUninstall = false
    root.uninstalling = true
    Quickshell.execDetached(["bash", root.setupCmd, "uninstall"])
  }

  Component.onCompleted: refresh()
  onOpenedChanged: if (opened) refresh()

  Process {
    id: checkProc
    command: ["bash", root.setupCmd, "check"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        try {
          var i = JSON.parse(String(text || "{}"))
          i.loaded = true
          var was = root.installed
          root.info = i
          if (!was && root.installed) sock.connected = true
        } catch (e) {}
      }
    }
  }

  Process {
    id: setupProc
    command: ["bash", root.setupCmd, "setup"]
    stdout: SplitParser {
      onRead: function(data) {
        var l = String(data)
        if (l.indexOf("step: ") === 0) root.setupStep = l.substring(6)
      }
    }
    stderr: StdioCollector { id: setupErr; waitForEnd: true }
    onExited: function(exitCode) {
      root.setupRunning = false
      root.setupStep = ""
      // 126: the password prompt for Bun was dismissed; not a failure.
      if (exitCode !== 0 && exitCode !== 126) {
        var lines = String(setupErr.text || "").trim().split("\n").filter(function(l) { return l.trim() !== "" })
        root.setupMsg = lines.length ? lines[lines.length - 1].slice(0, 300) : strings.t("setup.failed").arg(exitCode)
      }
      root.refresh()
    }
  }

  Process {
    id: shortcutProc
    onExited: { root.shortcutBusy = false; root.refresh() }
  }

  function statusText() {
    if (root.info.loaded === true && !root.installed) return strings.t("status.setup")
    if (root.phase === "offline") return strings.t("status.offline")
    if (root.phase === "loading") return root.engineState === "loading" ? strings.t("status.loadingModel") : strings.t("status.starting")
    if (root.phase === "playing") return strings.t("status.playing").arg(Math.round(root.progress * 100))
    if (root.phase === "paused") return strings.t("status.paused")
    if (root.phase === "ready") return strings.t("status.ready")
    return strings.t("status.empty")
  }

  Socket {
    id: sock
    path: root.socketPath
    connected: true
    parser: SplitParser { onRead: function(data) { root.handleLine(String(data)) } }
    onConnectionStateChanged: {
      if (connected) {
        write(JSON.stringify({ cmd: "subscribe" }) + "\n")
        flush()
      } else {
        root.phase = "offline"
      }
    }
  }

  // Reconnect while the daemon is away (service restart, first start).
  Timer {
    interval: 2000
    repeat: true
    running: !sock.connected && root.installed
    onTriggered: sock.connected = true
  }

  // A draft never played (pasted or typed) is forgotten like the daemon
  // forgets its text: 10 minutes after the last change.
  function armForget() {
    if (root.draftDirty && !root.active) forgetDraft.restart()
    else forgetDraft.stop()
  }
  onDraftChanged: armForget()
  onDraftDirtyChanged: armForget()
  onActiveChanged: armForget()
  Timer {
    id: forgetDraft
    interval: 600000
    onTriggered: { root.draft = ""; root.draftDirty = false }
  }

  // Pastes the clipboard into the editor. Only the editor sees it; nothing
  // is sent until Play.
  Process {
    id: pasteProc
    command: ["wl-paste", "--no-newline", "--type", "text"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var t = String(text || "")
        if (!t.trim() || root.active) return
        root.draft = t
        root.draftDirty = true
      }
    }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.phase === "paused" ? "󰏤" : "󰔊"
    opacity: root.active ? 1.0 : 0.75
    onPressed: function(b) { root.toggle() }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: panel.loadedContent
    contentWidth: panel.fittedContentWidth(Style.space(440))
    contentHeight: panel.fittedContentHeight(panel.loadedContentHeight, Style.space(640))

    content: PanelKeyCatcher {
      implicitHeight: column.implicitHeight
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Column {
        id: column
        width: parent.width
        spacing: Style.space(12)

        // ---------- Hero ----------
        Item {
          width: parent.width
          implicitHeight: Math.max(heroIcon.implicitHeight, heroLabels.implicitHeight)

          Text {
            id: heroIcon
            text: "󰔊"
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.display
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
          }
          Column {
            id: heroLabels
            anchors.left: heroIcon.right
            anchors.leftMargin: Style.space(14)
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)
            Text {
              textFormat: Text.PlainText
              text: strings.t("title")
              color: root.bar.foreground
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.title
              font.bold: true
            }
            Text {
              textFormat: Text.PlainText
              text: root.statusText()
              color: Qt.darker(root.bar.foreground, 1.4)
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
              font.capitalization: Font.AllUppercase
              font.letterSpacing: 1
            }
          }
        }

        // ---------- One-time setup, or an update of the engine ----------
        Column {
          visible: root.info.loaded === true && (!root.installed || root.info.update === true)
          width: parent.width
          spacing: Style.space(10)

          Text {
            width: parent.width
            wrapMode: Text.WordWrap
            textFormat: Text.PlainText
            text: root.installed ? strings.t("setup.updateText") : strings.t("setup.text")
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.body
          }
          Button {
            text: root.setupRunning ? (root.setupStep || strings.t("setup.running"))
              : root.installed ? strings.t("setup.update") : strings.t("setup.button")
            iconText: root.setupRunning ? "󰑓" : "󰇚"
            iconSpinning: root.setupRunning
            enabled: !root.setupRunning
            opacity: enabled ? 1.0 : 0.7
            foreground: root.bar.foreground
            fontFamily: root.bar.fontFamily
            bordered: true
            onClicked: root.runSetup()
          }
          Text {
            visible: root.setupMsg !== ""
            width: parent.width
            wrapMode: Text.WordWrap
            textFormat: Text.PlainText
            text: "✗ " + root.setupMsg
            color: Commons.Color.accent
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.caption
          }
        }

        // ---------- Text ----------
        Item {
          width: parent.width
          visible: root.installed
          height: Style.space(220)

          BorderSurface {
            anchors.fill: parent
            color: Style.controlFill(textBox.activeFocus, false, root.bar.foreground, Commons.Color.accent)
            borderSpec: Border.controlSpec(textBox.activeFocus ? "focus" : "normal", root.bar.foreground, Commons.Color.accent)
            radius: Style.cornerRadius
          }

          ScrollView {
            id: scroll
            anchors.fill: parent
            anchors.margins: Style.space(2)
            clip: true
            ScrollBar.horizontal.policy: ScrollBar.AlwaysOff

            TextArea {
              id: textBox
              textFormat: TextEdit.PlainText
              wrapMode: TextEdit.Wrap
              readOnly: root.active
              selectByMouse: true
              placeholderText: strings.t("editor.placeholder")
              placeholderTextColor: Qt.darker(root.bar.foreground, 1.6)
              color: root.bar.foreground
              selectionColor: Style.selectionFillFor(root.bar.foreground, Commons.Color.accent)
              selectedTextColor: root.bar.foreground
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.body
              background: null
              Component.onCompleted: { text = root.draft; showHighlight() }
              onTextChanged: {
                if (text === root.draft) return
                root.draft = text
                if (!readOnly) root.draftDirty = text !== root.spokenText
              }

              // Only the word is highlighted (wordBox below); this keeps it in view.
              function showHighlight() {
                if (!(root.active && root.wordStart >= 0 && !root.draftDirty && text === root.spokenText)) return
                var r = positionToRectangle(root.wordStart)
                var flick = scroll.contentItem
                if (flick && flick.contentY !== undefined
                    && (r.y < flick.contentY || r.y + r.height > flick.contentY + flick.height))
                  flick.contentY = Math.max(0, Math.min(r.y - Style.space(24), height - flick.height))
              }

              Connections {
                target: root
                function onDraftChanged() { if (textBox.text !== root.draft) textBox.text = root.draft }
                function onWordStartChanged() { textBox.showHighlight() }
              }

              // The word being heard: an accent box behind it.
              Rectangle {
                id: wordBox
                readonly property bool shown: root.active && root.wordStart >= 0 && !root.draftDirty
                  && textBox.text === root.spokenText && root.wordEnd <= textBox.length
                readonly property rect a: shown ? textBox.positionToRectangle(root.wordStart) : Qt.rect(0, 0, 0, 0)
                readonly property rect b: shown ? textBox.positionToRectangle(root.wordEnd) : Qt.rect(0, 0, 0, 0)
                visible: shown
                z: -1
                x: a.x - Style.space(2)
                y: a.y
                // A word never wraps, but guard against the end landing on the next line.
                width: (b.y === a.y ? b.x - a.x : textBox.width - textBox.rightPadding - a.x) + Style.space(4)
                height: a.height
                radius: Style.space(3)
                color: Commons.Color.accent
                opacity: 0.45
                Behavior on x { NumberAnimation { duration: Style.duration(90); easing.type: Easing.OutCubic } }
                Behavior on width { NumberAnimation { duration: Style.duration(90); easing.type: Easing.OutCubic } }
              }
            }
          }
        }

        // ---------- Controls ----------
        Row {
          visible: root.installed
          spacing: Style.space(6)

          Button {
            text: root.busy ? strings.t("button.pause") : strings.t("button.play")
            iconText: root.busy ? "󰏤" : "󰐊"
            iconSpinning: false
            enabled: root.phase !== "offline" && (root.active || root.draft.trim() !== "")
            opacity: enabled ? 1.0 : 0.5
            foreground: root.bar.foreground
            fontFamily: root.bar.fontFamily
            bordered: true
            onClicked: root.playPause()
          }
          Button {
            text: strings.t("button.stop")
            iconText: "󰓛"
            enabled: root.active
            opacity: enabled ? 1.0 : 0.5
            foreground: root.bar.foreground
            fontFamily: root.bar.fontFamily
            bordered: true
            onClicked: root.send({ cmd: "stop" })
          }
          Button {
            text: strings.t("button.clear")
            iconText: "󰆴"
            enabled: root.phase !== "offline" && (root.draft !== "" || root.spokenText !== "")
            opacity: enabled ? 1.0 : 0.5
            foreground: root.bar.foreground
            fontFamily: root.bar.fontFamily
            bordered: true
            onClicked: {
              root.draft = ""
              root.draftDirty = false
              root.send({ cmd: "clear" })
            }
          }
          Button {
            text: strings.t("button.paste")
            iconText: "󰆒"
            enabled: !root.active && !pasteProc.running
            opacity: enabled ? 1.0 : 0.5
            foreground: root.bar.foreground
            fontFamily: root.bar.fontFamily
            bordered: true
            onClicked: pasteProc.running = true
          }
        }

        // ---------- Voice and speed ----------
        Row {
          width: parent.width
          visible: root.installed
          spacing: Style.space(12)

          Dropdown {
            id: voiceDropdown
            width: Style.space(170)
            label: strings.t("voice")
            fontFamily: root.bar.fontFamily
            options: root.voices.length ? root.voices : [root.voice]
            value: root.voice
            enabled: root.phase !== "offline"
            onChanged: function(v) { root.send({ cmd: "set", voice: v }) }
          }

          Column {
            width: parent.width - voiceDropdown.width - parent.spacing
            spacing: Style.space(4)
            anchors.verticalCenter: parent.verticalCenter
            Text {
              textFormat: Text.PlainText
              text: strings.t("speed").arg(Commons.I18n.formatNumber(root.speed, 2))
              color: Qt.darker(root.bar.foreground, 1.4)
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.caption
            }
            PanelSlider {
              width: parent.width
              bar: root.bar
              minimum: 0.5
              maximum: 2
              step: 0.05
              value: root.speed
              enabled: root.phase !== "offline"
              onReleased: function(v) { root.send({ cmd: "set", speed: Math.round(v * 100) / 100 }) }
            }
          }
        }

        // ---------- Notes ----------
        Text {
          visible: root.installed && root.errorText !== ""
          width: parent.width
          wrapMode: Text.WordWrap
          textFormat: Text.PlainText
          text: "✗ " + root.errorText
          color: Commons.Color.accent
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.caption
        }
        Text {
          width: parent.width
          wrapMode: Text.WordWrap
          textFormat: Text.PlainText
          visible: root.installed
          text: root.phase === "offline" ? strings.t("note.offline") : strings.t("note.private")
          color: Qt.darker(root.bar.foreground, 1.5)
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.caption
        }

        // ---------- Shortcut ----------
        Item {
          visible: root.installed
          width: parent.width
          implicitHeight: Math.max(shortcutLabel.implicitHeight, shortcutSwitch.implicitHeight)

          Text {
            id: shortcutLabel
            anchors.left: parent.left
            anchors.right: shortcutSwitch.left
            anchors.rightMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
            wrapMode: Text.WordWrap
            textFormat: Text.PlainText
            text: strings.t("shortcut")
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.body
          }
          ToggleSwitch {
            id: shortcutSwitch
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            checked: root.info.shortcut === true
            busy: root.shortcutBusy
            foreground: root.bar.foreground
            onToggled: root.setShortcut(!checked)
          }
        }

        // ---------- Uninstall ----------
        Column {
          visible: root.info.loaded === true
          width: parent.width
          spacing: Style.space(8)

          PanelSeparator { foreground: root.bar.foreground }

          Button {
            visible: !root.confirmUninstall
            text: root.uninstalling ? strings.t("uninstall.running") : strings.t("uninstall.button")
            iconText: root.uninstalling ? "󰑓" : ""
            iconSpinning: root.uninstalling
            enabled: !root.uninstalling && !root.setupRunning
            opacity: enabled ? 1.0 : 0.6
            fontSize: Style.font.caption
            foreground: root.bar.foreground
            fontFamily: root.bar.fontFamily
            bordered: true
            onClicked: root.confirmUninstall = true
          }
          Text {
            visible: root.confirmUninstall
            width: parent.width
            wrapMode: Text.WordWrap
            textFormat: Text.PlainText
            text: strings.t("uninstall.confirm")
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.caption
          }
          Row {
            visible: root.confirmUninstall
            spacing: Style.space(6)
            Button {
              text: strings.t("uninstall.yes")
              fontSize: Style.font.caption
              foreground: Commons.Color.accent
              fontFamily: root.bar.fontFamily
              bordered: true
              onClicked: root.uninstall()
            }
            Button {
              text: strings.t("uninstall.cancel")
              fontSize: Style.font.caption
              foreground: root.bar.foreground
              fontFamily: root.bar.fontFamily
              bordered: true
              onClicked: root.confirmUninstall = false
            }
          }
        }
      }
    }
  }
}
