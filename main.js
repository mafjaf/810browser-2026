const { app, BrowserWindow, ipcMain, session, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');

const configPath = path.join(app.getPath('userData'), '810config.json');

function loadConfig() {
    if (!fs.existsSync(configPath)) return { adblockEnabled: false, vtabEnabled: false, killEnabled: false };
    try {
        const data = fs.readFileSync(configPath);
        return JSON.parse(data);
    } catch (e) {
        return { adblockEnabled: false, vtabEnabled: false, killEnabled: false };
    }
}

function applySecuritySettings(mainWindow) {
    const config = loadConfig();
    globalShortcut.unregister('Shift+Space');
    if (config.killEnabled) {
        globalShortcut.register('Shift+Space', () => {
            if (mainWindow) mainWindow.close();
        });
    }
}

let mainWindow;

// ---- Adblock (@ghostery/adblocker-electron) ----
let blocker = null;
let ElectronBlockerRef = null;

async function initAdblock() {
    try {
        const { ElectronBlocker } = require('@ghostery/adblocker-electron');
        ElectronBlockerRef = ElectronBlocker;
        const fetch = require('cross-fetch');
        const cachePath = path.join(app.getPath('userData'), 'adblocker-cache.bin');

        if (fs.existsSync(cachePath)) {
            const buf = fs.readFileSync(cachePath);
            blocker = ElectronBlocker.deserialize(new Uint8Array(buf));
        } else {
            blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch);
            fs.writeFileSync(cachePath, Buffer.from(blocker.serialize()));
        }
    } catch(e) {
        console.error('Adblock init failed:', e);
        blocker = null;
    }
}

// 動画・メディア系サイトのホワイトリスト（ブロック除外）
const WHITELIST_DOMAINS = [
    'youtube.com', 'youtu.be', 'ytimg.com', 'googlevideo.com',
    'yt3.ggpht.com', 'youtube-nocookie.com',
    'netflix.com', 'nflxvideo.net', 'nflximg.net',
    'twitch.tv', 'twitchsvc.net', 'jtvnw.net',
    'nicovideo.jp', 'dmc.nico', 'nicofwd.com',
    'amazon.co.jp', 'primevideo.com', 'media-amazon.com',
    'hulu.com', 'hulustream.com',
    'abema.tv', 'hayabusa.io',
    'tver.jp', 'stream.co.jp',
    'dailymotion.com', 'dmcdn.net',
    'vimeo.com', 'vimeocdn.com',
    'spotify.com', 'scdn.co',
    'soundcloud.com',
];

function isWhitelisted(url) {
    try {
        const host = new URL(url).hostname;
        return WHITELIST_DOMAINS.some(d => host === d || host.endsWith('.' + d));
    } catch(e) { return false; }
}

function applyAdblock() {
    const config = loadConfig();
    const ses = session.defaultSession;

    // 一旦解除
    try { if (blocker) blocker.disableBlockingInSession(ses); } catch(e) {}
    ses.webRequest.onBeforeRequest(null);

    if (!config.adblockEnabled || !blocker) return;

    // リソースタイプのマッピング
    const typeMap = {
        'main_frame': 'document', 'sub_frame': 'subdocument',
        'stylesheet': 'stylesheet', 'script': 'script',
        'image': 'image', 'font': 'font', 'object': 'object',
        'xmlhttprequest': 'xmlhttprequest', 'ping': 'ping',
        'csp_report': 'csp_report', 'media': 'media',
        'websocket': 'websocket', 'other': 'other',
    };

    ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
        // ホワイトリストは無条件通過
        if (isWhitelisted(details.url)) { callback({}); return; }

        // main_frame / media は必ず通過
        if (details.resourceType === 'main_frame' || details.resourceType === 'media') {
            callback({}); return;
        }

        try {
            const { Request } = require('@ghostery/adblocker-electron');
            const sourceUrl = details.referrer || details.url;
            const req = Request.fromRawDetails({
                url: details.url,
                sourceUrl: sourceUrl,
                type: typeMap[details.resourceType] || 'other',
            });
            const { match } = blocker.match(req);
            if (match) console.log('[BLOCKED]', details.url);
            callback({ cancel: !!match });
        } catch(e) {
            console.error('[ADBLOCK ERR]', e.message, details.url);
            callback({});
        }
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        backgroundColor: '#0d0d0d',
        webPreferences: {
            webviewTag: true,
            nodeIntegration: true,
            contextIsolation: false,
            backgroundThrottling: true,
            offscreen: false
        }
    });

    mainWindow.loadFile(path.join(__dirname, "browser", "index.html"));

    mainWindow.webContents.on('did-finish-load', () => {
        applySecuritySettings(mainWindow);
    });

    mainWindow.on('closed', () => {
        globalShortcut.unregisterAll();
        mainWindow = null;
    });
}

app.whenReady().then(async () => {
    session.defaultSession.clearCache();
    createWindow();
    await initAdblock();
    applyAdblock();
});

// 設定の保存
ipcMain.on('save-settings', (event, data) => {
    fs.writeFileSync(configPath, JSON.stringify(data));
    applySecuritySettings(mainWindow);
    applyAdblock();
});

// 設定の取得
ipcMain.handle('get-settings', async () => {
    return loadConfig();
});

// 履歴からのURL遷移（設定画面 → メインウィンドウのアクティブタブへ）
ipcMain.on('navigate-url', (event, url) => {
    if (mainWindow) {
        mainWindow.webContents.executeJavaScript(`
            (function(){
                const c = tabs.find(t => t.id === currentTabId);
                if (c && !c._isBookmark) c.view.src = ${JSON.stringify(url)};
                else newTab(${JSON.stringify(url)});
            })()
        `);
    }
});

// アプリ再起動
ipcMain.on('restart-app', () => {
    app.relaunch();
    app.exit(0);
});

// ブックマーク1件削除（bookmark.html webview → mainWindow経由）
ipcMain.on('delete-bookmark', (event, index) => {
    if (mainWindow) {
        mainWindow.webContents.executeJavaScript(`
            (function(){
                let b = JSON.parse(localStorage.getItem('bb') || '[]');
                b.splice(${index}, 1);
                localStorage.setItem('bb', JSON.stringify(b));
                renderRightBarFavs();
            })()
        `).then(() => {
            // bookmark.html側に更新を通知
            event.sender.send('bookmarks-updated');
        });
    }
});

// 全データ削除
ipcMain.on('clear-browser-data', (event) => {
    if (mainWindow) {
        mainWindow.webContents.executeJavaScript(`
            localStorage.removeItem('bh');
            localStorage.removeItem('bb');
            renderRightBarFavs();
        `).then(() => {
            // 開いているbookmark.htmlタブにも通知
            event.sender.send('bookmarks-updated');
        });
    }
});

process.on('uncaughtException', (err) => {
    console.error('Caught exception: ', err);
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});
