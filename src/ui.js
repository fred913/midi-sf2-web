import { clamp } from "./utils.js";

export function createSoundFontProgressOverlay() {
  if (typeof document === "undefined" || typeof document.createElement !== "function") {
    return noopProgress();
  }

  let host = null;
  let label = null;
  let detail = null;
  let fill = null;
  let hideTimer = null;

  function ensure() {
    if (host) {
      return;
    }

    host = document.createElement("div");
    host.style.cssText = [
      "position:fixed",
      "left:50%",
      "bottom:18px",
      "transform:translateX(-50%)",
      "z-index:2147483647",
      "width:min(420px,calc(100vw - 32px))",
      "box-sizing:border-box",
      "padding:12px 14px",
      "border-radius:8px",
      "background:rgba(18,18,22,0.94)",
      "color:#fff",
      "font:13px/1.35 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
      "box-shadow:0 10px 30px rgba(0,0,0,0.28)",
      "pointer-events:none"
    ].join(";");

    label = document.createElement("div");
    label.textContent = "Downloading SoundFont";
    label.style.cssText = "font-weight:600;margin-bottom:6px";

    const track = document.createElement("div");
    track.style.cssText = "height:6px;border-radius:999px;background:rgba(255,255,255,0.18);overflow:hidden";

    fill = document.createElement("div");
    fill.style.cssText = "height:100%;width:0%;border-radius:999px;background:#7dd3fc;transition:width 120ms linear";
    track.appendChild(fill);

    detail = document.createElement("div");
    detail.textContent = "Starting download";
    detail.style.cssText = "margin-top:6px;color:rgba(255,255,255,0.78);font-size:12px";

    host.appendChild(label);
    host.appendChild(track);
    host.appendChild(detail);
  }

  function attach() {
    ensure();
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    if (!host.isConnected) {
      (document.body || document.documentElement).appendChild(host);
    }
  }

  function detach(delay = 700) {
    hideTimer = setTimeout(() => {
      host?.remove();
    }, delay);
  }

  return {
    show() {
      attach();
      label.textContent = "Downloading SoundFont";
      detail.textContent = "Starting download";
      fill.style.width = "0%";
      fill.style.background = "#7dd3fc";
    },
    update(loaded, total) {
      attach();
      if (total > 0) {
        const percent = clamp((loaded / total) * 100, 0, 100);
        fill.style.width = `${percent.toFixed(1)}%`;
        detail.textContent = `${formatBytes(loaded)} / ${formatBytes(total)} (${Math.round(percent)}%)`;
      } else {
        fill.style.width = "100%";
        detail.textContent = `${formatBytes(loaded)} downloaded`;
      }
    },
    finish() {
      attach();
      label.textContent = "SoundFont ready";
      detail.textContent = "Cached for future loads";
      fill.style.width = "100%";
      fill.style.background = "#86efac";
      detach();
    },
    fail(error) {
      attach();
      label.textContent = "SoundFont download failed";
      detail.textContent = error?.message || "Unknown error";
      fill.style.background = "#fb7185";
    }
  };
}

function noopProgress() {
  return {
    show() {},
    update() {},
    finish() {},
    fail() {}
  };
}

export function openSoundFontSettingsPanel(shim) {
  if (typeof document === "undefined" || typeof document.createElement !== "function") {
    return;
  }

  const existing = document.getElementById("web-midi-sf2-settings");
  if (existing) {
    existing.__webMidiSf2Cleanup?.();
    existing.remove();
  }

  const host = document.createElement("div");
  host.id = "web-midi-sf2-settings";
  host.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:2147483646",
    "background:rgba(0,0,0,0.42)",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "padding:18px",
    "box-sizing:border-box",
    "font:14px/1.4 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
    "color:#111"
  ].join(";");

  const panel = document.createElement("div");
  panel.style.cssText = [
    "width:min(680px,100%)",
    "max-height:min(760px,calc(100vh - 36px))",
    "overflow:auto",
    "box-sizing:border-box",
    "border-radius:8px",
    "background:#fff",
    "box-shadow:0 20px 60px rgba(0,0,0,0.34)",
    "padding:18px"
  ].join(";");

  const titleRow = document.createElement("div");
  titleRow.style.cssText = "display:flex;align-items:center;gap:12px;margin-bottom:14px";
  const title = document.createElement("div");
  title.textContent = "SF2 MIDI devices";
  title.style.cssText = "font-size:18px;font-weight:700;flex:1";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.textContent = "Close";
  closeButton.style.cssText = buttonStyle();
  titleRow.append(title, closeButton);

  let statsTimer = null;

  function closePanel() {
    if (statsTimer != null) {
      clearInterval(statsTimer);
      statsTimer = null;
    }
    host.__webMidiSf2Cleanup = null;
    host.remove();
  }

  host.__webMidiSf2Cleanup = closePanel;
  closeButton.addEventListener("click", closePanel);

  const gainRow = document.createElement("label");
  gainRow.style.cssText = [
    "display:grid",
    "grid-template-columns:auto minmax(160px,1fr) 48px",
    "gap:10px",
    "align-items:center",
    "margin-bottom:14px",
    "font-size:13px"
  ].join(";");
  const gainLabel = document.createElement("span");
  gainLabel.textContent = "Output gain";
  const gainInput = document.createElement("input");
  gainInput.type = "range";
  gainInput.min = "0";
  gainInput.max = "1";
  gainInput.step = "0.01";
  gainInput.value = String(shim.getMasterGain());
  const gainValue = document.createElement("span");
  gainValue.style.cssText = "text-align:right;color:#475569;font-variant-numeric:tabular-nums";

  function refreshGainValue() {
    gainValue.textContent = `${Math.round(shim.getMasterGain() * 100)}%`;
  }

  gainInput.addEventListener("input", () => {
    const nextGain = shim.setMasterGain(Number(gainInput.value));
    gainInput.value = String(nextGain);
    refreshGainValue();
  });
  refreshGainValue();
  gainRow.append(gainLabel, gainInput, gainValue);

  const passthroughRow = document.createElement("label");
  passthroughRow.style.cssText = [
    "display:flex",
    "align-items:center",
    "gap:8px",
    "margin-bottom:14px",
    "font-size:13px",
    "cursor:pointer"
  ].join(";");
  const passthroughInput = document.createElement("input");
  passthroughInput.type = "checkbox";
  passthroughInput.checked = shim.getPassthroughRealMidi();
  const passthroughLabel = document.createElement("span");
  passthroughLabel.textContent = "Passthrough real MIDI devices";
  passthroughInput.addEventListener("change", async () => {
    passthroughInput.disabled = true;
    try {
      await shim.setPassthroughRealMidi(passthroughInput.checked);
      setStatus(passthroughInput.checked ? "Real MIDI passthrough enabled" : "Real MIDI passthrough disabled");
      refreshPerformanceStats();
    } catch (error) {
      passthroughInput.checked = shim.getPassthroughRealMidi();
      setStatus(error?.message || "Could not update MIDI passthrough", true);
    } finally {
      passthroughInput.disabled = false;
    }
  });
  passthroughRow.append(passthroughInput, passthroughLabel);

  const voiceLimitsRow = document.createElement("div");
  voiceLimitsRow.style.cssText = [
    "display:grid",
    "grid-template-columns:1fr 1fr",
    "gap:10px",
    "margin-bottom:14px"
  ].join(";");
  const maxVoicesInput = createNumberSettingInput("Max voices", shim.getVoiceLimits().maxVoices, 8, 512);
  const maxVoicesPerChannelInput = createNumberSettingInput("Per channel", shim.getVoiceLimits().maxVoicesPerChannel, 4, 256);

  async function applyVoiceLimitInputs() {
    const limits = shim.setVoiceLimits({
      maxVoices: maxVoicesInput.input.value,
      maxVoicesPerChannel: maxVoicesPerChannelInput.input.value
    });
    maxVoicesInput.input.value = String(limits.maxVoices);
    maxVoicesPerChannelInput.input.value = String(limits.maxVoicesPerChannel);
    setStatus("Voice limits updated");
    refreshPerformanceStats();
  }

  maxVoicesInput.input.addEventListener("change", applyVoiceLimitInputs);
  maxVoicesPerChannelInput.input.addEventListener("change", applyVoiceLimitInputs);
  voiceLimitsRow.append(maxVoicesInput.label, maxVoicesPerChannelInput.label);

  const performanceSection = document.createElement("div");
  performanceSection.style.cssText = [
    "border:1px solid #e2e8f0",
    "border-radius:8px",
    "padding:10px",
    "margin-bottom:14px",
    "background:#f8fafc"
  ].join(";");
  const performanceTitle = document.createElement("div");
  performanceTitle.textContent = "MIDI performance";
  performanceTitle.style.cssText = "font-weight:700;margin-bottom:8px";
  const performanceRows = document.createElement("div");
  performanceRows.style.cssText = "display:flex;flex-direction:column;gap:4px";
  performanceSection.append(performanceTitle, performanceRows);

  let lastPerformanceSnapshot = null;

  function refreshPerformanceStats() {
    const snapshot = shim.getPerformanceStats();
    const previous = lastPerformanceSnapshot;
    const elapsedSeconds = previous ? Math.max(0.001, (snapshot.updatedAt - previous.updatedAt) / 1000) : 1;
    const previousById = new Map((previous?.devices || []).map((device) => [device.id, device]));
    performanceRows.replaceChildren();
    performanceRows.append(createPerformanceHeaderRow());
    performanceRows.append(createPerformanceRow("Total", snapshot.totals, previous?.totals, elapsedSeconds, true));
    for (const device of snapshot.devices) {
      performanceRows.append(createPerformanceRow(device.name, device.stats, previousById.get(device.id)?.stats, elapsedSeconds, false));
    }
    lastPerformanceSnapshot = snapshot;
  }

  function createPerformanceHeaderRow() {
    const row = document.createElement("div");
    row.style.cssText = performanceRowStyle(true);
    for (const text of ["Device", "Events/s", "Notes/s", "Drop evt/s", "Drop notes/s", "Voices"]) {
      const cell = document.createElement("div");
      cell.textContent = text;
      cell.style.cssText = "font-size:11px;color:#64748b;font-weight:700";
      row.append(cell);
    }
    return row;
  }

  function createPerformanceRow(name, stats, previousStats, elapsedSeconds, total = false) {
    const row = document.createElement("div");
    row.style.cssText = performanceRowStyle(false);
    const previousForRate = previousStats || stats;
    const nameCell = document.createElement("div");
    nameCell.textContent = name;
    nameCell.style.cssText = [
      "min-width:0",
      "overflow:hidden",
      "text-overflow:ellipsis",
      "white-space:nowrap",
      total ? "font-weight:700" : "font-weight:600"
    ].join(";");
    row.append(
      nameCell,
      performanceMetricCell(formatRate(perSecond(stats.midiEvents, previousForRate.midiEvents, elapsedSeconds))),
      performanceMetricCell(formatRate(perSecond(stats.playedNotes, previousForRate.playedNotes, elapsedSeconds))),
      performanceMetricCell(formatRate(perSecond(stats.droppedMidiEvents, previousForRate.droppedMidiEvents, elapsedSeconds)), stats.droppedMidiEvents > previousForRate.droppedMidiEvents),
      performanceMetricCell(formatRate(perSecond(stats.droppedNotes, previousForRate.droppedNotes, elapsedSeconds)), stats.droppedNotes > previousForRate.droppedNotes),
      performanceMetricCell(String(stats.activeVoices || 0))
    );
    return row;
  }

  function performanceMetricCell(text, warning = false) {
    const cell = document.createElement("div");
    cell.textContent = text;
    cell.style.cssText = [
      "font-variant-numeric:tabular-nums",
      "text-align:right",
      warning ? "color:#be123c;font-weight:700" : "color:#0f172a"
    ].join(";");
    return cell;
  }

  refreshPerformanceStats();
  statsTimer = setInterval(refreshPerformanceStats, 1000);

  const dropZone = document.createElement("div");
  dropZone.style.cssText = [
    "border:1px dashed #8aa0b8",
    "border-radius:8px",
    "padding:18px",
    "background:#f8fafc",
    "text-align:center",
    "margin-bottom:12px"
  ].join(";");
  dropZone.textContent = "Drop an .sf2 file here";

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".sf2,.sf3,audio/x-soundfont";
  fileInput.style.display = "none";

  const selectFileButton = document.createElement("button");
  selectFileButton.type = "button";
  selectFileButton.textContent = "Install SF2 file";
  selectFileButton.style.cssText = buttonStyle("primary");
  selectFileButton.addEventListener("click", () => fileInput.click());

  const urlRow = document.createElement("div");
  urlRow.style.cssText = "display:flex;gap:8px;margin:12px 0 16px;align-items:center";
  const urlInput = document.createElement("input");
  urlInput.type = "url";
  urlInput.placeholder = "Paste SF2 URL";
  urlInput.style.cssText = [
    "flex:1",
    "box-sizing:border-box",
    "border:1px solid #cbd5e1",
    "border-radius:6px",
    "padding:8px 10px",
    "font:inherit"
  ].join(";");
  const installUrlButton = document.createElement("button");
  installUrlButton.type = "button";
  installUrlButton.textContent = "Install URL";
  installUrlButton.style.cssText = buttonStyle();
  urlRow.append(urlInput, installUrlButton);

  const status = document.createElement("div");
  status.style.cssText = "min-height:20px;color:#475569;margin-bottom:10px";

  const devicesTitle = document.createElement("div");
  devicesTitle.textContent = "Installed MIDI devices";
  devicesTitle.style.cssText = "font-weight:700;margin:12px 0 8px";

  const deviceList = document.createElement("div");
  deviceList.style.cssText = "display:flex;flex-direction:column;gap:8px";

  async function installFile(file) {
    if (!file) {
      return;
    }
    setStatus(`Installing ${file.name}...`);
    try {
      const arrayBuffer = await file.arrayBuffer();
      await shim.installSoundFontFromArrayBuffer(arrayBuffer, {
        fileName: file.name,
        name: file.name,
        source: "file"
      });
      setStatus(`Installed ${file.name}`);
      refreshDevices();
      refreshPerformanceStats();
    } catch (error) {
      setStatus(error?.message || "Install failed", true);
    }
  }

  function setStatus(message, error = false) {
    status.textContent = message;
    status.style.color = error ? "#be123c" : "#475569";
  }

  function refreshDevices() {
    deviceList.replaceChildren();
    const devices = shim.listSoundFontDevices();
    for (const device of devices) {
      const row = document.createElement("div");
      row.style.cssText = [
        "display:grid",
        "grid-template-columns:minmax(0,1fr) auto auto",
        "gap:8px",
        "align-items:center",
        "border:1px solid #e2e8f0",
        "border-radius:8px",
        "padding:10px"
      ].join(";");

      const info = document.createElement("div");
      info.style.cssText = "min-width:0";
      const name = document.createElement("div");
      name.textContent = device.name;
      name.style.cssText = "font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      const meta = document.createElement("div");
      meta.textContent = device.builtIn ? "Built-in device" : `Custom device: ${device.id}`;
      meta.style.cssText = "font-size:12px;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      info.append(name, meta);

      const renameButton = document.createElement("button");
      renameButton.type = "button";
      renameButton.textContent = "Rename";
      renameButton.disabled = device.builtIn;
      renameButton.style.cssText = buttonStyle();
      renameButton.addEventListener("click", async () => {
        const nextName = prompt("Device name", device.name);
        if (!nextName) {
          return;
        }
        await shim.renameSoundFontDevice(device.id, nextName);
        setStatus("Renamed device");
        refreshDevices();
        refreshPerformanceStats();
      });

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.textContent = "Uninstall";
      removeButton.disabled = device.builtIn;
      removeButton.style.cssText = buttonStyle("danger");
      removeButton.addEventListener("click", async () => {
        if (!confirm(`Uninstall ${device.name}?`)) {
          return;
        }
        await shim.uninstallSoundFont(device.id);
        setStatus("Uninstalled device");
        refreshDevices();
        refreshPerformanceStats();
      });

      row.append(info, renameButton, removeButton);
      deviceList.append(row);
    }
  }

  dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.style.background = "#e0f2fe";
  });
  dropZone.addEventListener("dragleave", () => {
    dropZone.style.background = "#f8fafc";
  });
  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.style.background = "#f8fafc";
    installFile(event.dataTransfer?.files?.[0]);
  });
  fileInput.addEventListener("change", () => installFile(fileInput.files?.[0]));
  installUrlButton.addEventListener("click", async () => {
    const url = urlInput.value.trim();
    if (!url) {
      setStatus("Paste an SF2 URL first.", true);
      return;
    }
    setStatus("Downloading SF2...");
    try {
      await shim.installSoundFontFromUrl(url);
      setStatus("Installed URL SF2");
      urlInput.value = "";
      refreshDevices();
      refreshPerformanceStats();
    } catch (error) {
      setStatus(error?.message || "Install failed", true);
    }
  });
  host.addEventListener("click", (event) => {
    if (event.target === host) {
      closePanel();
    }
  });

  panel.append(titleRow, gainRow, passthroughRow, voiceLimitsRow, performanceSection, dropZone, selectFileButton, fileInput, urlRow, status, devicesTitle, deviceList);
  host.append(panel);
  document.documentElement.appendChild(host);
  refreshDevices();
}

function createNumberSettingInput(text, value, min, max) {
  const label = document.createElement("label");
  label.style.cssText = "display:flex;flex-direction:column;gap:4px;font-size:12px;color:#475569";
  const title = document.createElement("span");
  title.textContent = text;
  const input = document.createElement("input");
  input.type = "number";
  input.min = String(min);
  input.max = String(max);
  input.step = "1";
  input.value = String(value);
  input.style.cssText = [
    "box-sizing:border-box",
    "width:100%",
    "border:1px solid #cbd5e1",
    "border-radius:6px",
    "padding:7px 9px",
    "font:inherit"
  ].join(";");
  label.append(title, input);
  return { label, input };
}

function buttonStyle(variant = "normal") {
  const background = variant === "primary" ? "#0f172a" : variant === "danger" ? "#fff1f2" : "#fff";
  const color = variant === "primary" ? "#fff" : variant === "danger" ? "#be123c" : "#0f172a";
  const border = variant === "primary" ? "#0f172a" : variant === "danger" ? "#fecdd3" : "#cbd5e1";
  return [
    "box-sizing:border-box",
    `background:${background}`,
    `color:${color}`,
    `border:1px solid ${border}`,
    "border-radius:6px",
    "padding:7px 10px",
    "font:inherit",
    "cursor:pointer"
  ].join(";");
}

function performanceRowStyle(header = false) {
  return [
    "display:grid",
    "grid-template-columns:minmax(92px,1.4fr) repeat(5,minmax(54px,auto))",
    "gap:8px",
    "align-items:center",
    "font-size:12px",
    header ? "padding-bottom:2px" : "padding:3px 0"
  ].join(";");
}

function perSecond(current = 0, previous = 0, elapsedSeconds = 1) {
  return Math.max(0, (current - previous) / Math.max(0.001, elapsedSeconds));
}

function formatRate(value) {
  if (value >= 100) {
    return String(Math.round(value));
  }
  if (value >= 10) {
    return value.toFixed(1);
  }
  return value.toFixed(2);
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function registerSettingsMenu(shim) {
  const register = typeof GM_registerMenuCommand === "function"
    ? GM_registerMenuCommand
    : globalThis.GM_registerMenuCommand;
  if (typeof register === "function") {
    register("SF2 Settings", () => shim.openSettings());
  }
}
