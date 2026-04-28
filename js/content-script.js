(function () {
    var _videoObj = [];
    var _videoSrc = [];
    var _key = new Set();
    var _mediabunnyFrame = null;
    var _mediabunnyFrameReady = false;
    var _mediabunnyFrameCallbacks = [];
    var _mediabunnyFrameQueue = [];

    function ensureMediabunnyFrame() {
        return new Promise(function (resolve) {
            if (_mediabunnyFrameReady && _mediabunnyFrame?.contentWindow) {
                resolve();
                return;
            }
            _mediabunnyFrameCallbacks.push(resolve);
            if (_mediabunnyFrame) { return; }

            _mediabunnyFrame = document.createElement("iframe");
            _mediabunnyFrame.src = chrome.runtime.getURL("mediabunny.html?embed=1");
            _mediabunnyFrame.setAttribute("aria-hidden", "true");
            _mediabunnyFrame.style.cssText = [
                "position:fixed",
                "right:0",
                "bottom:0",
                "width:0",
                "height:0",
                "border:0",
                "opacity:0",
                "pointer-events:none",
                "z-index:-2147483648"
            ].join(";");
            _mediabunnyFrame.onload = function () {
                _mediabunnyFrameReady = true;
                _mediabunnyFrameCallbacks.splice(0).forEach(function (callback) { callback(); });
                while (_mediabunnyFrameQueue.length) {
                    _mediabunnyFrame.contentWindow.postMessage(_mediabunnyFrameQueue.shift(), "*");
                }
            };

            appendMediabunnyFrame();
        });
    }

    function appendMediabunnyFrame() {
        const root = document.documentElement || document.body;
        if (!root) {
            setTimeout(appendMediabunnyFrame, 50);
            return;
        }
        root.appendChild(_mediabunnyFrame);
    }

    async function postMediabunnyJob(message) {
        const job = await prepareMediabunnyJob(message);
        await ensureMediabunnyFrame();
        if (_mediabunnyFrameReady && _mediabunnyFrame?.contentWindow) {
            _mediabunnyFrame.contentWindow.postMessage(job, "*");
            return;
        }
        _mediabunnyFrameQueue.push(job);
    }

    async function prepareMediabunnyJob(message) {
        const job = { ...message };
        job.Message ??= "catCatchFFmpeg";
        job.action ??= job.use;
        if (!Array.isArray(job.files)) {
            return job;
        }

        job.quantity = Math.max(parseInt(job.quantity ?? job.files.length, 10) || job.files.length || 1, job.files.length || 1);
        job.files = await Promise.all(job.files.map(async function (file, index) {
            const next = {
                ...file,
                index: file.index ?? job.index ?? index,
                type: file.type ?? job.type,
            };
            if (typeof next.data == "string") {
                try {
                    const response = await fetch(next.data);
                    if (response.ok) {
                        next.data = await response.blob();
                    }
                } catch (e) {
                    console.log(e);
                }
            }
            return next;
        }));
        return job;
    }

    chrome.runtime.onMessage.addListener(function (Message, sender, sendResponse) {
        if (chrome.runtime.lastError) { return; }
        // 获取页面视频对象
        if (Message.Message == "getVideoState") {
            let videoObj = [];
            let videoSrc = [];
            document.querySelectorAll("video, audio").forEach(function (video) {
                if (video.currentSrc != "" && video.currentSrc != undefined) {
                    videoObj.push(video);
                    videoSrc.push(video.currentSrc);
                }
            });
            const iframe = document.querySelectorAll("iframe");
            if (iframe.length > 0) {
                iframe.forEach(function (iframe) {
                    if (iframe.contentDocument == null) { return true; }
                    iframe.contentDocument.querySelectorAll("video, audio").forEach(function (video) {
                        if (video.currentSrc != "" && video.currentSrc != undefined) {
                            videoObj.push(video);
                            videoSrc.push(video.currentSrc);
                        }
                    });
                });
            }
            if (videoObj.length > 0) {
                if (videoObj.length !== _videoObj.length || videoSrc.toString() !== _videoSrc.toString()) {
                    _videoSrc = videoSrc;
                    _videoObj = videoObj;
                }
                Message.index = Message.index == -1 ? 0 : Message.index;
                const video = videoObj[Message.index];
                const timePCT = video.currentTime / video.duration * 100;
                sendResponse({
                    time: timePCT,
                    currentTime: video.currentTime,
                    duration: video.duration,
                    volume: video.volume,
                    count: _videoObj.length,
                    src: _videoSrc,
                    paused: video.paused,
                    loop: video.loop,
                    speed: video.playbackRate,
                    muted: video.muted,
                    type: video.tagName.toLowerCase()
                });
                return true;
            }
            sendResponse({ count: 0 });
            return true;
        }
        // 速度控制
        if (Message.Message == "speed") {
            _videoObj[Message.index].playbackRate = Message.speed;
            return true;
        }
        // 画中画
        if (Message.Message == "pip") {
            if (document.pictureInPictureElement) {
                try { document.exitPictureInPicture(); } catch (e) { return true; }
                sendResponse({ state: false });
                return true;
            }
            try { _videoObj[Message.index].requestPictureInPicture(); } catch (e) { return true; }
            sendResponse({ state: true });
            return true;
        }
        // 全屏
        if (Message.Message == "fullScreen") {
            if (document.fullscreenElement) {
                try { document.exitFullscreen(); } catch (e) { return true; }
                sendResponse({ state: false });
                return true;
            }
            setTimeout(function () {
                try { _videoObj[Message.index].requestFullscreen(); } catch (e) { return true; }
            }, 500);
            sendResponse({ state: true });
            return true;
        }
        // 播放
        if (Message.Message == "play") {
            _videoObj[Message.index].play();
            return true;
        }
        // 暂停
        if (Message.Message == "pause") {
            _videoObj[Message.index].pause();
            return true;
        }
        // 循环播放
        if (Message.Message == "loop") {
            _videoObj[Message.index].loop = Message.action;
            return true;
        }
        // 设置音量
        if (Message.Message == "setVolume") {
            _videoObj[Message.index].volume = Message.volume;
            sendResponse("ok");
            return true;
        }
        // 静音
        if (Message.Message == "muted") {
            _videoObj[Message.index].muted = Message.action;
            return true;
        }
        // 设置视频进度
        if (Message.Message == "setTime") {
            const time = Message.time * _videoObj[Message.index].duration / 100;
            _videoObj[Message.index].currentTime = time;
            sendResponse("ok");
            return true;
        }
        // 截图视频图片
        if (Message.Message == "screenshot") {
            try {
                let video = _videoObj[Message.index];
                let canvas = document.createElement("canvas");
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
                let link = document.createElement("a");
                link.href = canvas.toDataURL("image/jpeg");
                link.download = `${location.hostname}-${secToTime(video.currentTime)}.jpg`;
                link.click();
                canvas = null;
                link = null;
                sendResponse("ok");
                return true;
            } catch (e) { console.log(e); return true; }
        }
        if (Message.Message == "getKey") {
            sendResponse(Array.from(_key));
            return true;
        }
        if (Message.Message == "ffmpeg") {
            postMediabunnyJob(Message)
                .then(function () { sendResponse("ok"); })
                .catch(function (error) {
                    console.log(error);
                    sendResponse({ error: String(error) });
                });
            return true;
        }
        if (Message.Message == "getPage") {
            if (Message.find) {
                const DOM = document.querySelector(Message.find);
                DOM ? sendResponse(DOM.innerHTML) : sendResponse("");
                return true;
            }
            sendResponse(document.documentElement.outerHTML);
            return true;
        }
    });

    // Heart Beat
    var Port;
    function connect() {
        Port = chrome.runtime.connect(chrome.runtime.id, { name: "HeartBeat" });
        Port.postMessage("HeartBeat");
        Port.onMessage.addListener(function (message, Port) { return true; });
        Port.onDisconnect.addListener(connect);
    }
    connect();

    function secToTime(sec) {
        let time = "";
        let hour = Math.floor(sec / 3600);
        let min = Math.floor((sec % 3600) / 60);
        sec = Math.floor(sec % 60);
        if (hour > 0) { time = hour + "'"; }
        if (min < 10) { time += "0"; }
        time += min + "'";
        if (sec < 10) { time += "0"; }
        time += sec;
        return time;
    }
    window.addEventListener("message", (event) => {
        if (!event.data || !event.data.action) { return; }
        if (event.data.action == "catCatchAddMedia") {
            if (!event.data.url) { return; }
            chrome.runtime.sendMessage({
                Message: "addMedia",
                url: event.data.url,
                href: event.data.href ?? event.source.location.href,
                extraExt: event.data.ext,
                mime: event.data.mime,
                requestHeaders: { referer: event.data.referer },
                requestId: event.data.requestId
            });
        }
        if (event.data.action == "catCatchAddKey") {
            let key = event.data.key;
            if (key instanceof ArrayBuffer || key instanceof Array) {
                key = ArrayToBase64(key);
            }
            if (_key.has(key)) { return; }
            _key.add(key);
            chrome.runtime.sendMessage({
                Message: "send2local",
                action: "addKey",
                data: key,
            });
            chrome.runtime.sendMessage({
                Message: "popupAddKey",
                data: key,
                url: event.data.url,
            });
        }
        if (event.data.action == "catCatchFFmpeg") {
            if (!event.data.use ||
                !event.data.files ||
                !(event.data.files instanceof Array) ||
                event.data.files.length == 0
            ) { return; }
            event.data.title = event.data.title ?? document.title ?? new Date().getTime().toString();
            event.data.title = event.data.title.replaceAll('"', "").replaceAll("'", "").replaceAll(" ", "");
            let data = {
                Message: event.data.action,
                action: event.data.use,
                files: event.data.files,
                url: event.data.href ?? event.source.location.href,
            };
            data = { ...event.data, ...data };
            postMediabunnyJob(data).catch(function (error) {
                console.log(error);
            });
        }
        if (event.data.action == "catCatchFFmpegResult") {
            if (!event.data.state || !event.data.tabId) { return; }
            chrome.runtime.sendMessage({ Message: "catCatchFFmpegResult", ...event.data });
        }
        if (event.data.action == "catCatchToBackground") {
            delete event.data.action;
            chrome.runtime.sendMessage(event.data);
        }
        // if (event.data.action == "catCatchDashDRMMedia") {
        //     // TODO DRM Media
        //     console.log("DRM Media", event);
        // }
    }, false);

    function ArrayToBase64(data) {
        try {
            let bytes = new Uint8Array(data);
            let binary = "";
            for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            if (typeof _btoa == "function") {
                return _btoa(binary);
            }
            return btoa(binary);
        } catch (e) {
            return false;
        }
    }
})();
