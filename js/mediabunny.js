(function () {
    const MB = globalThis.Mediabunny;
    const state = {
        queue: [],
        processing: false,
        manualQueue: [],
        tasks: new Map(),
        port: null,
        topLevel: window.top === window,
    };

    const ui = {
        status: document.getElementById("status"),
        currentJob: document.getElementById("currentJob"),
        manualSummary: document.getElementById("manualSummary"),
        manualQueue: document.getElementById("manualQueue"),
        processManualQueue: document.getElementById("processManualQueue"),
        clearManualQueue: document.getElementById("clearManualQueue"),
        log: document.getElementById("log"),
    };

    if (!MB) {
        setStatus("Mediabunny failed to load.");
        appendLog("Mediabunny global was not found.");
        return;
    }

    bindEvents();
    renderManualQueue();
    setStatus("Ready.");

    if (state.topLevel) {
        connectRunnerPort();
    }

    window.addEventListener("message", function (event) {
        const job = normalizeJob(event.data);
        if (!job) { return; }
        enqueueJob(job);
    });

    function bindEvents() {
        ui.processManualQueue.addEventListener("click", function () {
            void processManualQueue();
        });
        ui.clearManualQueue.addEventListener("click", function () {
            state.manualQueue.splice(0);
            renderManualQueue();
            setStatus("Cleared staged files.");
        });
    }

    function connectRunnerPort() {
        state.port = chrome.runtime.connect(chrome.runtime.id, { name: "Mediabunny" });
        state.port.onMessage.addListener(function (message) {
            if (!message || message.type != "job" || !message.job) { return; }
            enqueueJob(normalizeJob(message.job));
        });
        state.port.onDisconnect.addListener(function () {
            state.port = null;
            setStatus("Reconnecting to background...");
            setTimeout(connectRunnerPort, 1000);
        });
        state.port.postMessage({ type: "ready" });
    }

    function enqueueJob(job) {
        if (!job) { return; }
        state.queue.push(job);
        void pumpQueue();
    }

    async function pumpQueue() {
        if (state.processing) { return; }
        state.processing = true;
        try {
            while (state.queue.length) {
                const job = state.queue.shift();
                await handleJob(job);
            }
        } finally {
            state.processing = false;
            renderManualQueue();
            if (!state.queue.length && !state.manualQueue.length && !state.tasks.size) {
                setCurrentJob("");
                setStatus("Ready.");
            }
        }
    }

    async function handleJob(job) {
        if (!job) { return; }
        if (job.action == "openFFmpeg") {
            setCurrentJob("");
            setStatus(job.extra || "Waiting for media...");
            appendLog("Opened local Mediabunny runner.");
            return;
        }

        setCurrentJob(job.title || job.output || job.action);
        setStatus(`Preparing ${job.action}...`);

        let files;
        try {
            files = await resolveJobFiles(job);
        } catch (error) {
            handleJobError(job, error);
            return;
        }

        notifyAccepted(job, files);

        if (job.action == "addFile" && !job.taskId && job.quantity <= files.length) {
            state.manualQueue.push(...files.map(file => ({ ...file, action: job.action })));
            renderManualQueue();
            setStatus(`Staged ${state.manualQueue.length} file${state.manualQueue.length > 1 ? "s" : ""}.`);
            appendLog(`Staged ${files.length} file${files.length > 1 ? "s" : ""} for manual merge.`);
            notifyDone(new Set(files.map(file => file.tabId).filter(Boolean)), job);
            return;
        }

        if (job.action == "merge" || job.action == "catchMerge" || job.action == "addFile") {
            await collectTask(job, files);
            return;
        }

        try {
            const result = await buildFinalOutput(job.action, files, job);
            await downloadResult(result.blob, result.fileName);
            appendLog(`Saved ${result.fileName}.`);
            notifyDone(new Set(files.map(file => file.tabId).filter(Boolean)), job);
            setStatus(`Saved ${result.fileName}.`);
        } catch (error) {
            handleJobError(job, error);
        }
    }

    async function collectTask(job, files) {
        const taskKey = job.taskId ? `${job.action}:${job.taskId}` : `${job.action}:${job.messageId}`;
        const task = state.tasks.get(taskKey) ?? {
            action: job.action,
            taskId: job.taskId,
            title: job.title,
            output: job.output,
            expectedQuantity: Math.max(job.quantity, files.length),
            files: [],
            tabIds: new Set(),
        };

        task.expectedQuantity = Math.max(task.expectedQuantity, job.quantity, task.files.length + files.length);
        task.files.push(...files);
        files.forEach(file => {
            if (file.tabId) {
                task.tabIds.add(file.tabId);
            }
        });
        state.tasks.set(taskKey, task);

        if (task.files.length < task.expectedQuantity) {
            renderManualQueue();
            setStatus(`Waiting for ${task.expectedQuantity - task.files.length} more file${task.expectedQuantity - task.files.length > 1 ? "s" : ""}...`);
            appendLog(`Collected ${task.files.length}/${task.expectedQuantity} file(s) for task ${task.taskId || taskKey}.`);
            return;
        }

        state.tasks.delete(taskKey);
        renderManualQueue();

        try {
            const result = await buildFinalOutput(task.action, task.files, {
                title: task.title,
                output: task.output,
                action: task.action,
                taskId: task.taskId,
                quantity: task.expectedQuantity,
            });
            await downloadResult(result.blob, result.fileName);
            appendLog(`Saved ${result.fileName}.`);
            notifyDone(task.tabIds, job);
            setStatus(`Saved ${result.fileName}.`);
        } catch (error) {
            handleJobError(job, error, task.tabIds);
        }
    }

    async function processManualQueue() {
        if (!state.manualQueue.length) { return; }
        const files = state.manualQueue.splice(0);
        renderManualQueue();
        setCurrentJob("Manual queue");
        setStatus("Building final file...");
        try {
            const action = files.length > 1 ? "merge" : "transcode";
            const result = await buildFinalOutput(action, files, {
                action: action,
                title: files.length > 1 ? "merged-media" : files[0].name,
                output: files.length > 1 ? "merged-media" : files[0].name,
            });
            await downloadResult(result.blob, result.fileName);
            appendLog(`Saved ${result.fileName}.`);
            notifyDone(new Set(files.map(file => file.tabId).filter(Boolean)), { taskId: null });
            setStatus(`Saved ${result.fileName}.`);
        } catch (error) {
            handleJobError({ action: "merge" }, error, new Set(files.map(file => file.tabId).filter(Boolean)));
        }
    }

    function normalizeJob(message) {
        if (!message) { return null; }
        if (message.type == "job" && message.job) {
            message = message.job;
        }
        if (message.Message && message.Message != "ffmpeg" && message.Message != "catCatchFFmpeg") {
            return null;
        }
        if (!message.action) { return null; }

        const files = [];
        if (Array.isArray(message.files)) {
            message.files.forEach((file, index) => {
                files.push({
                    ...file,
                    index: file.index ?? message.index ?? index,
                });
            });
        } else if (message.data !== undefined) {
            files.push({
                data: message.data,
                name: message.name,
                type: message.type,
                index: message.index ?? 0,
            });
        }

        return {
            action: message.action,
            files: files,
            taskId: message.taskId != null ? String(message.taskId) : "",
            quantity: Math.max(parseInt(message.quantity ?? files.length, 10) || files.length || 1, files.length || 1),
            tabId: Number(message.tabId ?? 0),
            title: message.title ?? message.output ?? "",
            output: message.output ?? message.title ?? "",
            extra: message.extra ?? "",
            messageId: createMessageId(),
        };
    }

    async function resolveJobFiles(job) {
        const files = [];
        for (const file of job.files) {
            const blob = await resolveBlob(file);
            const name = file.name || job.output || job.title || `input-${files.length + 1}`;
            files.push({
                ...file,
                blob: blob,
                name: name,
                tabId: job.tabId,
            });
        }
        return files;
    }

    async function resolveBlob(file) {
        let blob;
        if (file.data instanceof Blob) {
            blob = file.data;
        } else if (file.data instanceof ArrayBuffer || ArrayBuffer.isView(file.data)) {
            blob = new Blob([file.data], { type: getMimeType(file) });
        } else if (typeof file.data == "string") {
            const response = await fetch(file.data);
            if (!response.ok) {
                throw new Error(`Failed to read ${file.name || "input"}: ${response.status}`);
            }
            blob = await response.blob();
        } else {
            throw new Error("Unsupported input payload.");
        }

        const mimeType = getMimeType(file);
        if (mimeType && !blob.type) {
            blob = blob.slice(0, blob.size, mimeType);
        }
        return blob;
    }

    function getMimeType(file) {
        if (typeof file.type == "string" && file.type.includes("/")) {
            return file.type;
        }
        return "";
    }

    async function buildFinalOutput(action, files, job) {
        if (!files.length) {
            throw new Error("No files were provided.");
        }
        if (action == "onlyAudio") {
            return convertSingleFile(files[0], job, true);
        }
        if (action == "transcode") {
            return convertSingleFile(files[0], job, false);
        }
        return mergeFiles(files, job);
    }

    async function convertSingleFile(file, job, onlyAudio) {
        const input = new MB.Input({
            source: new MB.BlobSource(file.blob),
            formats: MB.ALL_FORMATS,
        });
        try {
            const target = new MB.BufferTarget();
            const output = new MB.Output({
                format: new MB.Mp4OutputFormat(),
                target: target,
            });
            const conversion = await MB.Conversion.init({
                input: input,
                output: output,
                video: onlyAudio ? { discard: true } : undefined,
            });
            if (!conversion.isValid) {
                throw new Error(getDiscardReason(conversion.discardedTracks));
            }
            conversion.onProgress = function (progress) {
                setStatus(`${onlyAudio ? "Extracting audio" : "Converting media"} ${Math.round(progress * 100)}%...`);
            };
            await conversion.execute();

            if (!target.buffer) {
                throw new Error("Mediabunny did not produce an output buffer.");
            }

            const extension = inferExtension(job, onlyAudio ? "m4a" : "mp4");
            return {
                blob: new Blob([target.buffer], { type: onlyAudio ? "audio/mp4" : "video/mp4" }),
                fileName: buildOutputFileName(job, file.name, extension),
            };
        } finally {
            input.dispose();
        }
    }

    async function mergeFiles(files, job) {
        if (files.length == 1) {
            return convertSingleFile(files[0], job, false);
        }

        const inputs = [];
        try {
            const selected = {
                video: null,
                audio: null,
            };

            for (const file of files) {
                const input = new MB.Input({
                    source: new MB.BlobSource(file.blob),
                    formats: MB.ALL_FORMATS,
                });
                inputs.push(input);

                if (!selected.video) {
                    const videoTrack = await input.getPrimaryVideoTrack();
                    if (videoTrack) {
                        selected.video = { track: videoTrack, file: file };
                    }
                }
                if (!selected.audio) {
                    const audioTrack = await input.getPrimaryAudioTrack();
                    if (audioTrack) {
                        selected.audio = { track: audioTrack, file: file };
                    }
                }
            }

            if (!selected.video && !selected.audio) {
                throw new Error("No readable audio or video tracks were found.");
            }

            const outputFormat = new MB.Mp4OutputFormat();
            const target = new MB.BufferTarget();
            const output = new MB.Output({
                format: outputFormat,
                target: target,
            });
            const pending = [];

            if (selected.video) {
                const sourceCodec = selected.video.track.codec;
                if (!sourceCodec || !outputFormat.getSupportedVideoCodecs().includes(sourceCodec)) {
                    throw new Error(`Video codec '${sourceCodec || "unknown"}' is not supported for MP4 remuxing.`);
                }
                const videoSource = new MB.EncodedVideoPacketSource(sourceCodec);
                output.addVideoTrack(videoSource, {
                    rotation: selected.video.track.rotation,
                    languageCode: selected.video.track.languageCode != "und" ? selected.video.track.languageCode : undefined,
                    name: selected.video.track.name ?? undefined,
                });
                pending.push(copyTrackPackets(selected.video.track, videoSource, true));
            }

            if (selected.audio) {
                const sourceCodec = selected.audio.track.codec;
                if (!sourceCodec || !outputFormat.getSupportedAudioCodecs().includes(sourceCodec)) {
                    throw new Error(`Audio codec '${sourceCodec || "unknown"}' is not supported for MP4 remuxing.`);
                }
                const audioSource = new MB.EncodedAudioPacketSource(sourceCodec);
                output.addAudioTrack(audioSource, {
                    languageCode: selected.audio.track.languageCode != "und" ? selected.audio.track.languageCode : undefined,
                    name: selected.audio.track.name ?? undefined,
                });
                pending.push(copyTrackPackets(selected.audio.track, audioSource, false));
            }

            await output.start();
            await Promise.all(pending);
            await output.finalize();

            if (!target.buffer) {
                throw new Error("Mediabunny did not produce an output buffer.");
            }

            const extension = inferExtension(job, selected.video ? "mp4" : "m4a");
            return {
                blob: new Blob([target.buffer], { type: selected.video ? "video/mp4" : "audio/mp4" }),
                fileName: buildOutputFileName(job, files[0].name, extension),
            };
        } finally {
            inputs.forEach(function (input) {
                try {
                    input.dispose();
                } catch (e) { return; }
            });
        }
    }

    async function copyTrackPackets(track, source, verifyKeyPackets) {
        const sink = new MB.EncodedPacketSink(track);
        const meta = track.isVideoTrack()
            ? { decoderConfig: await track.getDecoderConfig() ?? undefined }
            : { decoderConfig: await track.getDecoderConfig() ?? undefined };
        const firstTimestamp = await track.getFirstTimestamp();

        for await (const packet of sink.packets(undefined, undefined, verifyKeyPackets ? { verifyKeyPackets: true } : undefined)) {
            const adjustedPacket = packet.clone({
                timestamp: Math.max(packet.timestamp - firstTimestamp, 0),
            });
            await source.add(adjustedPacket, meta);
        }
        source.close();
    }

    async function downloadResult(blob, fileName) {
        const objectUrl = URL.createObjectURL(blob);
        try {
            await new Promise(function (resolve, reject) {
                if (!chrome.downloads || !chrome.downloads.download) {
                    const link = document.createElement("a");
                    link.href = objectUrl;
                    link.download = fileName;
                    link.click();
                    resolve();
                    return;
                }
                chrome.downloads.download({
                    url: objectUrl,
                    filename: fileName,
                }, function (downloadId) {
                    if (downloadId) {
                        resolve(downloadId);
                        return;
                    }
                    if (chrome.runtime.lastError?.message == "Invalid filename") {
                        chrome.downloads.download({
                            url: objectUrl,
                            filename: sanitizeFileName(fileName),
                        }, function (fallbackId) {
                            if (fallbackId) {
                                resolve(fallbackId);
                                return;
                            }
                            reject(new Error(chrome.runtime.lastError?.message || "Download failed."));
                        });
                        return;
                    }
                    reject(new Error(chrome.runtime.lastError?.message || "Download failed."));
                });
            });
        } finally {
            setTimeout(function () {
                URL.revokeObjectURL(objectUrl);
            }, 60000);
        }
    }

    function notifyAccepted(job, files) {
        files.forEach(function (file) {
            if (!file.tabId) { return; }
            chrome.runtime.sendMessage({
                Message: "catCatchFFmpegResult",
                state: "ok",
                tabId: file.tabId,
                taskId: job.taskId,
                index: file.index ?? 0,
            });
        });
    }

    function notifyDone(tabIds, job) {
        tabIds.forEach(function (tabId) {
            chrome.runtime.sendMessage({
                Message: "catCatchFFmpegResult",
                state: "done",
                tabId: tabId,
                taskId: job.taskId,
            });
        });
    }

    function handleJobError(job, error, tabIds = null) {
        const message = error instanceof Error ? error.message : String(error);
        setStatus(`Failed: ${message}`);
        appendLog(`Failed ${job.action || "job"}: ${message}`);
        const targets = tabIds ?? new Set(job.tabId ? [job.tabId] : []);
        targets.forEach(function (tabId) {
            chrome.runtime.sendMessage({
                Message: "catCatchFFmpegResult",
                state: "error",
                tabId: tabId,
                taskId: job.taskId,
                error: message,
            });
        });
    }

    function getDiscardReason(discardedTracks) {
        if (!discardedTracks?.length) {
            return "Conversion could not be initialized.";
        }
        return discardedTracks.map(function (item) {
            return `${item.track.type}:${item.reason}`;
        }).join(", ");
    }

    function inferExtension(job, fallbackExtension) {
        const preferred = job.output || job.title || "";
        const match = preferred.match(/\.([a-zA-Z0-9]{1,8})$/);
        return match ? match[1].toLowerCase() : fallbackExtension;
    }

    function buildOutputFileName(job, fallbackName, extension) {
        const preferred = job.output || job.title || fallbackName || "mediabunny-output";
        const cleanName = sanitizeFileName(preferred);
        if (/\.[a-zA-Z0-9]{1,8}$/.test(cleanName)) {
            return cleanName;
        }
        const baseName = cleanName.replace(/\.[a-zA-Z0-9]{1,8}$/, "") || "mediabunny-output";
        return `${baseName}.${extension}`;
    }

    function sanitizeFileName(fileName) {
        const cleaned = String(fileName || "mediabunny-output")
            .replace(/[<>:"/\\|?*~]/g, "_")
            .replace(/\s+/g, " ")
            .trim();
        return cleaned || "mediabunny-output";
    }

    function createMessageId() {
        if (globalThis.crypto?.randomUUID) {
            return globalThis.crypto.randomUUID();
        }
        return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function renderManualQueue() {
        const stagedCount = state.manualQueue.length;
        const taskCount = Array.from(state.tasks.values()).reduce(function (count, task) {
            return count + task.files.length;
        }, 0);

        ui.manualSummary.textContent = stagedCount
            ? `Staged files: ${stagedCount}`
            : (taskCount ? `Waiting task inputs: ${taskCount}` : "No staged files.");

        ui.processManualQueue.disabled = stagedCount === 0;
        ui.clearManualQueue.disabled = stagedCount === 0;

        if (!stagedCount) {
            ui.manualQueue.innerHTML = "";
            return;
        }

        const list = document.createElement("ul");
        state.manualQueue.forEach(function (file) {
            const item = document.createElement("li");
            const label = [file.name, file.type && !file.type.includes("/") ? `(${file.type})` : ""]
                .filter(Boolean)
                .join(" ");
            item.textContent = label;
            list.appendChild(item);
        });

        ui.manualQueue.innerHTML = "";
        ui.manualQueue.appendChild(list);
    }

    function setStatus(text) {
        ui.status.textContent = text;
    }

    function setCurrentJob(text) {
        ui.currentJob.textContent = text ? `Current job: ${text}` : "";
    }

    function appendLog(text) {
        const lines = ui.log.value ? ui.log.value.split("\n") : [];
        lines.push(`[${new Date().toLocaleTimeString()}] ${text}`);
        while (lines.length > 30) {
            lines.shift();
        }
        ui.log.value = lines.join("\n");
        ui.log.scrollTop = ui.log.scrollHeight;
    }
})();
