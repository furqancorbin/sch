// ==UserScript==
// @name         Blob Downloader
// @namespace    https://viayoo.com/
// @version      85.1
// @description  blob download helper - fixed MediaSource + Event trigger
// @match        *://*/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// @all-frames   true
// ==/UserScript==

(function() {
    'use strict';
    function INSTALL() {
        if (window.__V85__) return;
        window.__V85__ = true;

        const realCreate = URL.createObjectURL;
        const realOpen = window.open;
        const found = [];
        const seenBlob = new Set();
        const seenFinger = new Set();
        const done = new Set();

        // --- FIX 1: MediaSource Store ---
        // Har MediaSource ke chunks yahan jama honge
        const msStore = new WeakMap(); // MediaSource -> { buffers: [], mime: '', sourceBuffers: [] }
        const msUrlMap = new Map(); // blob:URL -> MediaSource

        function setStyle(el, obj) {
            try { for (const k in obj) { try { el.style[k] = obj[k]; } catch (e) {} } } catch (e) {}
        }
        function svgEl(name, size, color) {
            const NS = 'http://www.w3.org/2000/svg';
            const svg = document.createElementNS(NS, 'svg');
            svg.setAttribute('width', size || 20); svg.setAttribute('height', size || 20); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
            const paths = {
                download: ['M12 3v12m0 0l-4-4m4 4l4-4', 'M4 19h16'],
                check: ['M4 12l5 5L20 6'],
                trash: ['M4 7h16M9 7V5h6v2m-8 0l1 13h8l1-13'],
                close: ['M6 6l12 12M18 6L6 18'],
                file: ['M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z', 'M14 3v5h5'],
                folder: ['M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z', 'M12 11v6m0 0l-2-2m2 2l2-2'],
                loading: []
            };
            const list = paths[name] || paths.file;
            for (let i = 0; i < list.length; i++) {
                const p = document.createElementNS(NS, 'path');
                p.setAttribute('d', list[i]); p.setAttribute('stroke', color || '#fff'); p.setAttribute('stroke-width', '2');
                p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
                svg.appendChild(p);
            }
            if (name === 'loading') {
                const c = document.createElementNS(NS, 'circle');
                c.setAttribute('cx', '12'); c.setAttribute('cy', '12'); c.setAttribute('r', '9');
                c.setAttribute('stroke', color || '#fff'); c.setAttribute('stroke-width', '2'); c.setAttribute('stroke-dasharray', '14 8');
                svg.appendChild(c);
            }
            const wrap = document.createElement('span');
            setStyle(wrap, { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: '0' });
            wrap.appendChild(svg);
            return wrap;
        }
        function setBtnIcon(btn, name) {
            try { while (btn.firstChild) btn.removeChild(btn.firstChild); btn.appendChild(svgEl(name, 22, '#fff')); } catch (e) {}
        }
        function fmt(b) {
            if (!b && b !== 0) return '0 B';
            let v = 0, u = 'B';
            if (b < 1024) { v = b; u = 'B'; }
            else if (b < 1024 * 1024) { v = b / 1024; u = 'KB'; }
            else if (b < 1024 * 1024 * 1024) { v = b / (1024 * 1024); u = 'MB'; }
            else { v = b / (1024 * 1024 * 1024); u = 'GB'; }
            return parseFloat(v.toFixed(2)) + ' ' + u;
        }
        function shortName(name) {
            if (!name) return '';
            if (name.length <= 28) return name;
            return name.slice(0, 12) + '...' + name.slice(-12);
        }
        function normalizeSubtype(t) {
            if (!t) return '';
            let s = String(t).split('/')[1] || '';
            s = s.split(';')[0].split('+')[0].toLowerCase().trim();
            if (s === 'jpeg') return 'jpg';
            if (s === 'plain') return 'txt';
            if (s === 'javascript') return 'js';
            if (s === 'x-javascript') return 'js';
            if (s === 'octet-stream') return '';
            if (s === 'vnd.android.package-archive') return 'apk';
            if (s === 'vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
            if (s === 'vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx';
            if (s === 'vnd.openxmlformats-officedocument.presentationml.presentation') return 'pptx';
            if (s === 'svg+xml') return 'svg';
            if (s === 'x-7z-compressed') return '7z';
            if (s === 'x-rar-compressed') return 'rar';
            if (s === 'x-tar') return 'tar';
            if (s === 'x-msvideo') return 'avi';
            if (s === 'quicktime') return 'mov';
            if (s === 'x-matroska') return 'mkv';
            return s;
        }
        function detectTextExt(txt) {
            const t = txt.trim();
            if (!t) return '';
            const low = t.toLowerCase();
            if (low.indexOf('<!doctype html') === 0 || low.indexOf('<html') === 0 || low.indexOf('<head') === 0 || low.indexOf('<body') === 0 || low.indexOf('<div') === 0 || low.indexOf('<script') === 0 || low.indexOf('<style') === 0) return 'html';
            if (low.indexOf('<svg') === 0) return 'svg';
            if (low.indexOf('<?xml') === 0) return 'xml';
            if (t[0] === '{' || t[0] === '[') { try { JSON.parse(t.slice(0, 20000)); return 'json'; } catch (e) {} }
            const hasBrace = t.indexOf('{') !== -1 && t.indexOf('}') !== -1;
            const hasColonSemi = t.indexOf(':') !== -1 && t.indexOf(';') !== -1;
            const cssProps = /(\bcolor\s*:|\bmargin\s*:|\bpadding\s*:|\bdisplay\s*:|\bfont-|\bbackground\s*:|@media|@import|@font-face|@keyframes)/.test(t);
            const hasTag = /<[a-z][^>]*>/i.test(t);
            if (hasBrace && hasColonSemi && cssProps && !hasTag) return 'css';
            const jsScore = (/\bfunction\b/.test(t) ? 2 : 0) + (/\b(const|let|var)\s+[A-Za-z_$]+\s*=/.test(t) ? 2 : 0) + (/=>/.test(t) ? 2 : 0) + (/\b(import|export)\b/.test(t) ? 2 : 0) + (/\brequire\s*\(/.test(t) ? 2 : 0) + (/\bconsole\.log\s*\(/.test(t) ? 1 : 0) + (/\bdocument\.|window\.|addEventListener\s*\(/.test(t) ? 1 : 0);
            if (jsScore >= 2 && !hasTag) return 'js';
            if (hasBrace && hasColonSemi && !hasTag && jsScore === 0) return 'css';
            const lines = t.split('\n').slice(0, 5);
            if (lines.length >= 2 && lines.every(function(l) { return l.indexOf(',') !== -1; })) return 'csv';
            if (t[0] === '<' && t.indexOf('>') !== -1) return 'xml';
            return '';
        }
        async function detectExt(blob) {
            const type = blob.type || '';
            try {
                const head = blob.slice(0, 65536);
                const buf = await head.arrayBuffer();
                const b = new Uint8Array(buf);
                let latin = '';
                for (let i = 0; i < b.length; i += 4096) latin += String.fromCharCode.apply(null, b.slice(i, i + 4096));
                const s8 = latin.slice(0, 16);
                if (s8.indexOf('%PDF') === 0) return 'pdf';
                if (b[0] === 0x89 && latin.indexOf('PNG') !== -1) return 'png';
                if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpg';
                if (latin.indexOf('GIF8') === 0) return 'gif';
                if (latin.indexOf('RIFF') === 0 && latin.slice(8, 12) === 'WEBP') return 'webp';
                if (latin.indexOf('RIFF') === 0 && latin.slice(8, 12) === 'WAVE') return 'wav';
                if (latin.indexOf('Rar!') === 0) return 'rar';
                if (b[0] === 0x37 && b[1] === 0x7A) return '7z';
                if (b[0] === 0x1F && b[1] === 0x8B) return 'gz';
                if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) return latin.indexOf('webm') !== -1 ? 'webm' : 'mkv';
                if (latin.indexOf('OggS') === 0) return 'ogg';
                if (latin.indexOf('fLaC') === 0) return 'flac';
                if (latin.indexOf('ID3') === 0 || (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0)) return 'mp3';
                if (latin.indexOf('ftyp') !== -1) return 'mp4';
                if (latin.indexOf('SQLite format 3') === 0) return 'db';
                if (b[0] === 0x50 && b[1] === 0x4B) {
                    if (latin.indexOf('AndroidManifest.xml') !== -1) return 'apk';
                    if (latin.indexOf('[Content_Types].xml') !== -1) {
                        if (latin.indexOf('word/') !== -1) return 'docx';
                        if (latin.indexOf('xl/') !== -1) return 'xlsx';
                        if (latin.indexOf('ppt/') !== -1) return 'pptx';
                        return 'docx';
                    }
                    if (latin.indexOf('application/epub+zip') !== -1 || latin.indexOf('META-INF/container.xml') !== -1) return 'epub';
                    if (latin.indexOf('.class') !== -1 && latin.indexOf('META-INF/MANIFEST.MF') !== -1) return 'jar';
                    return 'zip';
                }
                let isText = true;
                for (let i = 0; i < Math.min(b.length, 2048); i++) {
                    const c = b[i];
                    if (c === 0) { isText = false; break; }
                    if (c < 9 || (c > 13 && c < 32 && c !== 27)) { isText = false; break; }
                }
                if (isText) {
                    const textExt = detectTextExt(latin.slice(0, 20000));
                    if (textExt) return textExt;
                    const sub = normalizeSubtype(type);
                    if (sub) return sub;
                    return 'txt';
                }
                const sub2 = normalizeSubtype(type);
                if (sub2) return sub2;
                return 'bin';
            } catch (e) {}
            const sub = normalizeSubtype(type);
            return sub || 'bin';
        }
        function isMediaSource(o) {
            try { return (typeof MediaSource !== 'undefined' && o instanceof MediaSource); } catch (e) { return false; }
        }
        async function fingerprint(blob) {
            try {
                const head = blob.slice(0, 4096);
                const buf = await head.arrayBuffer();
                const bytes = new Uint8Array(buf);
                let h = 0;
                for (let i = 0; i < bytes.length; i++) { h = ((h * 31) + bytes[i]) >>> 0; }
                return blob.size + '|' + h + '|' + bytes.length;
            } catch (e) { return blob.size + '|0'; }
        }
        function makeFileName(ext) {
            let domain = 'site';
            try { domain = window.location.hostname || 'site'; domain = domain.replace(/[^a-zA-Z0-9.-]/g, '_'); } catch (e) {}
            const d = new Date();
            const pad = function(n) { return String(n).padStart(2, '0'); };
            const time = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '_' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
            return 'file_' + domain + '_' + time + (ext ? '.' + ext : '');
        }
        function downloadOne(item, btn) {
            if (!item || !item.blob) return;
            if (item.blob.size === 0) return;
            try {
                if (btn) setBtnIcon(btn, 'loading');
                const url = realCreate.call(URL, item.blob);
                const a = document.createElement('a');
                a.href = url; a.download = item.name;
                (document.body || document.documentElement).appendChild(a);
                try {
                    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
                    a.dispatchEvent(ev);
                } catch (e) { a.click(); }
                setTimeout(function() { try { a.remove(); } catch (e) {} }, 5000);
                setTimeout(function() { try { URL.revokeObjectURL(url); } catch (e) {} }, 60000);
                item.downloaded = true;
                if (btn) { setBtnIcon(btn, 'check'); setTimeout(function() { setBtnIcon(btn, 'download'); }, 3000); }
                renderBox();
            } catch (e) { if (btn) setBtnIcon(btn, 'download'); }
        }

        let icon = null, box = null, boxBody = null, boxCount = null, iconCount = null, boxOpen = false;
        function el(tag, txt) { const e = document.createElement(tag); if (txt != null) e.appendChild(document.createTextNode(txt)); return e; }
        function ensureUI() {
            if (icon && document.contains(icon) && box && document.contains(box)) return;
            try {
                if (!icon || !document.contains(icon)) {
                    icon = document.createElement('div');
                    icon.setAttribute('id', 'v85-icon');
                    setStyle(icon, { position: 'fixed', right: '12px', bottom: '12px', zIndex: '2147483647', background: '#111', color: '#fff', border: '2px solid #fff', borderRadius: '50%', width: '60px', height: '60px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', boxShadow: '0 6px 20px rgba(0,0,0,0.5)', touchAction: 'manipulation' });
                    const inner = document.createElement('div');
                    setStyle(inner, { position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' });
                    inner.appendChild(svgEl('folder', 28, '#fff'));
                    iconCount = el('span', '0');
                    setStyle(iconCount, { position: 'absolute', top: '-10px', right: '-12px', background: '#2563eb', color: '#fff', fontSize: '11px', fontWeight: '800', minWidth: '20px', height: '20px', borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px' });
                    inner.appendChild(iconCount);
                    icon.appendChild(inner);
                    icon.onclick = function(e) { if (e) e.stopPropagation(); boxOpen = !boxOpen; if (box) box.style.display = boxOpen ? 'flex' : 'none'; };
                    (document.body || document.documentElement).appendChild(icon);
                }
                if (!box || !document.contains(box)) {
                    box = document.createElement('div');
                    box.setAttribute('id', 'v85-box');
                    setStyle(box, { position: 'fixed', left: '8px', right: '8px', bottom: '80px', zIndex: '2147483647', maxWidth: '440px', margin: '0 auto', maxHeight: '72vh', background: '#111', color: '#fff', border: '1px solid #444', borderRadius: '16px', display: 'none', flexDirection: 'column', overflow: 'hidden', fontFamily: 'sans-serif', fontSize: '14px', boxShadow: '0 10px 30px rgba(0,0,0,0.6)' });
                    const head = document.createElement('div');
                    setStyle(head, { padding: '12px', background: '#222', borderBottom: '1px solid #444', flexShrink: '0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' });
                    const headLeft = document.createElement('div');
                    setStyle(headLeft, { display: 'flex', alignItems: 'center', gap: '8px' });
                    headLeft.appendChild(svgEl('file', 20, '#fff'));
                    boxCount = el('b', 'Found Files (0)');
                    boxCount.style.fontSize = '15px';
                    headLeft.appendChild(boxCount);
                    const headBtns = document.createElement('div');
                    setStyle(headBtns, { display: 'flex', gap: '8px', alignItems: 'center' });
                    const clearBtn = document.createElement('button');
                    setStyle(clearBtn, { minHeight: '44px', padding: '0 12px', borderRadius: '10px', border: '1px solid #555', background: '#222', color: '#fff', fontSize: '13px', fontWeight: '700', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' });
                    clearBtn.appendChild(svgEl('trash', 18, '#fff'));
                    clearBtn.appendChild(el('span', 'Clear'));
                    const closeBtn = document.createElement('button');
                    setStyle(closeBtn, { minWidth: '44px', minHeight: '44px', borderRadius: '50%', border: '0', background: '#333', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' });
                    closeBtn.appendChild(svgEl('close', 18, '#fff'));
                    headBtns.appendChild(clearBtn); headBtns.appendChild(closeBtn);
                    head.appendChild(headLeft); head.appendChild(headBtns);
                    box.appendChild(head);
                    boxBody = document.createElement('div');
                    setStyle(boxBody, { padding: '10px', overflowY: 'auto' });
                    box.appendChild(boxBody);
                    (document.body || document.documentElement).appendChild(box);
                    clearBtn.onclick = function(e) { if (e) e.stopPropagation(); found.length = 0; seenFinger.clear(); renderBox(); };
                    closeBtn.onclick = function(e) { if (e) e.stopPropagation(); boxOpen = false; box.style.display = 'none'; };
                }
                setInterval(function() { try { if (icon && !document.contains(icon)) (document.body || document.documentElement).appendChild(icon); if (box && !document.contains(box)) (document.body || document.documentElement).appendChild(box); } catch (e) {} }, 2000);
            } catch (e) {}
        }
        function renderBox() {
            ensureUI();
            if (!boxBody) return;
            try {
                if (iconCount) iconCount.textContent = String(found.length);
                if (boxCount) boxCount.textContent = 'Found Files (' + found.length + ')';
                while (boxBody.firstChild) boxBody.removeChild(boxBody.firstChild);
                if (!found.length) {
                    const d = el('div', 'No blob found yet - Tap download on the site and it will appear here');
                    setStyle(d, { color: '#aaa', padding: '14px', textAlign: 'center' });
                    boxBody.appendChild(d);
                    return;
                }
                const sorted = found.slice().sort(function(a, b) { return b.size - a.size; });
                for (let i = 0; i < sorted.length; i++) {
                    const it = sorted[i];
                    const row = document.createElement('div');
                    setStyle(row, { display: 'flex', alignItems: 'center', gap: '10px', border: '1px solid #333', borderRadius: '12px', padding: '12px', marginBottom: '10px', background: '#181818' });
                    row.appendChild(svgEl('file', 28, '#60a5fa'));
                    const left = document.createElement('div');
                    setStyle(left, { flex: '1', minWidth: '0' });
                    const nameEl = el('div', shortName(it.name) + (it.downloaded ? ' - Done' : ''));
                    nameEl.title = it.name;
                    setStyle(nameEl, { fontWeight: '700', fontSize: '14px', lineHeight: '1.3', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
                    const sizeEl = el('div', fmt(it.size) + '  •  ' + (it.ext || '').toUpperCase() + (it.from === 'MediaSource (MSE)' ? '  •  MSE' : ''));
                    setStyle(sizeEl, { color: '#aaa', fontSize: '13px', marginTop: '4px' });
                    left.appendChild(nameEl); left.appendChild(sizeEl);
                    row.appendChild(left);
                    const btn = document.createElement('button');
                    btn.title = 'Download ' + it.name;
                    setStyle(btn, { flexShrink: '0', width: '52px', height: '48px', borderRadius: '12px', border: '0', background: it.downloaded ? '#16a34a' : '#2563eb', color: '#fff', cursor: 'pointer', touchAction: 'manipulation', display: 'flex', alignItems: 'center', justifyContent: 'center' });
                    btn.appendChild(svgEl(it.downloaded ? 'check' : 'download', 22, '#fff'));
                    btn.onclick = function(ev) { if (ev) ev.stopPropagation(); downloadOne(it, btn); };
                    row.appendChild(btn);
                    boxBody.appendChild(row);
                }
            } catch (e) {}
        }

        async function addFound(blob, url, from) {
            if (!blob || !(blob instanceof Blob)) return;
            if (blob.size === 0) return;
            if (seenBlob.has(blob)) return;
            seenBlob.add(blob);
            const fp = await fingerprint(blob);
            if (seenFinger.has(fp)) return;
            seenFinger.add(fp);
            const ext = await detectExt(blob);
            const name = makeFileName(ext);
            const item = { blob: blob, name: name, ext: ext, type: blob.type || '', size: blob.size, url: url || '', from: from || 'Blob', time: Date.now(), downloaded: false };
            found.push(item);
            renderBox();
            if (found.length === 1 && !boxOpen) { boxOpen = true; if (box) box.style.display = 'flex'; }
        }

        // --- FIX 1: MediaSource Capture ---
        function flushMediaSource(ms) {
            const rec = msStore.get(ms);
            if (!rec || !rec.buffers.length) return;
            try {
                const mime = rec.mime || 'video/mp4';
                const blob = new Blob(rec.buffers, { type: mime });
                // Duplicate rokne ke liye - direct addFound call without seenBlob check issue
                // Hum is blob ko manually push karte hain via addFound
                addFound(blob, rec.url || '', 'MediaSource (MSE)');
            } catch (e) {}
        }
        function hookSourceBuffer(sb, msRec) {
            if (!sb || sb.__v85_hooked) return;
            sb.__v85_hooked = true;
            const origAppend = sb.appendBuffer;
            const origAppendStream = sb.appendStream;
            if (origAppend) {
                sb.appendBuffer = function(data) {
                    try {
                        if (data) {
                            // Copy karo - kyunki data transferable ho sakta hai
                            const copy = data.slice ? data.slice(0) : new Uint8Array(data).slice();
                            msRec.buffers.push(copy);
                            // Har 15MB pe ek partial file dikhao - taake "Not Found" na lage
                            let total = 0;
                            for (let i = 0; i < msRec.buffers.length; i++) total += msRec.buffers[i].byteLength;
                            if (total > 0 && !msRec.partialShown && total > 1024 * 1024) {
                                msRec.partialShown = true;
                                // Partial ko abhi mat flush karo - sirf UI me hint ke liye ek entry bana do via flush ka copy
                                // Flush abhi nahi - end pe full milega
                            }
                        }
                    } catch (e) {}
                    return origAppend.call(this, data);
                };
            }
            // updateend pe bhi check - kuch sites end pe hi data deti hain
            try {
                sb.addEventListener('updateend', function() {
                    // Agar MediaSource ended hai to flush
                    try { if (msRec.ms && msRec.ms.readyState === 'ended') flushMediaSource(msRec.ms); } catch (e) {}
                });
            } catch (e) {}
        }
        function hookMediaSource(ms, url) {
            if (!ms || msStore.has(ms)) return;
            const rec = { ms: ms, buffers: [], mime: '', url: url || '', partialShown: false };
            msStore.set(ms, rec);
            const origAdd = ms.addSourceBuffer;
            if (origAdd) {
                ms.addSourceBuffer = function(mime) {
                    const sb = origAdd.call(this, mime);
                    if (mime && !rec.mime) rec.mime = mime.split(';')[0];
                    hookSourceBuffer(sb, rec);
                    return sb;
                };
            }
            // endOfStream pe flush - yehi asal file banegi
            const origEnd = ms.endOfStream;
            if (origEnd) {
                ms.endOfStream = function() {
                    try { flushMediaSource(ms); } catch (e) {}
                    return origEnd.apply(this, arguments);
                };
            }
            // sourceended event pe bhi flush - kuch players endOfStream nahi bulate
            try {
                ms.addEventListener('sourceended', function() { flushMediaSource(ms); });
                ms.addEventListener('sourceclose', function() { flushMediaSource(ms); });
            } catch (e) {}
            // Agar video 10 sec tak koi append na kare to bhi flush kar do - live stream ke liye
            // Har naye MediaSource pe 8 sec baad ek baar check
            setTimeout(function() { if (rec.buffers.length) flushMediaSource(ms); }, 12000);
        }

        try {
            const OrigBlob = window.Blob;
            window.Blob = class extends OrigBlob {
                constructor(parts, opts) { super(parts, opts); addFound(this, '', 'new Blob()'); }
            };
            const OrigFile = window.File;
            if (OrigFile) {
                window.File = class extends OrigFile {
                    constructor(parts, name, opts) { super(parts, name, opts); addFound(this, '', 'new File()'); }
                };
            }
            const origSlice = OrigBlob.prototype.slice;
            OrigBlob.prototype.slice = function() {
                const r = origSlice.apply(this, arguments);
                addFound(r, '', 'Blob.slice()');
                return r;
            };
        } catch (e) {}

        // --- FIX 1: createObjectURL - MediaSource ko alag handle karo ---
        try {
            URL.createObjectURL = function(obj) {
                const u = realCreate.call(this, obj);
                if (isMediaSource(obj)) {
                    msUrlMap.set(u, obj);
                    hookMediaSource(obj, u);
                    return u;
                }
                if (obj instanceof Blob) addFound(obj, u, 'createObjectURL');
                return u;
            };
            if (window.webkitURL && window.webkitURL.createObjectURL) window.webkitURL.createObjectURL = URL.createObjectURL;
            // Agar site ne pehle se MediaSource bana liya ho - video.src se pakdo
            // Video element ka src set hone pe check karo
            try {
                const origSrcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
                if (origSrcDesc && origSrcDesc.set) {
                    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
                        configurable: true,
                        get: origSrcDesc.get,
                        set: function(v) {
                            try {
                                if (typeof v === 'string' && v.startsWith('blob:') && msUrlMap.has(v)) {
                                    hookMediaSource(msUrlMap.get(v), v);
                                }
                            } catch (e) {}
                            return origSrcDesc.set.call(this, v);
                        }
                    });
                }
            } catch (e) {}
        } catch (e) {}

        try {
            const origToBlob = HTMLCanvasElement.prototype.toBlob;
            if (origToBlob) {
                HTMLCanvasElement.prototype.toBlob = function(cb, type) {
                    return origToBlob.call(this, function(b) {
                        if (b) addFound(b, '', 'canvas.toBlob');
                        if (cb) cb(b);
                    }, type);
                };
            }
            const origToData = HTMLCanvasElement.prototype.toDataURL;
            HTMLCanvasElement.prototype.toDataURL = function() {
                const url = origToData.apply(this, arguments);
                try {
                    if (typeof url === 'string' && url.startsWith('data:')) {
                        const comma = url.indexOf(',');
                        const b64 = url.slice(comma + 1);
                        const bin = atob(b64);
                        const arr = new Uint8Array(bin.length);
                        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
                        addFound(new Blob([arr]), '', 'canvas.toDataURL');
                    }
                } catch (e) {}
                return url;
            };
        } catch (e) {}
        try {
            const origRespBlob = Response.prototype.blob;
            if (origRespBlob) {
                Response.prototype.blob = async function() {
                    const b = await origRespBlob.call(this);
                    if (b) addFound(b, '', 'fetch().blob()');
                    return b;
                };
            }
        } catch (e) {}
        try {
            const origXHRSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.send = function() {
                try {
                    this.addEventListener('load', function() {
                        try { if (this.response && this.response instanceof Blob) addFound(this.response, '', 'XHR blob'); } catch (e) {}
                    });
                } catch (e) {}
                return origXHRSend.apply(this, arguments);
            };
        } catch (e) {}

        // --- FIX 2: Event Trigger - Global addEventListener override HATA DIYA ---
        // Pehle wala code EventTarget ko tod raha tha. Ab sirf MediaRecorder ko target karenge
        try {
            if (window.MediaRecorder) {
                const OrigMR = window.MediaRecorder;
                const origStart = OrigMR.prototype.start;
                const origStop = OrigMR.prototype.stop;
                // ondataavailable property ko sahi tarike se wrap karo - bina EventTarget tode
                try {
                    const desc = Object.getOwnPropertyDescriptor(OrigMR.prototype, 'ondataavailable');
                    // Agar pehle se define hai to use karo, nahi to naya define karo
                    Object.defineProperty(OrigMR.prototype, 'ondataavailable', {
                        configurable: true,
                        get: function() { return this.__v85_ondata; },
                        set: function(fn) {
                            this.__v85_ondata = fn;
                            // Purana wrapped listener hatao
                            if (this.__v85_wrapped) {
                                try { this.removeEventListener('dataavailable', this.__v85_wrapped); } catch (e) {}
                            }
                            if (typeof fn === 'function') {
                                const self = this;
                                const wrapped = function(e) {
                                    try { if (e && e.data && e.data instanceof Blob && e.data.size > 0) addFound(e.data, '', 'MediaRecorder'); } catch (err) {}
                                    return fn.call(self, e);
                                };
                                this.__v85_wrapped = wrapped;
                                this.addEventListener('dataavailable', wrapped);
                            }
                        }
                    });
                } catch (e) {}
                // addEventListener('dataavailable') wala case - sirf MediaRecorder instance ke liye
                const origAddEv = OrigMR.prototype.addEventListener || EventTarget.prototype.addEventListener;
                // Hum OrigMR pe alag se override nahi karenge - balki start() pe ek baar listener lagayenge
                // Ye trigger ko double nahi karega
                OrigMR.prototype.start = function() {
                    try {
                        if (!this.__v85_started) {
                            this.__v85_started = true;
                            this.addEventListener('dataavailable', function(e) {
                                try { if (e && e.data && e.data instanceof Blob && e.data.size > 0) addFound(e.data, '', 'MediaRecorder'); } catch (err) {}
                            });
                        }
                    } catch (e) {}
                    return origStart.apply(this, arguments);
                };
            }
        } catch (e) {}

        try {
            document.addEventListener('change', function(e) {
                try {
                    const t = e.target;
                    if (t && t.tagName === 'INPUT' && t.type === 'file' && t.files) {
                        for (const f of t.files) addFound(f, '', 'Input File');
                    }
                } catch (err) {}
            }, true);
            document.addEventListener('drop', function(e) {
                try {
                    const dt = e.dataTransfer;
                    if (dt && dt.files) { for (const f of dt.files) addFound(f, '', 'Drag-Drop'); }
                } catch (err) {}
            }, true);
        } catch (e) {}

        function markDoneByUrl(href) {
            if (!href || !href.startsWith('blob:')) return;
            for (let i = 0; i < found.length; i++) {
                if (found[i].url === href) { found[i].downloaded = true; done.add(found[i].blob); }
            }
            renderBox();
        }
        function getHref(a) { try { return a.href || a.getAttribute('href') || ''; } catch (e) { return ''; } }
        function checkAnchor(a) {
            if (!a || a.tagName !== 'A') return;
            const href = getHref(a);
            if (href && href.startsWith('blob:')) markDoneByUrl(href);
        }
        document.addEventListener('click', function(e) {
            try {
                let a = null;
                if (e.composedPath) { const path = e.composedPath(); for (const el of path) { if (el && el.tagName === 'A') { a = el; break; } } }
                if (!a && e.target && e.target.closest) a = e.target.closest('a');
                if (!a && e.target && e.target.tagName === 'A') a = e.target;
                if (a) checkAnchor(a);
            } catch (err) {}
        }, true);
        try {
            const origClick = HTMLAnchorElement.prototype.click;
            HTMLAnchorElement.prototype.click = function() { try { checkAnchor(this); } catch (err) {} return origClick.call(this); };
        } catch (e) {}
        try { window.open = function(url) { return realOpen.apply(this, arguments); }; } catch (e) {}

        ensureUI(); renderBox();
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function() { ensureUI(); renderBox(); });
        setTimeout(function() { ensureUI(); renderBox(); }, 1000);
        setTimeout(function() { ensureUI(); renderBox(); }, 3000);
    }
    INSTALL();
})();