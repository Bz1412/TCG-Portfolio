/* Free, local OCR. Load AFTER background-tasks.js. No API key is required. */
const CardScanner = (() => {
    'use strict';
    const endpoint = API_URL;
    const baseURL = new URL('.', document.currentScript.src);
    const MAX_DRAFTS = 30;
    let dialog, drafts = [], catalog = [], dbPromise, stream, workerPromise, codeWorkerPromise, libraryPromise;
    let busy = false, opening = false, releaseEditor, persistTail = Promise.resolve();
    let workerLanguage = '', visionPromise, vision, gate, cameraTimer, cameraGeneration = 0;
    let activeTab = 'camera', captured = false, latestId = '', detectorAvailable = false;
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

    const icons = {
        camera:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M8 5l1.5-2h5L16 5h4a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V7a2 2 0 012-2z"/><circle cx="12" cy="13" r="4"/></svg>',
        gallery:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8" cy="8" r="1.5"/><path d="M3 17l5-5 4 4 3-3 6 6"/></svg>',
        arrow:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 12h14m-5-5l5 5-5 5"/></svg>'
    };
    function build() {
        if (dialog) return;
        dialog = document.createElement('dialog');
        dialog.id = 'tcg-scanner'; dialog.setAttribute('aria-labelledby','scan-title');
        dialog.innerHTML = `
          <header class="scan-head">
            <div class="scan-brand"><span class="scan-brand-icon">${icons.camera}</span><div>
              <h2 id="scan-title">สแกนการ์ด</h2><p class="scan-note">เก็บใบโปรดเข้าคลังของคุณ</p></div></div>
            <button type="button" id="scan-close" class="scan-icon-button" aria-label="ปิดตัวสแกน">✕</button>
          </header>
          <nav class="scan-tabs" aria-label="ขั้นตอนสแกน">
            <button type="button" id="scan-tab-camera" class="is-active" aria-pressed="true" data-work>01 <span>สแกน</span></button>
            <button type="button" id="scan-tab-review" aria-pressed="false" data-work>02 <span>ตรวจรายการ</span><b id="scan-count">0</b></button>
          </nav>
          <main class="scan-body">
            <section id="scan-camera-pane" class="scan-camera-layout">
              <div class="scan-camera-column">
                <div class="scan-stage" id="scan-stage">
                  <video id="scan-video" autoplay muted playsinline></video>
                  <div class="scan-stage-label"><span class="scan-live-dot"></span><span id="scan-camera-label">พร้อมเริ่มสแกน</span></div>
                  <div class="scan-guide" id="scan-guide"><i></i><i></i><i></i><i></i></div>
                  <svg id="scan-outline" class="scan-outline" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true"><polygon id="scan-polygon" points=""/></svg>
                  <div class="scan-welcome" id="scan-welcome">
                    <span class="scan-welcome-icon">${icons.camera}</span><h3>เริ่มจากการ์ดหนึ่งใบ</h3>
                    <p>วางให้เห็นครบทั้งสี่มุม<br>ถือให้นิ่ง แล้วเราจะจับภาพให้</p>
                    <button type="button" id="scan-camera" class="scan-primary" data-work>เปิดกล้อง</button>
                  </div>
                  <div class="scan-camera-hint" id="scan-camera-hint" hidden>จัดการ์ดให้อยู่ในกรอบ</div>
                </div>
                <div class="scan-camera-toolbar">
                  <button type="button" id="scan-files-button" class="scan-tool" data-work>${icons.gallery}<span>เลือกรูป</span></button>
                  <button type="button" id="scan-capture" class="scan-shutter" disabled aria-label="ถ่ายภาพการ์ดด้วยตนเอง"><span></span></button>
                  <button type="button" id="scan-next" class="scan-tool" disabled>${icons.arrow}<span>ใบถัดไป</span></button>
                  <input type="file" id="scan-files" accept="image/jpeg,image/png,image/webp" multiple hidden>
                </div>
                <p id="scan-status" class="scan-status" role="status" aria-live="polite">เปิดกล้อง หรือเลือกรูปการ์ดจากเครื่อง</p>
                <details class="scan-settings"><summary>ตัวเลือกการสแกน <span>ภาษา · รหัส Set</span></summary>
                  <div class="scan-fields">
                    <label>ภาษาบนการ์ด<select id="scan-language" data-work><option value="TH">ไทย + อังกฤษ</option><option value="JP">ญี่ปุ่น + อังกฤษ</option><option value="EN">อังกฤษ</option><option value="CN">จีนตัวย่อ + อังกฤษ</option><option value="TW">จีนตัวเต็ม + อังกฤษ</option></select></label>
                    <label>รหัส Set (ถ้าทราบ)<input id="scan-set-hint" list="scan-set-codes" placeholder="เช่น MA6 T" data-work><datalist id="scan-set-codes"></datalist></label>
                    <label>บริเวณอ่านเลขการ์ด<select id="scan-region" data-work><option value="bottom">ส่วนล่างของการ์ด</option><option value="full">ทั้งหน้าการ์ด</option></select></label>
                    <label class="scan-check"><input type="checkbox" id="scan-auto" checked data-work>จับภาพอัตโนมัติเมื่อการ์ดนิ่ง</label>
                  </div>
                  <p class="scan-note">ถ่ายหน้าการ์ดทีละใบ ตั้งตรง บนพื้นเรียบที่สีตัดกับการ์ด</p>
                  <button type="button" id="scan-stop" hidden>ปิดกล้อง</button>
                </details>
              </div>
              <aside class="scan-latest-panel">
                <div class="scan-section-label">ใบล่าสุด <span id="scan-latest-badge">รอสแกน</span></div>
                <div id="scan-latest" class="scan-latest"></div>
                <div id="scan-strip" class="scan-strip" aria-label="รูปที่สแกนไว้"></div>
                <button type="button" id="scan-review-next" class="scan-primary scan-wide-button" data-work>ตรวจข้อมูลและราคา ${icons.arrow}</button>
                <p class="scan-note scan-center">ยังไม่บันทึกเข้าคลังจนกว่าคุณจะยืนยัน</p>
              </aside>
            </section>
            <section id="scan-review-pane" hidden><div class="scan-review-heading"><div><h3>ตรวจให้พร้อม แล้วค่อยบันทึก</h3>
              <p class="scan-note">กดรายการเพื่อแก้ไขชื่อ สภาพ ราคา และจำนวน</p></div><span id="scan-reviewed-count"></span></div>
              <div id="scan-drafts"></div></section>
          </main>
          <footer class="scan-foot" id="scan-review-footer" hidden><span class="scan-note" id="scan-save-hint">เลือกเฉพาะใบที่ตรวจแล้ว</span>
            <button type="button" id="scan-submit" class="scan-primary">บันทึกที่ยืนยัน</button></footer>
          <div id="scan-photo-view" class="scan-photo-view" hidden role="dialog" aria-label="ภาพการ์ดเต็มใบ" aria-modal="true">
            <button type="button" id="scan-photo-close" class="scan-icon-button" aria-label="ปิดภาพเต็มใบ">✕</button><img id="scan-photo" alt="ภาพการ์ดเต็มใบ">
          </div>`;
        document.body.appendChild(dialog);
        $('scan-close').addEventListener('click', close);
        dialog.addEventListener('cancel', event => {event.preventDefault(); if (!$('scan-photo-view').hidden) hidePhoto(); else void close();});
        $('scan-camera').addEventListener('click', () => void startCamera());
        $('scan-stop').addEventListener('click', stopCamera);
        $('scan-capture').addEventListener('click', () => void capture(false));
        $('scan-next').addEventListener('click', nextCard);
        $('scan-auto').addEventListener('change', () => gate?.reset());
        $('scan-tab-camera').addEventListener('click', () => switchTab('camera'));
        $('scan-tab-review').addEventListener('click', () => switchTab('review'));
        $('scan-review-next').addEventListener('click', () => switchTab('review'));
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
        $('scan-latest').addEventListener('click', event => {if (event.target.closest('[data-photo]')) showPhoto(latestId);});
        $('scan-strip').addEventListener('click', event => {
            const button=event.target.closest('[data-photo]');if(button)showPhoto(button.dataset.photo);
        });
        $('scan-photo-close').addEventListener('click', hidePhoto);
        $('scan-photo-view').addEventListener('click', event => {if(event.target===$('scan-photo-view'))hidePhoto();});
        window.addEventListener('pagehide', stopCamera);
        document.addEventListener('visibilitychange', () => {if (document.hidden) stopCamera();});
    }
    function switchTab(tab) {
        if (busy) return;
        activeTab=tab;
        if(tab==='review') stopCamera();
        $('scan-camera-pane').hidden=tab!=='camera';$('scan-review-pane').hidden=tab!=='review';$('scan-review-footer').hidden=tab!=='review';
        for(const name of ['camera','review']) {
            $('scan-tab-'+name).classList.toggle('is-active',tab===name);
            $('scan-tab-'+name).setAttribute('aria-pressed',String(tab===name));
        }
        updateCounts();
    }
    function updateCounts() {
        const count=drafts.filter(d=>d.reviewed).length;
        $('scan-count').textContent=String(drafts.length);
        $('scan-reviewed-count').textContent=`ตรวจแล้ว ${count}/${drafts.length}`;
        $('scan-submit').textContent=count?`บันทึก ${count} รายการ`:'บันทึกที่ยืนยัน';
    }
    function showPhoto(id) {
        if(!previews.has(id))return;
        dialog.querySelectorAll('.scan-head,.scan-tabs,.scan-body,.scan-foot').forEach(el=>{el.inert=true;});
        $('scan-photo').src=previews.get(id);$('scan-photo-view').hidden=false;$('scan-photo-close').focus();
    }
    function hidePhoto() {
        $('scan-photo-view').hidden=true;
        dialog.querySelectorAll('.scan-head,.scan-tabs,.scan-body,.scan-foot').forEach(el=>{el.inert=false;});
        $('scan-close').focus();
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
            switchTab('camera');
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
        resetWorkers();
        hidePhoto();
        dialog.close();
        previews.forEach(url => URL.revokeObjectURL(url)); previews.clear();
        releaseEditor?.(); releaseEditor = null;
    }
    function setBusy(value) {
        busy = value;
        dialog.querySelectorAll('[data-work],#scan-submit,#scan-drafts input,#scan-drafts select,#scan-drafts button')
            .forEach(el => {el.disabled = value;});
        $('scan-capture').disabled = value || !stream || captured;
        $('scan-next').disabled = value || !stream || !captured;
    }
    async function loadCatalog() {
        try {
            const response = await fetch(new URL('card-catalog.json', baseURL), {cache:'no-cache', signal:AbortSignal.timeout(12000)});
            if (!response.ok) throw new Error('catalog');
            const rows = await response.json();
            if (!Array.isArray(rows)) throw new Error('catalog');
            catalog = rows.filter(c => c && typeof c === 'object' && c.setCode && c.cardNumber && c.language);
            if(!stream)status('พร้อมสแกน · เลือกภาษาในการตั้งค่าให้ตรงกับการ์ด');
        } catch {catalog = []; if(!stream)status('พร้อมสแกน · ใช้ข้อมูลอ้างอิงจากคลังเดิม');}
        const codes = [...new Set([...catalog,...localCards()].map(c => String(c.setCode || '').trim()).filter(Boolean))];
        $('scan-set-codes').innerHTML = codes.map(c => `<option value="${esc(c)}"></option>`).join('');
    }

    function deadline(promise,ms,message) {
        let timer;
        return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),ms);})])
            .finally(()=>clearTimeout(timer));
    }
    function loadScript(url,id) {
        return new Promise((resolve,reject)=>{
            const script=document.createElement('script');script.src=url;script.id=id;script.async=true;
            const timer=setTimeout(()=>{script.remove();reject(new Error('โหลดตัวอ่านไม่สำเร็จ ตรวจอินเทอร์เน็ตแล้วลองใหม่'));},30000);
            script.onload=()=>{clearTimeout(timer);resolve();};
            script.onerror=()=>{clearTimeout(timer);script.remove();reject(new Error('โหลดตัวอ่านไม่ได้ ตรวจอินเทอร์เน็ตแล้วลองใหม่'));};
            document.head.appendChild(script);
        });
    }
    async function loadVision() {
        if(!visionPromise) visionPromise=(async()=>{
            if(!window.TcgCardVision)await loadScript(new URL('card-vision.js?v=2',baseURL).href,'tcg-card-vision-script');
            const v=window.TcgCardVision;
            await v.ready();vision=v;return v;
        })().catch(error=>{visionPromise=null;throw error;});
        return visionPromise;
    }
    function cameraHint(text) {if($('scan-camera-hint'))$('scan-camera-hint').textContent=text;}
    async function startCamera() {
        if (busy || stream) return;
        const generation=++cameraGeneration;
        setBusy(true);captured=false;detectorAvailable=false;
        try {
            if (!navigator.mediaDevices?.getUserMedia) throw new Error('เบราว์เซอร์นี้เปิดกล้องไม่ได้ ใช้ปุ่มเลือกรูปแทนค่ะ');
            const media = await navigator.mediaDevices.getUserMedia({audio:false, video:{
                facingMode:{ideal:'environment'}, width:{ideal:1920}, height:{ideal:1080}}});
            if(generation!==cameraGeneration || document.hidden || !dialog.open){media.getTracks().forEach(t=>t.stop());return;}
            stream=media;$('scan-stop').hidden=false;$('scan-welcome').hidden=true;$('scan-camera-hint').hidden=false;
            $('scan-video').srcObject=stream;
            await $('scan-video').play();
            $('scan-camera-label').textContent='กล้องพร้อม';
            cameraHint('จัดให้เห็นครบทั้งสี่มุม');status('กำลังเตรียมจับขอบ · กดปุ่มกลมเพื่อถ่ายเองได้');
            void loadVision().then(v=>{
                if(generation!==cameraGeneration || !stream)return;
                detectorAvailable=true;gate=v.createGate();
                status('ถือให้นิ่งสักครู่ ระบบจะจับภาพเต็มใบให้');scheduleCamera();
            }).catch(error=>{if(generation===cameraGeneration&&stream){status(error.message);cameraHint('ใช้ปุ่มกลมถ่ายตามกรอบ');}});
        } catch (error) {
            stopCamera();
            notify(error.name === 'NotAllowedError' ? 'ยังไม่ได้อนุญาตกล้อง ใช้เลือกรูปได้ หรืออนุญาตกล้องในตั้งค่าเบราว์เซอร์' : error.message, true);
        } finally {setBusy(false);}
    }
    function stopCamera() {
        cameraGeneration++;clearTimeout(cameraTimer);gate?.reset();detectorAvailable=false;captured=false;
        stream?.getTracks().forEach(track => track.stop()); stream = null;
        if ($('scan-video')) $('scan-video').srcObject = null;
        if ($('scan-stop')) $('scan-stop').hidden = true;
        if ($('scan-capture')) $('scan-capture').disabled = true;
        if ($('scan-next')) $('scan-next').disabled = true;
        if ($('scan-welcome')) $('scan-welcome').hidden=false;
        if ($('scan-camera-hint')) $('scan-camera-hint').hidden=true;
        if ($('scan-camera-label')) $('scan-camera-label').textContent='พร้อมเริ่มสแกน';
        drawOutline(null);
    }
    function nextCard() {
        if(busy || !stream)return;
        captured=false;gate?.reset();drawOutline(null);setBusy(false);
        cameraHint('วางใบถัดไป แล้วถือให้นิ่ง');status('พร้อมอ่านใบถัดไป');scheduleCamera();
    }
    function grabFrame(maxHeight=2000) {
        const video=$('scan-video'),w=video.videoWidth,h=video.videoHeight;
        if(!w||!h||!video.clientHeight)throw new Error('กล้องยังไม่พร้อม ลองอีกครั้ง');
        const aspect=video.clientWidth/video.clientHeight;
        let sw=w,sh=h;
        if(w/h>aspect)sw=h*aspect;else sh=w/aspect;
        const scale=Math.min(1,maxHeight/sh),canvas=document.createElement('canvas');
        canvas.width=Math.max(1,Math.round(sw*scale));canvas.height=Math.max(1,Math.round(sh*scale));
        canvas.getContext('2d').drawImage(video,(w-sw)/2,(h-sh)/2,sw,sh,0,0,canvas.width,canvas.height);
        return canvas;
    }
    function drawOutline(detection,progress=0) {
        if(!$('scan-polygon'))return;
        $('scan-polygon').setAttribute('points',detection?detection.points.map(p=>`${p.x*1000},${p.y*1000}`).join(' '):'');
        $('scan-outline').classList.toggle('is-steady',progress>=.6);
        $('scan-guide').classList.toggle('has-card',!!detection);
    }
    function scheduleCamera() {
        clearTimeout(cameraTimer);
        if(stream && activeTab==='camera' && detectorAvailable) cameraTimer=setTimeout(tickCamera,260);
    }
    function tickCamera() {
        if(!stream || activeTab!=='camera')return;
        if(busy || captured || document.hidden || !$('scan-photo-view').hidden){scheduleCamera();return;}
        try {
            const frame=grabFrame(640),detection=vision.detect(frame);
            const result=gate.update(detection?.points||null,detection?vision.signature(frame):null,performance.now());
            drawOutline(detection,result.progress);
            if(!detection)cameraHint('ให้เห็นครบทั้งสี่มุม · ใช้พื้นหลังสีตัดกับการ์ด');
            else if(!$('scan-auto').checked){cameraHint('พบขอบการ์ดแล้ว · กดปุ่มกลมเพื่อถ่าย');gate.reset();}
            else if(result.ready){void capture(true);return;}
            else cameraHint(`ถือให้นิ่ง · ${Math.round(result.progress*100)}%`);
        } catch(error) {
            detectorAvailable=false;status('จับขอบไม่สำเร็จ · ใช้ปุ่มกลมถ่ายตามกรอบได้');drawOutline(null);
        }
        scheduleCamera();
    }
    const toBlob = canvas => new Promise((resolve,reject) => canvas.toBlob(blob =>
        blob ? resolve(blob) : reject(new Error('แปลงรูปไม่สำเร็จ')), 'image/jpeg', .92));
    function cropGuide(frame) {
        const guide=$('scan-guide').getBoundingClientRect(),stage=$('scan-stage').getBoundingClientRect();
        // Include a small margin outside the guide, so its border does not cut card edges.
        const x=Math.max(0,(guide.left-stage.left)/stage.width-.012),y=Math.max(0,(guide.top-stage.top)/stage.height-.012);
        const w=Math.min(1-x,guide.width/stage.width+.024),h=Math.min(1-y,guide.height/stage.height+.024);
        const out=document.createElement('canvas');out.width=Math.round(w*frame.width);out.height=Math.round(h*frame.height);
        out.getContext('2d').drawImage(frame,x*frame.width,y*frame.height,w*frame.width,h*frame.height,0,0,out.width,out.height);
        return out;
    }
    async function capture(automatic=false) {
        if (busy || !stream || captured) return;
        if (drafts.length >= MAX_DRAFTS) {captured=true;setBusy(false);return notify('มีฉบับร่างครบ 30 รายการแล้ว บันทึกหรือลบบางรายการก่อนค่ะ',true);}
        setBusy(true);clearTimeout(cameraTimer);
        try {
            const frame=grabFrame();
            const small=document.createElement('canvas');const scale=Math.min(1,640/frame.height);
            small.width=Math.round(frame.width*scale);small.height=Math.round(frame.height*scale);small.getContext('2d').drawImage(frame,0,0,small.width,small.height);
            const detection=detectorAvailable?vision.detect(small):null;
            // Re-detect on the captured frame; never warp with stale corners.
            if(automatic&&!detection){gate?.reset();return;}
            const output=detection?vision.warp(frame,detection.points):cropGuide(frame);
            captured=true;gate?.latch();cameraHint('รับภาพแล้ว · กำลังอ่านชื่อและเลขการ์ด');
            $('scan-camera-label').textContent='รับภาพแล้ว';
            await addPhoto(await toBlob(output),{sourceBlob:await toBlob(frame),cropMethod:detection?'จับขอบและปรับภาพตรง':'ถ่ายตามกรอบ'});
            cameraHint('เปลี่ยนการ์ด แล้วกด “ใบถัดไป”');
            status('เก็บภาพไว้ตรวจแล้ว · กดใบถัดไป หรือไปตรวจข้อมูล');
        } catch (error) {captured=true;notify(error.message,true);cameraHint('กดใบถัดไปเพื่อลองใหม่');}
        finally {setBusy(false);scheduleCamera();}
    }
    async function importFiles(files) {
        if (busy || !files.length) return;
        const room = MAX_DRAFTS - drafts.length;
        if (files.length > room) return notify(`เพิ่มได้อีก ${room} รูป กรุณาเลือกใหม่`, true);
        stopCamera();
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
    async function addPhoto(file, options = {}) {
        const blob = await normalizePhoto(file);
        const d = {id:crypto.randomUUID(),endpoint,createdAt:Date.now(),blob,reviewed:false,
            name:'',set:'',setCode:$('scan-set-hint').value.trim(),cardNumber:'',rarity:'-',
            language:$('scan-language').value,condition:'',qty:'1',price:'',buyPrice:'',tags:'',
            ocrText:'',nameText:'',nameSource:'',sourceBlob:options.sourceBlob || null,
            cropMethod:options.cropMethod || 'ภาพที่เลือก',note:'กำลังอ่านชื่อและเลขการ์ด…'};
        await persist(d); // Keep the photo even if OCR/model download later fails.
        drafts.push(d); latestId=d.id; render();
        await recognizeDraft(d);
    }
    async function loadOCR() {
        if (window.Tesseract) return;
        if (!libraryPromise) libraryPromise=loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js','tcg-tesseract-script')
            .then(()=>{if(!window.Tesseract)throw new Error('เปิด OCR ไม่สำเร็จ');})
            .catch(error=>{libraryPromise=null;throw error;});
        return libraryPromise;
    }
    function ocrLanguages(language) {
        return ({TH:['eng','tha'],JP:['eng','jpn'],EN:['eng'],CN:['eng','chi_sim'],TW:['eng','chi_tra']})[language] || ['eng'];
    }
    async function worker(language='EN') {
        await loadOCR();
        if(language==='CODE'||language==='EN') {
            if(!codeWorkerPromise)codeWorkerPromise=createOCRWorker(['eng']).catch(error=>{codeWorkerPromise=null;throw error;});
            return codeWorkerPromise;
        }
        if(workerPromise && workerLanguage!==language) {
            const old=workerPromise;workerPromise=null;
            await old.then(w=>w.terminate()).catch(()=>{});
        }
        if (!workerPromise) {
            workerLanguage=language;
            workerPromise=createOCRWorker(ocrLanguages(language)).catch(error=>{workerPromise=null;throw error;});
        }
        return workerPromise;
    }
    function resetWorkers() {
        const old=[workerPromise,codeWorkerPromise];workerPromise=null;codeWorkerPromise=null;
        for(const promise of old)if(promise)void promise.then(w=>w.terminate()).catch(()=>{});
    }
    function createOCRWorker(langs) {
            const pending=Tesseract.createWorker(langs,1,{
                workerPath:'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/worker.min.js',
                corePath:'https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0',
                logger:m=>{
                    if(m.status==='recognizing text')status(`กำลังอ่านข้อมูล ${Math.round((m.progress||0)*100)}%`);
                    else status('กำลังเตรียมตัวอ่าน · ครั้งแรกอาจใช้เวลาสักครู่');
                }
            });
            return deadline(pending,75000,'เตรียมตัวอ่านนานเกินไป รูปยังเก็บไว้แล้ว ลองอ่านใหม่ได้')
                .then(async w=>{await w.setParameters({tessedit_pageseg_mode:Tesseract.PSM.SPARSE_TEXT,preserve_interword_spaces:'1'});return w;})
                .catch(error=>{void pending.then(w=>w.terminate()).catch(()=>{});throw error;});
    }
    async function ocrImage(blob,kind,language,pass=0) {
        const bitmap=await createImageBitmap(blob);
        try {
            const name=kind==='name';
            const top=name?Math.floor(bitmap.height*.018):$('scan-region').value==='bottom'?Math.floor(bitmap.height*(pass===2?.64:.80)):0;
            const left=name?Math.floor(bitmap.width*.035):0;
            const width=name?Math.floor(bitmap.width*.93):bitmap.width;
            const height=name?Math.floor(bitmap.height*(pass===0?.14:.245)):bitmap.height-top;
            const scale=Math.min(4,2000/width),canvas=document.createElement('canvas');
            const border=24;
            canvas.width=Math.max(1,Math.round(width*scale))+border*2;canvas.height=Math.max(1,Math.round(height*scale))+border*2;
            const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);
            ctx.drawImage(bitmap,left,top,width,height,border,border,canvas.width-border*2,canvas.height-border*2);
            if(pass===1) {
                const pixels=ctx.getImageData(0,0,canvas.width,canvas.height),data=pixels.data;
                for(let i=0;i<data.length;i+=4){const gray=.299*data[i]+.587*data[i+1]+.114*data[i+2];const value=Math.max(0,Math.min(255,(gray-128)*1.45+128));data[i]=data[i+1]=data[i+2]=value;}
                ctx.putImageData(pixels,0,0);
            }
            const w=await worker(name?language:'CODE');
            await w.setParameters({tessedit_pageseg_mode:Tesseract.PSM.SPARSE_TEXT,
                tessedit_char_whitelist:name?'':'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/ -',user_defined_dpi:'300'});
            const result=await deadline(w.recognize(canvas),45000,'อ่านข้อความนานเกินไป กรุณาลองอ่านใหม่');
            return {text:result.data.text||'',confidence:Number(result.data.confidence)||0};
        } finally {bitmap.close();}
    }
    function validNameScript(name,language) {
        if(!name||/[\uFFFD\u0000-\u001F]/u.test(name))return false;
        const letters=name.replace(/(?:ex|EX|GX|VMAX|VSTAR|V|LV\.?\s*X)$/u,'').match(/\p{L}/gu)||[];
        const scripts={TH:/\p{Script=Thai}/u,JP:/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー々]/u,
            CN:/\p{Script=Han}/u,TW:/\p{Script=Han}/u,EN:/\p{Script=Latin}/u};
        const script=scripts[language];
        if(script&&(!letters.length||letters.filter(c=>script.test(c)).length/letters.length<.8))return false;
        return !/[^\p{L}\p{M}\p{N}\s'’!?.♀♂:()\-é]/u.test(name);
    }
    function extractNames(text,language) {
        const skip=/^(?:BASIC|STAGE\s*\d?|TRAINER'?S?|POK[EÉ]MON|SUPPORTER|ITEM|ENERGY|พื้นฐาน|ร่าง\s*\d|เทรนเนอร์|ไอเท็ม|ซัพพอร์ต|พลังงาน|たね|[12１２]進化|トレーナーズ|サポート|グッズ|エネルギー|基础|基礎|基本|[12１２一二]\s*[阶階]?\s*[进進]化|训练家|訓練家|支援者|支持者|物品|道具|能量|宝可梦|寶可夢)$/iu;
        const names=String(text||'').split(/\r?\n/).map(line=>line
            .replace(/(?:[HＨ][PＰ]\s*[0-9０-９]+|[0-9０-９]+\s*[HＨ][PＰ])/gi,'')
            .replace(/^(?:BASIC|STAGE\s*\d|พื้นฐาน|ร่าง\s*\d|たね|[12１２]進化|基础|基礎|基本|[12１２一二]\s*[阶階]?\s*[进進]化)\s+/iu,'')
            .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{M}\p{N}'’!?.♀♂-]+$/gu,'').trim().normalize('NFC'))
            .filter(line=>line.length>=2&&line.length<=60&&!skip.test(line)&&
                (line.match(/\p{L}/gu)||[]).length>=2&&validNameScript(line,language)&&! /evolves?\s+from|วิวัฒนาการจาก|から進化|[进進]化自|[由从從].*[进進]化/i.test(line));
        return names;
    }
    function extractName(text,language) {
        return extractNames(text,language)[0]||'';
    }
    function agree(values,normalize=value=>value) {
        const nonempty=values.filter(Boolean),keys=[...new Set(nonempty.map(normalize))];
        return keys.length===1&&nonempty.length>=2?nonempty[0]:'';
    }
    function consensusCodes(reads,knownCodes) {
        const parsed=reads.map(r=>r.confidence>=35?parseCodes(r.text,knownCodes):{setCode:'',cardNumber:'',rarity:'-'});
        return {setCode:agree(parsed.map(r=>r.setCode),normCode),cardNumber:agree(parsed.map(r=>r.cardNumber),normNumber),
            rarity:agree(parsed.map(r=>r.rarity==='-'?'':r.rarity))||'-'};
    }
    function consensusName(reads,language) {
        const votes=new Map();
        for(const r of reads) {
            if(r.confidence<50)continue;
            const seen=new Set();
            for(const name of extractNames(r.text,language)) {
                const key=name.replace(/\s+/g,'').toLowerCase();if(seen.has(key))continue;seen.add(key);
                const entry=votes.get(key)||{name,count:0};entry.count++;votes.set(key,entry);
            }
        }
        const matches=[...votes.values()].filter(v=>v.count>=2);
        return matches.length===1?matches[0].name:'';
    }
    function parseCodes(raw, knownCodes = []) {
        const text = String(raw || '').normalize('NFKC').toUpperCase().replace(/[／⁄]/g,'/');
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
            const c = matches[0];
            if(!d.name||d.nameSource!=='manual'){d.name=String(c.name);d.nameSource='catalog';}
            d.set = String(c.set); d.rarity = String(c.rarity || '-');
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
        d.reviewed=false;
        try {
            const knownCodes=[...catalog,...localCards()].map(c=>c.setCode).filter(Boolean);
            const codeReads=[];
            for(let pass=0;pass<2;pass++)codeReads.push(await ocrImage(d.blob,'codes',d.language,pass));
            let codes=consensusCodes(codeReads,knownCodes);
            if(!codes.cardNumber||!codes.setCode){codeReads.push(await ocrImage(d.blob,'codes',d.language,2));codes=consensusCodes(codeReads,knownCodes);}
            d.ocrText=codeReads.map((r,i)=>`[ครั้งที่ ${i+1}]\n${r.text}`).join('\n');
            if (!d.setCode) d.setCode = codes.setCode;
            if (!d.cardNumber) d.cardNumber = codes.cardNumber;
            if (d.rarity === '-') d.rarity = codes.rarity;
            // Read actual header text even if this card has never been in the collection.
            const nameReads=[];
            for(let pass=0;pass<2;pass++)nameReads.push(await ocrImage(d.blob,'name',d.language,pass));
            d.nameText=nameReads.map((r,i)=>`[ครั้งที่ ${i+1}]\n${r.text}`).join('\n');
            const name=consensusName(nameReads,d.language);
            if(!d.name||d.nameSource==='ocr'){d.name=name;d.nameSource=name?'ocr':'';}
            matchDraft(d);
            if(d.nameSource==='ocr')d.note='ชื่ออ่านจากภาพ · ตรวจตัวสะกด รหัส และรุ่นก่อนบันทึก';
            if(!d.name||!d.setCode||!d.cardNumber)d.note+=' · ผลอ่านยังไม่ชัดเจน/ไม่ตรงกัน ช่องที่ว่างให้กรอกเองหรือถ่ายใหม่';
        } catch (error) {
            d.note = 'อ่านไม่ครบ: '+error.message+' · รูปยังอยู่ กรอกเองหรืออ่านใหม่ได้';
            resetWorkers();
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
        updateCounts();
        for(const d of drafts)if(!previews.has(d.id))previews.set(d.id,URL.createObjectURL(d.blob));
        const last=drafts.find(d=>d.id===latestId)||drafts.at(-1);
        latestId=last?.id||'';
        $('scan-latest-badge').textContent=last?'เก็บฉบับร่างแล้ว':'รอสแกน';
        $('scan-latest').innerHTML=last?`
          <button type="button" class="scan-latest-photo" data-photo="${last.id}" aria-label="ดูภาพการ์ดเต็มใบ"><img src="${previews.get(last.id)}" alt="${esc(last.name||'การ์ดใบล่าสุด')}"></button>
          <div class="scan-latest-info"><span class="scan-eyebrow">${last.nameSource==='catalog'?'พบข้อมูลอ้างอิง':last.nameSource==='ocr'?'ชื่อจากภาพ · รอตรวจ':'รอตรวจข้อมูล'}</span>
            <h3>${esc(last.name||(String(last.note).startsWith('กำลัง')?'กำลังอ่านการ์ด…':'ยังไม่ได้ระบุชื่อ'))}</h3><p>${esc([last.setCode,last.cardNumber].filter(Boolean).join(' · ')||'เติมรหัสในหน้าตรวจรายการได้')}</p>
            <span class="scan-crop-label">${esc(last.cropMethod||'ภาพการ์ด')} · แตะรูปดูเต็มใบ</span></div>`:
          `<div class="scan-empty-card"><span>${icons.gallery}</span><p>ภาพการ์ดจะอยู่ตรงนี้</p></div><div class="scan-latest-info"><h3>พร้อมเก็บใบต่อไป</h3><p>ชื่อและรหัสจะแสดงหลังอ่านภาพ</p></div>`;
        $('scan-strip').innerHTML=drafts.slice(-8).map(d=>`<button type="button" data-photo="${d.id}" aria-label="ดูภาพ ${esc(d.name||'การ์ด')}"><img src="${previews.get(d.id)}" alt=""></button>`).join('');
        $('scan-drafts').innerHTML = drafts.length ? drafts.map((d,i) => `<details class="scan-row" data-draft="${d.id}" ${i===0?'open':''}>
              <summary><img class="scan-thumb" src="${previews.get(d.id)}" alt="รูปการ์ด ${i+1}">
                <span class="scan-row-title"><strong>${esc(d.name||'ยังไม่ได้ระบุชื่อ')}</strong><span>${esc([d.setCode,d.cardNumber].filter(Boolean).join(' · ')||'เติมรายละเอียดการ์ด')}</span></span>
                <span class="scan-row-state">${d.reviewed?'✓ ตรวจแล้ว':'รอตรวจ'}</span><span class="scan-chevron">⌄</span></summary>
              <div class="scan-row-content"><p class="scan-note">${esc(d.note)}</p>
              <div class="scan-fields">
                <div class="scan-wide">${field(d,'name','ชื่อการ์ด *')}</div>
                ${field(d,'setCode','รหัส Set')}${field(d,'cardNumber','เลขการ์ด')}
                <div class="scan-wide">${field(d,'set','ชื่อ Set *')}</div>
                ${field(d,'rarity','ความหายาก')}${select(d,'language','ภาษา',[['TH','ไทย'],['JP','ญี่ปุ่น'],['EN','อังกฤษ'],['CN','จีนตัวย่อ'],['TW','จีนตัวเต็ม']])}
                ${select(d,'condition','สภาพ *',[['','เลือกสภาพ'],['NM','NM'],['LP','LP'],['MP','MP'],['HP','HP']])}
                ${field(d,'qty','จำนวน *','number','min="1" step="1"')}
                ${field(d,'price','ราคาต่อใบ (บาท) *','number','min="0" step="0.01"')}
                ${field(d,'buyPrice','ต้นทุนซื้อแยกต่อใบ','number','min="0" step="0.01" placeholder="ว่าง = ยังไม่ทราบ"')}
              </div>
              <details class="scan-extra"><summary>รูปภาพและข้อมูลเพิ่มเติม</summary>
                ${field(d,'tags','แท็ก / รุ่นพิเศษ')}
                <p class="scan-note">เปิดจากแพ็ค: ใส่ต้นทุนซื้อแยก 0 และบันทึกค่าแพ็คในส่วนต้นทุนเปิดแพ็ค</p>
                <div class="scan-controls"><button type="button" data-action="photo">ดูเต็มใบ</button><button type="button" data-action="rotate">หมุนภาพ</button>
                  ${d.sourceBlob?'<button type="button" data-action="original">ใช้ภาพก่อนครอป</button>':''}
                  <button type="button" data-action="read">อ่านใหม่</button><button type="button" data-action="match">เทียบรหัส</button></div>
                <pre class="scan-ocr">${esc([d.nameText,d.ocrText].filter(Boolean).join('\n\n')||'(ยังไม่มีข้อความ)')}</pre>
              </details>
              <div class="scan-controls"><button type="button" data-action="sasom">ค้นราคา SASOM ↗</button>
                <button type="button" class="scan-danger" data-action="remove">ลบรายการ</button></div>
              <label class="scan-review"><input type="checkbox" data-field="reviewed" ${d.reviewed?'checked':''}>ตรวจแล้ว พร้อมเพิ่มเป็นรายการใหม่</label>
              </div></details>`).join('') : '<div class="scan-review-empty"><h3>ยังไม่มีการ์ดรอตรวจ</h3><p>กลับไปหน้าสแกนแล้วถ่ายการ์ดใบแรกได้เลย</p></div>';
        setBusy(busy);
    }
    function editDraft(event) {
        if (busy) return;
        const input = event.target, name = input.dataset.field;
        if (!name || (event.type==='input' && input.type==='checkbox')) return;
        const row = input.closest('[data-draft]'), d = drafts.find(d => d.id===row.dataset.draft);
        if (!d) return;
        d[name] = name === 'reviewed' ? input.checked : input.value;
        if(name==='name')d.nameSource='manual';
        if (name !== 'reviewed') {d.reviewed = false; row.querySelector('[data-field="reviewed"]').checked = false;}
        const label=row.querySelector('.scan-row-state');if(label)label.textContent=d.reviewed?'✓ ตรวจแล้ว':'รอตรวจ';
        updateCounts();
        void persist(d).catch(() => {});
    }
    async function rowAction(action,id) {
        const d = drafts.find(d => d.id===id); if (!d) return;
        if(action==='photo'){showPhoto(id);return;}
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
            } else if(action==='original'||action==='rotate') {
                if(action==='original'&&d.sourceBlob){d.blob=d.sourceBlob;d.cropMethod='ภาพก่อนครอป';}
                else if(action==='rotate') {
                    const bitmap=await createImageBitmap(d.blob);
                    try {
                        const canvas=document.createElement('canvas');canvas.width=bitmap.height;canvas.height=bitmap.width;
                        const ctx=canvas.getContext('2d');ctx.translate(canvas.width,0);ctx.rotate(Math.PI/2);ctx.drawImage(bitmap,0,0);
                        d.blob=await toBlob(canvas);d.cropMethod='หมุนภาพแล้ว';
                    }finally{bitmap.close();}
                }
                d.reviewed=false;URL.revokeObjectURL(previews.get(id));previews.delete(id);
                await persist(d);render();status('ปรับรูปแล้ว กดอ่านใหม่ได้เมื่อตั้งภาพตรง');
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
