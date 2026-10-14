/* TCG durable outbox. Load after the app's original inline script, via HTTPS. */
const TcgTasks = (() => {
    const DB_NAME = 'tcg-background-v1';
    const endpoint = API_URL;
    const active = job => !['done', 'cancelled'].includes(job.state);
    let dbPromise, busy = false, timer, protocolOK = false, lastProtocolCheck = 0;
    let currentImageTask = '', imageReady = Promise.resolve(), previewURL = '';
    let expanded = false, fatalMessage = '', channel;
    const titles = {add:'เพิ่มการ์ด', update:'แก้ไขการ์ด', delete:'ลบการ์ด', sell:'บันทึกขาย',
        addPack:'บันทึกแพ็ค', updateSaleDelivery:'บันทึกการจัดส่ง', saveBinderSettings:'แต่งปกแฟ้ม', uploadImage:'อัปโหลดรูป'};

    function database() {
        if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
            if (!globalThis.indexedDB || !navigator.locks) {
                reject(new Error('กรุณาเปิดเว็บผ่าน HTTPS ในเบราว์เซอร์ที่รองรับคิวงาน')); return;
            }
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => {
                req.result.createObjectStore('jobs', {keyPath:'id'});
                req.result.createObjectStore('images', {keyPath:'id'});
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
            req.onblocked = () => reject(new Error('กรุณาปิดแท็บเว็บเก่าแล้วลองใหม่'));
        });
        return dbPromise;
    }

    async function transaction(mode, operation) {
        const db = await database();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(['jobs','images'], mode);
            let result;
            tx.oncomplete = () => resolve(result);
            tx.onabort = () => reject(tx.error || new Error('เก็บงานในเครื่องไม่สำเร็จ'));
            tx.onerror = () => {};
            try { operation(tx.objectStore('jobs'), value => { result = value; }, tx.objectStore('images')); }
            catch (error) { tx.abort(); reject(error); }
        });
    }
    const list = () => transaction('readonly', (s, done) => {
        s.getAll().onsuccess = e => done(e.target.result.filter(j => j.endpoint === endpoint)
            .sort((a,b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)));
    });
    const get = id => transaction('readonly', (s, done) => {
        s.get(id).onsuccess = e => done(e.target.result);
    });
    const put = job => transaction('readwrite', (s, done, images) => {
        s.put(job);
        if (['done','cancelled'].includes(job.state)) images.delete(job.id);
    });
    const getImage = id => transaction('readonly', (s, done, images) => {
        images.get(id).onsuccess = e => done(e.target.result);
    });
    const putImage = image => transaction('readwrite', (s, done, images) => images.put(image));
    function signal() { channel?.postMessage('changed'); void render(); }
    const entity = p => ['update','delete','sell'].includes(p.action) ? 'card:'+p.id
        : p.action === 'saveBinderSettings' ? 'binder:'+p.setName
        : p.action === 'updateSaleDelivery' ? 'sale:'+p.saleId : '';

    async function enqueue(payload, extra = {}) {
        if (!adminPin) throw new Error('กรุณาเข้าสู่ระบบผู้ดูแลก่อน');
        const clean = JSON.parse(JSON.stringify(payload));
        delete clean.pin; delete clean.requestId;
        const id = 'REQ-' + crypto.randomUUID();
        const {blob, ...metadata} = extra;
        const job = {id, endpoint, createdAt:Date.now(), state:'queued', stage:'รอคิว', attempts:0,
            nextAt:0, entity:entity(clean), label:titles[clean.action] + ' · ' +
                (clean.name || clean.setName || clean.id || clean.saleId || extra.fileName || ''),
            payload:{...clean, requestId:id, syncSchemaVersion:1, responseMode:'ack'}, ...metadata};
        if (job.imageTaskId) job.stage = 'รอรูปภาพก่อนบันทึกการ์ด';
        // The check and insert share one transaction, including submissions from other tabs.
        await transaction('readwrite', (store, done, images) => {
            store.getAll().onsuccess = e => {
                const conflict = e.target.result.some(j => j.endpoint === endpoint &&
                    job.entity && j.entity === job.entity && active(j));
                if (conflict) { done(false); return; }
                store.add(job);
                if (blob) images.add({id,blob});
                done(true);
            };
        }).then(accepted => {
            if (!accepted) throw new Error('รายการนี้มีงานค้างอยู่แล้ว กรุณารอหรือตรวจแถบงานก่อน');
        });
        signal(); kick(20);
        return {status:'queued', taskId:id};
    }

    async function enqueueMutation(payload) {
        let dependency = '';
        if (['add','update'].includes(payload.action)) {
            const selected = currentImageTask;
            const pendingImage = imageReady;
            if (selected) dependency = selected.startsWith('local-') ? await pendingImage : selected;
        }
        return enqueue(payload, {imageTaskId:dependency});
    }

    function clearImage() {
        currentImageTask = ''; imageReady = Promise.resolve();
        if (previewURL) URL.revokeObjectURL(previewURL);
        previewURL = '';
    }
    function chooseImage(event) {
        const file = event.target.files?.[0];
        if (!file) return;
        if (!adminPin) { showToast('กรุณาเข้าสู่ระบบก่อน', 'error'); return; }
        if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024) {
            showToast('เลือกรูป JPG, PNG หรือ WebP ขนาดไม่เกิน 20 MB ค่ะ', 'error');
            event.target.value = ''; return;
        }
        clearImage();
        const session = 'local-' + crypto.randomUUID();
        currentImageTask = session;
        previewURL = URL.createObjectURL(file);
        document.getElementById('modal-image-preview').src = previewURL;
        document.getElementById('form-image').value = '';
        imageReady = enqueue({action:'uploadImage'}, {blob:file, fileName:file.name}).then(result => {
            if (currentImageTask === session) currentImageTask = result.taskId;
            showToast('รับรูปเข้าคิวแล้ว กรอกข้อมูลและกดบันทึกต่อได้ค่ะ');
            return result.taskId;
        }).catch(error => {
            showToast('ยังเก็บรูปไม่สำเร็จ: ' + error.message, 'error');
            throw error;
        });
        // Retain the rejected promise for Save, but avoid an unhandled rejection.
        void imageReady.catch(() => {});
    }

    async function prepareImage(blob) {
        const bitmap = await createImageBitmap(blob);
        try {
            const scale = Math.min(1, 1400 / Math.max(bitmap.width, bitmap.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(bitmap.width * scale));
            canvas.height = Math.max(1, Math.round(bitmap.height * scale));
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#fff'; ctx.fillRect(0,0,canvas.width,canvas.height);
            ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
            const jpg = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .82));
            if (!jpg || jpg.size > 1800000) throw new Error('รูปยังใหญ่เกินไป กรุณาเลือกรูปขนาดเล็กลง');
            return await new Promise((resolve,reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result).split(',')[1]);
                reader.onerror = () => reject(new Error('อ่านรูปไม่สำเร็จ'));
                reader.readAsDataURL(jpg);
            });
        } finally { bitmap.close(); }
    }

    async function complete(job, result = {}) {
        job.state = 'done'; job.stage = 'ยืนยันสำเร็จ'; job.result = result;
        job.completedAt = Date.now(); job.error = ''; delete job.blob;
        if (job.payload.action === 'uploadImage') delete job.payload.base64;
        await put(job); signal();
        showToast('✅ ' + job.label + ' สำเร็จ');
    }

    async function runJob(job) {
        let networkStarted = false;
        try {
            if (['sending','checking'].includes(job.state)) {
                job.state = 'checking'; job.stage = 'กำลังตรวจผลเดิม'; await put(job); signal();
                const reply = await requestApi({action:'mutationStatus', requestId:job.id,
                    pin:adminPin, responseMode:'ack'}, {timeout:30000});
                if (reply.backgroundSchemaVersion !== 1) throw syncApiError('ปลายทางเปลี่ยนเวอร์ชัน กรุณา Deploy รุ่นคิวงานก่อนตรวจต่อ','CONFIG',true);
                if (reply.requestId !== job.id) throw syncApiError('รหัสผลตรวจไม่ตรงกัน','RESPONSE',true);
                if (reply.mutationState === 'done') { await complete(job, reply.result || {}); return true; }
                if (reply.mutationState !== 'not_found') {
                    job.stage = 'รอยืนยันจากเซิร์ฟเวอร์ · ยังไม่ส่งซ้ำ';
                    job.nextAt = Date.now()+30000; await put(job); return false;
                }
                // A retry always reuses the exact persisted payload and request ID.
                job.state = 'queued';
            }
            if (job.imageTaskId && !job.imageResolved) {
                const image = await get(job.imageTaskId);
                if (!image || image.state !== 'done' || !image.result?.url) {
                    job.stage = 'รอรูปภาพ · ตรวจงานรูปในแถบงาน'; job.nextAt = Date.now()+5000;
                    await put(job); return false;
                }
                job.payload.image = image.result.url; job.imageResolved = true;
            }
            let media;
            if (job.payload.action === 'uploadImage') {
                media = await getImage(job.id);
                if (!media) throw new Error('ไม่พบรูปที่เก็บไว้ กรุณายกเลิกงานแล้วเลือกรูปใหม่');
            }
            if (media && !media.base64) {
                job.stage = 'กำลังย่อรูป'; await put(job); signal();
                media = {id:job.id,base64:await prepareImage(media.blob)};
                await putImage(media);
            }
            if (media) {
                job.payload.mimeType = 'image/jpeg'; job.payload.fileName = job.id+'.jpg';
            }
            job.state = 'sending'; job.attempts++; job.error = '';
            job.stage = job.payload.action === 'uploadImage' ? 'กำลังส่งรูปและรอลิงก์' : 'กำลังส่งและรอยืนยัน';
            await put(job); signal(); // Persist BEFORE any write goes to the server.
            networkStarted = true;
            const body = {...job.payload, pin:adminPin};
            if (media) body.base64=media.base64;
            const reply = await requestApi(body, {timeout:60000});
            if (reply.backgroundSchemaVersion !== 1 || reply.requestId !== job.id || reply.committed !== true) {
                throw syncApiError('ยังไม่ยืนยันผลบันทึก','RESPONSE',true);
            }
            await complete(job, reply.result || {});
            return true;
        } catch (error) {
            if (job.state === 'done') throw error; // Failed local commit: recover persisted sending state next time.
            const uncertain = error.uncertain || error.code === 'UNCERTAIN' || job.state === 'checking';
            const temporary = ['BUSY','OFFLINE','NETWORK','TIMEOUT','HTTP','RESPONSE'].includes(error.code);
            job.state = uncertain ? 'checking' : temporary ? 'queued' : 'failed';
            // Preparation errors have never reached Drive/Sheets.
            if (!networkStarted && !uncertain && !temporary) job.state = 'failed';
            job.stage = job.state === 'checking' ? 'รอตรวจผลเดิม' : job.state === 'failed' ? 'ต้องตรวจข้อมูล' : 'รอลองใหม่';
            job.error = error.message;
            job.nextAt = Date.now()+Math.min(60000, 5000*Math.pow(2, Math.min(job.attempts,4)));
            await put(job); signal();
            return false;
        }
    }

    function kick(delay = 1000) { clearTimeout(timer); timer = setTimeout(() => void pump(),delay); }
    async function pump() {
        if (busy) return;
        busy = true;
        try {
            const jobs = await list();
            if (!jobs.some(j => active(j) && j.state !== 'failed')) return;
            if (!adminPin || navigator.onLine === false || syncState.pending || syncState.writing) return;
            await navigator.locks.request('tcg-outbox:'+endpoint, {ifAvailable:true}, async lock => {
                if (!lock) return;
                if (!protocolOK && lastProtocolCheck && Date.now()-lastProtocolCheck < 30000) return;
                if (!protocolOK || Date.now()-lastProtocolCheck > 300000) {
                    const snapshot = await requestApi(null, {force:true});
                    applySnapshot(snapshot);
                    lastProtocolCheck = Date.now(); protocolOK = snapshot.backgroundSchemaVersion === 1;
                    if (!protocolOK) { fatalMessage = 'กรุณา Deploy หลังบ้านรุ่นคิวงานก่อน'; return; }
                }
                fatalMessage = '';
                let committed = 0;
                for (let count=0; count<4; count++) {
                    if (!adminPin || navigator.onLine === false || syncState.pending || syncState.writing) break;
                    const fresh = await list();
                    const byId = new Map(fresh.map(j => [j.id,j]));
                    const job = fresh.find(j => ['queued','sending','checking'].includes(j.state) &&
                        (!j.nextAt || j.nextAt <= Date.now()) &&
                        (j.state !== 'queued' || !j.imageTaskId || j.imageResolved || byId.get(j.imageTaskId)?.state === 'done'));
                    if (!job) break;
                    syncState.writing = true; stopReadsForWrite(); updateSyncStatus();
                    try { if (await runJob(job)) committed++; }
                    finally { syncState.writing = false; updateSyncStatus(); }
                }
                // One read for a small batch, instead of full snapshots after every POST.
                if (committed) await loadData({silent:true,force:true});
            });
        } catch (error) { fatalMessage = error.message || 'คิวงานหยุดชั่วคราว'; }
        finally { busy = false; void render(); kick(5000); scheduleDataSync(); }
    }

    let taskDockTimer = null;
    let taskDockDoneKey = '';
    
    function updateTaskDockVisibility(host, live, recent, hasError) {
        // มีงานค้างหรือข้อผิดพลาด ให้แสดงต่อ
        if (live.length || hasError) {
            clearTimeout(taskDockTimer);
            taskDockTimer = null;
    
            host.hidden = false;
            host.classList.remove('task-fade-out');
            return true;
        }
    
        const latest = recent.reduce((newest, job) =>
            !newest || job.completedAt > newest.completedAt
                ? job
                : newest
        , null);
    
        if (!latest) {
            clearTimeout(taskDockTimer);
            taskDockTimer = null;
            host.hidden = true;
            return false;
        }
    
        const doneKey = latest.id + ':' + latest.completedAt;
    
        // งานเดิมที่ซ่อนไปแล้ว ไม่ต้องแสดงซ้ำตอนตรวจคิว
        if (doneKey === taskDockDoneKey) {
            return !host.hidden;
        }
    
        taskDockDoneKey = doneKey;
        clearTimeout(taskDockTimer);
    
        expanded = false;
        host.hidden = false;
        host.classList.remove('task-fade-out');
    
        taskDockTimer = setTimeout(() => {
            host.classList.add('task-fade-out');
    
            taskDockTimer = setTimeout(() => {
                host.hidden = true;
                taskDockTimer = null;
            }, 300);
        }, 1800);
    
        return true;
    }

    async function render() {
        const host = document.getElementById('task-dock');
        if (!host) return;
        let jobs;
        try { jobs = await list(); } catch (error) { host.hidden=false; host.textContent=error.message; return; }
        const live = jobs.filter(active);
        const recent = jobs.filter(j => j.state === 'done' && Date.now()-j.completedAt < 300000);
        const shown = [...live, ...recent.slice(-4)];
        const visible = updateTaskDockVisibility(
            host,
            live,
            recent,
            !!fatalMessage
        );
        const image = jobs.find(j => j.id === currentImageTask && j.state === 'done');
        if (image?.result?.url) {
            document.getElementById('form-image').value = image.result.url;
            document.getElementById('modal-image-preview').src = getSafeImageUrl(image.result.url);
            clearImage();
        }
        if (!visible) return;
        const status = fatalMessage || (navigator.onLine === false ? 'ออฟไลน์ · เก็บงานไว้ในเครื่องแล้ว'
            : !adminPin ? 'เข้าสู่ระบบเพื่อส่งงานต่อ' : syncState.pending ? 'ตรวจผลรายการเก่าในแถบซิงก์ก่อน'
            : live.length ? 'งานค้าง '+live.length+' รายการ' : 'งานล่าสุดเสร็จแล้ว');
        const done = recent.length, total = done+live.length;
        host.innerHTML = `<button type="button" class="task-heading" onclick="TcgTasks.toggle()">
            <span>☁️ ${escapeHtml(status)}</span><span>${expanded?'▾':'▴'}</span></button>
            <progress max="${Math.max(1,total)}" value="${done}" aria-label="จำนวนงานที่เสร็จแล้ว"></progress>
            <small>เสร็จ ${done}/${total} งานล่าสุด · กดเพื่อดูรายละเอียด</small>
            ${expanded ? `<div class="task-items">${shown.map(j => `<article>
                <strong>${escapeHtml(j.label)}</strong><p>${escapeHtml(j.stage)}</p>
                ${j.error ? `<p class="task-error">${escapeHtml(j.error)}</p>` : ''}
                ${j.state === 'failed' ? `<button onclick="TcgTasks.retry('${j.id}')">ลองใหม่</button>` : ''}
                ${['queued','failed'].includes(j.state) ? `<button onclick="TcgTasks.cancel('${j.id}')">ยกเลิกงาน</button>` : ''}
                ${j.state !== 'done' ? `<button onclick="TcgTasks.copy('${j.id}')">คัดลอกข้อมูลที่กรอก</button>` : ''}
                ${j.result?.url ? `<button onclick="TcgTasks.copy('${j.id}')">คัดลอกลิงก์รูป</button>` : ''}
            </article>`).join('')}</div>` : ''}`;
    }

    async function changeJob(id, cancel) {
        await navigator.locks.request('tcg-outbox:'+endpoint, {ifAvailable:true}, async lock => {
            if (!lock) { showToast('กำลังส่งงานอยู่ รอสักครู่แล้วลองใหม่ค่ะ','error'); return; }
            const job = await get(id);
            if (!job || job.endpoint !== endpoint || !['queued','failed'].includes(job.state)) return;
            if (cancel) {
                if (!confirm('ยกเลิกงานนี้และงานการ์ดที่รอรูปนี้? ข้อมูลยังไม่ได้บันทึกสำเร็จ')) return;
                job.state = 'cancelled'; delete job.blob; delete job.payload.base64;
                for (const child of (await list()).filter(j => j.imageTaskId === id && ['queued','failed'].includes(j.state))) {
                    child.state='cancelled'; await put(child);
                }
                if (currentImageTask === id) clearImage();
            } else { job.state='queued'; job.nextAt=0; job.error=''; }
            await put(job); signal();
        });
        kick(20);
    }

    async function copy(id) {
        try {
            const job = await get(id);
            if (!job || job.endpoint !== endpoint) return;
            const data = {...job.payload}; delete data.base64;
            await navigator.clipboard.writeText(job.result?.url || JSON.stringify(data,null,2));
            showToast('คัดลอกแล้ว');
        } catch { showToast('คัดลอกไม่สำเร็จ กรุณาอนุญาตคลิปบอร์ด','error'); }
    }
    function start() {
        if ('BroadcastChannel' in globalThis) {
            channel = new BroadcastChannel('tcg-background');
            channel.onmessage = () => { void render(); kick(); };
        }
        for (const event of ['online','focus','pageshow']) window.addEventListener(event,() => {void render();kick(20);});
        window.addEventListener('offline',() => void render());
        document.addEventListener('visibilitychange',() => {if (!document.hidden) {void render();kick(20);}});
        document.getElementById('form-image').addEventListener('input',clearImage);
        void render(); kick(20);
    }
    return {start, enqueueMutation, chooseImage, clearImage, copy,
        toggle() {expanded=!expanded;void render();},
        retry:id=>changeJob(id,false).catch(e=>showToast(e.message,'error')),
        cancel:id=>changeJob(id,true).catch(e=>showToast(e.message,'error'))};
})();
TcgTasks.start();
