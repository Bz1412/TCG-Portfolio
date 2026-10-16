/* Free, local OCR. Load AFTER background-tasks.js. No API key is required. */
const CardScanner = (() => {
    'use strict';
    const endpoint = API_URL;
    const baseURL = new URL('.', document.currentScript.src);
    const MAX_DRAFTS = 30;
    let dialog, drafts = [], catalog = [], dbPromise, stream, workerPromise, libraryPromise;
    let busy = false, opening = false, releaseEditor, persistTail = Promise.resolve();
    const failedWrites = new Set(), previews = new Map();
    const $ = id => document.getElementById(id);
    const esc = v => String(v ?? '').replace(/[&<>"']/g, ch =>
        ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    const normCode = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const normNumber = v => String(v || '').toUpperCase().replace(/\s/g, '').split('/')
        .map(part => part.replace(/^0+(?=\d)/, '')).join('/');
    const localCards = () => typeof allCards !== 'undefined' && Array.isArray(allCards) ? allCards : [];
    const key = c => [normCode(c.setCode), normNumber(c.cardNumber), String(c.language || '').toUpperCase()].join('|');
    function status(message) { if ($('scan-status')) $('scan-status').textContent = message; }
    function notify(message, error = false) {
        status(message);
        if (typeof showToast === 'function') showToast(message, error ? 'error' : 'success');
    }

    function database() {
        if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open('tcg-scanner-v1', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('drafts', {keyPath:'id'});
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error('ปิดแท็บเว็บเก่าแล้วลองเปิดตัวสแกนใหม่'));
        });
        return dbPromise;
    }
    async function dbOp(mode, operation) {
        const db = await database();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('drafts', mode);
            let result;
            tx.oncomplete = () => resolve(result);
            tx.onabort = () => reject(tx.error || new Error('เก็บรายการในเครื่องไม่สำเร็จ'));
            tx.onerror = () => {};
            try { operation(tx.objectStore('drafts'), value => {result = value;}); }
            catch (error) {tx.abort(); reject(error);}
        });
    }
    function persist(draft) {
        const snapshot = structuredClone(draft);
        const task = persistTail.then(() => dbOp('readwrite', store => store.put(snapshot)));
        persistTail = task.then(() => {failedWrites.delete(draft.id);}, error => {
            failedWrites.add(draft.id); status('เก็บฉบับร่างไม่สำเร็จ: '+error.message);
        });
        return task;
    }
    async function flush() {
        await persistTail;
        for (const d of drafts.filter(d => failedWrites.has(d.id))) await persist(d);
    }

    function build() {
        if (dialog) return;
        dialog = document.createElement('dialog');
        dialog.id = 'tcg-scanner';
        dialog.setAttribute('aria-labelledby','scan-title');
        dialog.innerHTML = `
          <header class="scan-head"><div><h2 id="scan-title">📷 สแกนการ์ดเข้าคลัง</h2>
            <p class="scan-note">ถ่ายทีละใบ · ตรวจข้อมูลรวมกัน · บันทึกเมื่อพร้อม</p></div>
            <button type="button" id="scan-close" aria-label="ปิดตัวสแกน">✕</button></header>
          <div class="scan-body"><section>
            <div class="scan-stage" id="scan-stage" hidden>
              <video id="scan-video" autoplay muted playsinline></video>
              <div class="scan-frame"><span>วางหน้าการ์ดให้เต็มกรอบ</span></div>
            </div>
            <div class="scan-controls">
              <button type="button" id="scan-camera" data-work>เปิดกล้องหลัง</button>
              <button type="button" id="scan-capture" class="scan-primary" disabled>ถ่ายใบนี้</button>
              <button type="button" id="scan-stop" hidden>หยุดกล้อง</button>
              <button type="button" id="scan-files-button" data-work>เลือกรูปหลายใบ</button>
              <input type="file" id="scan-files" accept="image/jpeg,image/png,image/webp" multiple hidden>
            </div>
            <label>ภาษาของการ์ดที่กำลังถ่าย
              <select id="scan-language" data-work><option value="TH">TH — ไทย</option>
                <option value="JP">JP — ญี่ปุ่น</option><option value="EN">EN — อังกฤษ</option></select></label>
            <label>รหัส Set ของชุดที่กำลังถ่าย (ช่วยเมื่อรหัสเล็ก)
              <input id="scan-set-hint" list="scan-set-codes" placeholder="ว่าง = ให้ OCR อ่าน เช่น MA6 T" data-work>
              <datalist id="scan-set-codes"></datalist></label>
            <label>บริเวณอ่านข้อความ
              <select id="scan-region" data-work><option value="bottom">ส่วนล่างของการ์ด</option>
                <option value="full">ทั้งหน้าการ์ด</option></select></label>
            <p class="scan-note">รูปที่เลือกควรมีการ์ด 1 ใบ ตั้งตรงและเต็มภาพ ไม่ซ้อนกัน หลีกเลี่ยงแสงสะท้อน</p>
            <p class="scan-note">อ่านเฉพาะรหัส/เลขด้วย OCR แล้วเทียบชื่อกับข้อมูลอ้างอิง ราคาต้องตรวจและกรอกเอง</p>
            <p id="scan-status" class="scan-status" role="status" aria-live="polite">พร้อมสแกน</p>
          </section><section class="scan-list" aria-label="รายการรอตรวจ">
            <p id="scan-count"></p><div id="scan-drafts"></div>
          </section></div>
          <footer class="scan-foot"><span class="scan-note">ติ๊กยืนยันเฉพาะใบที่จะบันทึก<br>รายการที่เหลือเก็บไว้ตรวจต่อได้</span>
            <button type="button" id="scan-submit" class="scan-primary">บันทึกที่ยืนยัน</button></footer>`;
        document.body.appendChild(dialog);
        $('scan-close').addEventListener('click', close);
        dialog.addEventListener('cancel', event => {event.preventDefault(); void close();});
        $('scan-camera').addEventListener('click', () => void startCamera());
        $('scan-stop').addEventListener('click', stopCamera);
        $('scan-capture').addEventListener('click', () => void capture());
        $('scan-files-button').addEventListener('click', () => $('scan-files').click());
        $('scan-files').addEventListener('change', event => {
            const files = [...event.target.files]; event.target.value = ''; void importFiles(files);
        });
        $('scan-submit').addEventListener('click', () => void submit());
        $('scan-drafts').addEventListener('input', editDraft);
        $('scan-drafts').addEventListener('change', editDraft);
        $('scan-drafts').addEventListener('click', event => {
            const button = event.target.closest('button[data-action]');
            if (button && !busy) void rowAction(button.dataset.action, button.closest('[data-draft]').dataset.draft);
        });
        window.addEventListener('pagehide', stopCamera);
        document.addEventListener('visibilitychange', () => {if (document.hidden) stopCamera();});
    }
    async function open() {
        if (opening || dialog?.open) return;
        if (typeof adminPin === 'undefined' || !adminPin) return notify('เข้าสู่ระบบผู้ดูแลก่อนสแกนค่ะ', true);
        if (!navigator.locks || !window.isSecureContext) return notify('เปิดเว็บ GitHub Pages ผ่าน HTTPS ในเบราว์เซอร์รุ่นปัจจุบันค่ะ', true);
        if (typeof TcgTasks === 'undefined' || typeof TcgTasks.enqueueScannedCards !== 'function') {
            return notify('ยังไม่ได้เพิ่ม enqueueScannedCards ใน background-tasks.js', true);
        }
        opening = true;
        try {
            const acquired = await new Promise((resolve, reject) => {
                navigator.locks.request('tcg-scanner-editor:'+endpoint, {ifAvailable:true}, async lock => {
                    if (!lock) {resolve(false); return;}
                    await new Promise(release => {releaseEditor = release; resolve(true);});
                }).catch(reject);
            });
            if (!acquired) throw new Error('ตัวสแกนเปิดอยู่ในอีกแท็บ กรุณาปิดแท็บนั้นก่อน');
            build();
            drafts = await dbOp('readonly', (store, done) => {
                store.getAll().onsuccess = e => done(e.target.result.filter(d => d.endpoint === endpoint)
                    .sort((a,b) => a.createdAt - b.createdAt));
            });
            dialog.showModal();
            if (typeof toggleModal === 'function') toggleModal(false);
            render();
            await loadCatalog();
        } catch (error) {
            if (!dialog?.open) {releaseEditor?.(); releaseEditor = null;}
            notify(error.message, true);
        } finally {opening = false;}
    }
    async function close() {
        if (busy || opening) {status('รออ่าน/เก็บรายการนี้ให้เสร็จก่อนปิดค่ะ'); return;}
        try {await flush();}
        catch (error) {notify('ยังเก็บฉบับร่างไม่สำเร็จ: '+error.message, true); return;}
        stopCamera();
        if (workerPromise) {const old = workerPromise; workerPromise = null; void old.then(w => w.terminate()).catch(() => {});}
        dialog.close();
        previews.forEach(url => URL.revokeObjectURL(url)); previews.clear();
        releaseEditor?.(); releaseEditor = null;
    }
    function setBusy(value) {
        busy = value;
        dialog.querySelectorAll('[data-work],#scan-submit,#scan-drafts input,#scan-drafts select,#scan-drafts button')
            .forEach(el => {el.disabled = value;});
        $('scan-capture').disabled = value || !stream;
    }
    async function loadCatalog() {
        try {
            const response = await fetch(new URL('card-catalog.json', baseURL), {cache:'no-cache', signal:AbortSignal.timeout(12000)});
            if (!response.ok) throw new Error('catalog');
            const rows = await response.json();
            if (!Array.isArray(rows)) throw new Error('catalog');
            catalog = rows.filter(c => c && typeof c === 'object' && c.setCode && c.cardNumber && c.language);
            status('พร้อมสแกน · อ้างอิงจากคลังและ card-catalog.json');
        } catch {catalog = []; status('พร้อมสแกน · ใช้ข้อมูลในคลัง (ยังโหลด card-catalog.json ไม่ได้)');}
        const codes = [...new Set([...catalog,...localCards()].map(c => String(c.setCode || '').trim()).filter(Boolean))];
        $('scan-set-codes').innerHTML = codes.map(c => `<option value="${esc(c)}"></option>`).join('');
    }

    async function startCamera() {
        if (busy || stream) return;
        setBusy(true);
        try {
            if (!navigator.mediaDevices?.getUserMedia) throw new Error('เบราว์เซอร์นี้เปิดกล้องไม่ได้ ใช้ปุ่มเลือกรูปแทนค่ะ');
            stream = await navigator.mediaDevices.getUserMedia({audio:false, video:{
                facingMode:{ideal:'environment'}, width:{ideal:1920}, height:{ideal:1080}}});
            $('scan-stage').hidden = false; $('scan-stop').hidden = false;
            $('scan-video').srcObject = stream;
            await $('scan-video').play();
            status('จัดการ์ดให้เต็มกรอบ แล้วกดถ่ายใบนี้');
        } catch (error) {
            stopCamera();
            notify(error.name === 'NotAllowedError' ? 'ยังไม่ได้อนุญาตกล้อง ใช้เลือกรูปได้ หรืออนุญาตกล้องในตั้งค่าเบราว์เซอร์' : error.message, true);
        } finally {setBusy(false);}
    }
    function stopCamera() {
        stream?.getTracks().forEach(track => track.stop()); stream = null;
        if ($('scan-video')) $('scan-video').srcObject = null;
        if ($('scan-stage')) $('scan-stage').hidden = true;
        if ($('scan-stop')) $('scan-stop').hidden = true;
        if ($('scan-capture')) $('scan-capture').disabled = true;
    }
    const toBlob = canvas => new Promise((resolve,reject) => canvas.toBlob(blob =>
        blob ? resolve(blob) : reject(new Error('แปลงรูปไม่สำเร็จ')), 'image/jpeg', .9));
    async function capture() {
        if (busy || !stream) return;
        if (drafts.length >= MAX_DRAFTS) return notify('มีฉบับร่างครบ 30 รายการแล้ว บันทึกหรือลบบางรายการก่อนค่ะ', true);
        setBusy(true);
        try {
            const video = $('scan-video'), w = video.videoWidth, h = video.videoHeight;
            if (!w || !h) throw new Error('กล้องยังไม่พร้อม ลองถ่ายอีกครั้ง');
            // Mirror CSS object-fit:cover, then crop the 8% inset guide.
            const aspect = video.clientWidth / video.clientHeight;
            let sw = w, sh = h;
            if (w/h > aspect) sw = h*aspect; else sh = w/aspect;
            const sx = (w-sw)/2+sw*.08, sy = (h-sh)/2+sh*.08;
            sw *= .84; sh *= .84;
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(sw); canvas.height = Math.round(sh);
            canvas.getContext('2d').drawImage(video,sx,sy,sw,sh,0,0,canvas.width,canvas.height);
            await addPhoto(await toBlob(canvas));
        } catch (error) {notify(error.message, true);}
        finally {setBusy(false);}
    }
    async function importFiles(files) {
        if (busy || !files.length) return;
        const room = MAX_DRAFTS - drafts.length;
        if (files.length > room) return notify(`เพิ่มได้อีก ${room} รูป กรุณาเลือกใหม่`, true);
        setBusy(true);
        let failed = 0;
        try {
            for (let i=0; i<files.length; i++) {
                status(`กำลังอ่านรูป ${i+1}/${files.length}`);
                try {await addPhoto(files[i]);}
                catch (error) {failed++; notify(`${files[i].name}: ${error.message}`, true);}
            }
            status(`นำเข้ารูปแล้ว ${files.length-failed}/${files.length} รูป · ตรวจข้อมูลแต่ละรายการ${failed ? ' · บางรูปเปิดหรือเก็บไม่ได้ โปรดลองใหม่' : ''}`);
        } finally {setBusy(false);}
    }
    async function normalizePhoto(file) {
        if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 20*1024*1024) {
            throw new Error('ใช้ JPG, PNG หรือ WebP ไม่เกิน 20 MB ต่อรูป (HEIC ต้องแปลงก่อน)');
        }
        const bitmap = await createImageBitmap(file);
        try {
            const scale = Math.min(1,2000/Math.max(bitmap.width,bitmap.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1,Math.round(bitmap.width*scale));
            canvas.height = Math.max(1,Math.round(bitmap.height*scale));
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = 'white'; ctx.fillRect(0,0,canvas.width,canvas.height);
            ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
            return toBlob(canvas);
        } finally {bitmap.close();}
    }
    async function addPhoto(file) {
        const blob = await normalizePhoto(file);
        const d = {id:crypto.randomUUID(),endpoint,createdAt:Date.now(),blob,reviewed:false,
            name:'',set:'',setCode:$('scan-set-hint').value.trim(),cardNumber:'',rarity:'-',
            language:$('scan-language').value,condition:'',qty:'1',price:'',buyPrice:'',tags:'',
            ocrText:'',note:'กำลังอ่านข้อความ…'};
        await persist(d); // Keep the photo even if OCR/model download later fails.
        drafts.push(d); render();
        await recognizeDraft(d);
    }
    async function loadOCR() {
        if (window.Tesseract) return;
        if (!libraryPromise) libraryPromise = new Promise((resolve,reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js';
            script.onload = () => window.Tesseract ? resolve() : reject(new Error('เปิด OCR ไม่สำเร็จ'));
            script.onerror = () => {script.remove(); reject(new Error('โหลด OCR ไม่ได้ ตรวจอินเทอร์เน็ตแล้วกดอ่านใหม่'));
            };
            document.head.appendChild(script);
        }).catch(error => {libraryPromise = null; throw error;});
        return libraryPromise;
    }
    async function worker() {
        await loadOCR();
        if (!workerPromise) workerPromise = Tesseract.createWorker('eng',1,{
            workerPath:'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/worker.min.js',
            corePath:'https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0',
            logger:m => {
                if (m.status === 'recognizing text') status(`กำลังอ่านข้อความ ${Math.round((m.progress || 0)*100)}%`);
                else status('กำลังเตรียม OCR · ครั้งแรกต้องดาวน์โหลดโมเดล');
            }
        }).then(async w => {
            await w.setParameters({tessedit_pageseg_mode:Tesseract.PSM.SPARSE_TEXT, preserve_interword_spaces:'1'});
            return w;
        }).catch(error => {workerPromise = null; throw error;});
        return workerPromise;
    }
    async function ocrImage(blob) {
        const bitmap = await createImageBitmap(blob);
        try {
            const bottom = $('scan-region').value === 'bottom';
            const y = bottom ? Math.floor(bitmap.height*.64) : 0;
            const height = bitmap.height-y, scale = Math.min(2,1800/bitmap.width);
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(bitmap.width*scale); canvas.height = Math.round(height*scale);
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = 'white'; ctx.fillRect(0,0,canvas.width,canvas.height);
            ctx.drawImage(bitmap,0,y,bitmap.width,height,0,0,canvas.width,canvas.height);
            const w = await worker();
            return (await w.recognize(canvas)).data.text || '';
        } finally {bitmap.close();}
    }
    function parseCodes(raw, knownCodes = []) {
        const text = String(raw || '').toUpperCase().replace(/[／⁄]/g,'/');
        const numbers = [...text.matchAll(/\b([A-Z]{0,3}\d{1,4})\s*\/\s*([A-Z]{0,3}\d{1,4})\b/g)];
        const unique = [...new Set(numbers.map(m => `${m[1]}/${m[2]}`))];
        // Refuse to choose silently if OCR sees several different card numbers.
        const cardNumber = unique.length === 1 ? unique[0] : '';
        const foundCodes = knownCodes.filter(code => {
            const parts = String(code).toUpperCase().replace(/[^A-Z0-9]/g,'').split('');
            if (!parts.length) return false;
            return new RegExp('(?:^|[^A-Z0-9])'+parts.join('\\s*')+'(?=$|[^A-Z0-9])').test(text);
        });
        const distinctCodes = [...new Map(foundCodes.map(c => [normCode(c),c])).values()];
        const uniqueCodes = distinctCodes.filter(code => !distinctCodes.some(other =>
            normCode(other).length > normCode(code).length && normCode(other).startsWith(normCode(code))));
        let setCode = uniqueCodes.length === 1 ? uniqueCodes[0] : '';
        if (!setCode && uniqueCodes.length === 0 && numbers.length === 1) {
            const before = text.slice(Math.max(0,numbers[0].index-35),numbers[0].index);
            const guess = before.match(/(?:^|\s)([A-Z]{1,5}\s*\d{1,3}[A-Z]?(?:[ \t]+[A-Z]{1,2})?)\s*$/);
            if (guess) setCode = guess[1].replace(/\s+/g,' ').trim();
        }
        const rarity = text.match(/(?:^|\s)(SAR|FUR|RGB|UR|SR|AR|RR|R|U|C)(?=\s|$)/)?.[1] || '-';
        return {setCode,cardNumber,rarity};
    }
    function candidates(d) {
        const unique = new Map();
        for (const c of [...catalog,...localCards()]) {
            if (key(c) !== key(d) || !c.name || !c.set) continue;
            const signature = [c.name,c.set,c.rarity || '-'].join('|');
            if (!unique.has(signature)) unique.set(signature,c);
        }
        return [...unique.values()];
    }
    function matchDraft(d) {
        const matches = d.setCode && d.cardNumber ? candidates(d) : [];
        if (matches.length === 1) {
            const c = matches[0]; d.name = String(c.name); d.set = String(c.set); d.rarity = String(c.rarity || '-');
            d.note = 'พบข้อมูลตรงกัน · ตรวจชื่อ รุ่น ภาษา และสภาพอีกครั้ง';
        } else {
            const sets = [...new Set([...catalog,...localCards()].filter(c => normCode(c.setCode) === normCode(d.setCode) &&
                String(c.language || '').toUpperCase() === d.language).map(c => String(c.set || '')).filter(Boolean))];
            if (!d.set && d.setCode && sets.length === 1) d.set = sets[0];
            d.note = matches.length > 1 ? 'มีข้อมูลชื่อ/รุ่นมากกว่าหนึ่งแบบ กรุณาเลือกและกรอกเอง' :
                'ยังไม่พบข้อมูลอ้างอิงที่ตรงกัน · เติมช่องที่ขาดเองได้';
        }
        d.reviewed = false;
    }
    async function recognizeDraft(d) {
        try {
            d.ocrText = await ocrImage(d.blob);
            const codes = parseCodes(d.ocrText,[...catalog,...localCards()].map(c => c.setCode).filter(Boolean));
            if (!d.setCode) d.setCode = codes.setCode;
            if (!d.cardNumber) d.cardNumber = codes.cardNumber;
            if (d.rarity === '-') d.rarity = codes.rarity;
            matchDraft(d);
        } catch (error) {
            d.note = 'อ่านไม่สำเร็จ: '+error.message+' · รูปยังอยู่ กรอกเองหรือกดอ่านใหม่ได้';
            const old = workerPromise; workerPromise = null;
            if (old) void old.then(w => w.terminate()).catch(() => {});
        }
        await persist(d); render(); status(d.note);
    }

    function field(d, name, label, type='text', extra='') {
        return `<label>${label}<input data-field="${name}" type="${type}" value="${esc(d[name])}" ${extra}></label>`;
    }
    function select(d,name,label,options) {
        return `<label>${label}<select data-field="${name}">${options.map(([v,t]) =>
            `<option value="${v}" ${d[name]===v?'selected':''}>${t}</option>`).join('')}</select></label>`;
    }
    function render() {
        $('scan-count').textContent = `รอตรวจ ${drafts.length}/${MAX_DRAFTS} รายการ`;
        $('scan-drafts').innerHTML = drafts.length ? drafts.map((d,i) => {
            if (!previews.has(d.id)) previews.set(d.id, URL.createObjectURL(d.blob));
            return `<article class="scan-row" data-draft="${d.id}">
              <div class="scan-row-top"><img class="scan-thumb" src="${previews.get(d.id)}" alt="รูปการ์ด ${i+1}">
                <div><strong>ใบที่ ${i+1}</strong><p class="scan-note">${esc(d.note)}</p>
                <button type="button" data-action="read">อ่านใหม่</button>
                <button type="button" class="scan-danger" data-action="remove">ลบรูปนี้</button></div></div>
              <div class="scan-fields">
                ${field(d,'setCode','รหัส Set')}${field(d,'cardNumber','เลขการ์ด เช่น 143/130')}
                ${field(d,'name','ชื่อการ์ด *')}${field(d,'set','ชื่อ Set *')}
                ${field(d,'rarity','ความหายาก')}
                ${select(d,'language','ภาษา',[['TH','ไทย'],['JP','ญี่ปุ่น'],['EN','อังกฤษ']])}
                ${select(d,'condition','สภาพ *',[['','— เลือกเอง —'],['NM','NM'],['LP','LP'],['MP','MP'],['HP','HP']])}
                ${field(d,'qty','จำนวน *','number','min="1" step="1"')}
                ${field(d,'price','ราคาประเมิน/ขายต่อใบ (บาท) *','number','min="0" step="0.01"')}
                ${field(d,'buyPrice','ต้นทุนซื้อแยกต่อใบ (บาท)','number','min="0" step="0.01" placeholder="ว่าง = ยังไม่ทราบ"')}
                <div class="scan-wide">${field(d,'tags','แท็ก / รุ่นพิเศษ เช่น Reverse Holo')}</div>
              </div>
              <p class="scan-note">เปิดจากแพ็ค: ใส่ต้นทุนซื้อแยกเป็น 0 และบันทึกค่าแพ็คในส่วนต้นทุนเปิดแพ็ค</p>
              <div class="scan-controls"><button type="button" data-action="match">เทียบรหัสอีกครั้ง</button>
                <button type="button" data-action="sasom">ค้นราคา SASOM</button></div>
              <details><summary class="scan-note">ข้อความที่ OCR อ่านได้</summary><pre class="scan-ocr">${esc(d.ocrText || '(ยังไม่มีข้อความ)')}</pre></details>
              <label class="scan-review"><input type="checkbox" data-field="reviewed" ${d.reviewed?'checked':''}>
                ตรวจข้อมูลแล้ว — บันทึกใบนี้เป็นรายการใหม่</label>
            </article>`;
        }).join('') : '<p class="scan-note">เปิดกล้องหรือเลือกรูป เพื่อเริ่มรายการแรก</p>';
        setBusy(busy);
    }
    function editDraft(event) {
        if (busy) return;
        const input = event.target, name = input.dataset.field;
        if (!name || (event.type==='input' && input.type==='checkbox')) return;
        const row = input.closest('[data-draft]'), d = drafts.find(d => d.id===row.dataset.draft);
        if (!d) return;
        d[name] = name === 'reviewed' ? input.checked : input.value;
        if (name !== 'reviewed') {d.reviewed = false; row.querySelector('[data-field="reviewed"]').checked = false;}
        void persist(d).catch(() => {});
    }
    async function rowAction(action,id) {
        const d = drafts.find(d => d.id===id); if (!d) return;
        if (action==='sasom') {
            if (!d.setCode || !d.cardNumber) return notify('กรอกรหัส Set และเลขการ์ดก่อนค้นราคา',true);
            const url = new URL('https://sasom.co.th/th/shop');
            url.searchParams.set('query',`${d.setCode} ${d.cardNumber}`); url.searchParams.set('type','ask');
            window.open(url.href,'_blank','noopener,noreferrer'); return;
        }
        if (action==='remove' && !confirm('ลบรูปและฉบับร่างใบนี้?')) return;
        setBusy(true);
        try {
            await flush();
            if (action==='remove') {
                await dbOp('readwrite',store => store.delete(id));
                drafts = drafts.filter(d => d.id!==id);
                URL.revokeObjectURL(previews.get(id)); previews.delete(id); failedWrites.delete(id); render();
            } else if (action==='read') {await recognizeDraft(d);}
            else if (action==='match') {matchDraft(d); await persist(d); render();}
        } catch (error) {notify(error.message,true);}
        finally {setBusy(false);}
    }
    function validate(d) {
        if (!d.name.trim() || !d.set.trim()) throw new Error('กรอกชื่อการ์ดและชื่อ Set ให้ครบ');
        if (!['NM','LP','MP','HP'].includes(d.condition)) throw new Error(`เลือกสภาพการ์ด: ${d.name}`);
        if (!Number.isSafeInteger(Number(d.qty)) || Number(d.qty)<1) throw new Error(`จำนวนต้องเป็นจำนวนเต็มอย่างน้อย 1: ${d.name}`);
        for (const field of ['price','buyPrice']) {
            const text = String(d[field] ?? '').trim();
            if (field==='buyPrice' && text==='') continue;
            if (text==='' || !Number.isFinite(Number(text)) || Number(text)<0) throw new Error(`กรอกราคา/ต้นทุนให้ถูกต้อง: ${d.name}`);
        }
    }
    async function submit() {
        if (busy) return;
        const selected = drafts.filter(d => d.reviewed);
        if (!selected.length) return notify('ติ๊ก “ตรวจข้อมูลแล้ว” ในรายการที่จะบันทึกก่อนค่ะ', true);
        setBusy(true);
        try {
            await flush(); selected.forEach(validate);
            const seen = new Set();
            const duplicates = selected.filter(d => {
                const k = key(d), usable = d.setCode && d.cardNumber;
                const duplicate = usable && (seen.has(k) || localCards().some(c => key(c)===k));
                seen.add(k); return duplicate;
            });
            if (duplicates.length && !confirm(`พบ ${duplicates.length} รายการที่อาจซ้ำกับคลังหรือชุดสแกนนี้\n`+
                'รุ่นนี้จะเพิ่มเป็นรายการใหม่ ยังไม่รวมจำนวนกับรายการเดิม\n'+
                'หากเป็นภาพซ้ำ ให้ยกเลิกแล้วลบภาพซ้ำก่อน\n\nยืนยันเพิ่มเป็นรายการใหม่ทั้งหมดที่เลือก?')) return;
            const result = await TcgTasks.enqueueScannedCards(selected.map(d => ({draftId:d.id,blob:d.blob,
                payload:{action:'add',name:d.name,set:d.set,setCode:d.setCode,cardNumber:d.cardNumber,
                    rarity:d.rarity,language:d.language,condition:d.condition,qty:d.qty,
                    price:d.price,buyPrice:d.buyPrice,tags:d.tags}})));
            if (result.status !== 'queued') throw new Error('คิวงานยังไม่ยืนยันรับรายการ');
            const ids = new Set(result.items.map(item => item.draftId));
            // If this cleanup fails, a repeated enqueue reuses the same stable IDs.
            try {await dbOp('readwrite',store => ids.forEach(id => store.delete(id)));}
            catch {notify('รับเข้าคิวแล้ว แต่ล้างฉบับร่างไม่สำเร็จ ตรวจแถบงานก่อนส่งอีกครั้ง',true); return;}
            drafts = drafts.filter(d => !ids.has(d.id));
            ids.forEach(id => {URL.revokeObjectURL(previews.get(id)); previews.delete(id);});
            render(); setBusy(false); await close();
            notify(`รับ ${ids.size} รายการเข้าคิวแล้ว · รูปและข้อมูลกำลังส่งเบื้องหลัง`);
        } catch (error) {notify(error.message,true);}
        finally {setBusy(false);}
    }
    return {open};
})();
