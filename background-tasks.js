const TcgTasks = (() => {
    const DB_NAME = 'tcg-background-v1';
    const endpoint = API_URL;
    const active = job => !['done', 'cancelled'].includes(job.state);

    let dbPromise;
    let busy = false;
    let timer;
    let protocolOK = false;
    let lastProtocolCheck = 0;

    let currentImageTask = '';
    let imageReady = Promise.resolve();
    let previewURL = '';

    let expanded = false;
    let fatalMessage = '';
    let channel;
    let started = false;
    let renderVersion = 0;

    const titles = {
        add: 'เพิ่มการ์ด',
        update: 'แก้ไขการ์ด',
        delete: 'ลบการ์ด',
        sell: 'บันทึกขาย',
        addPack: 'บันทึกแพ็ค',
        updateSaleDelivery: 'บันทึกการจัดส่ง',
        saveBinderSettings: 'แต่งปกแฟ้ม',
        uploadImage: 'อัปโหลดรูป'
    };

    function database() {
        if (!dbPromise) {
            dbPromise = new Promise((resolve, reject) => {
                if (!globalThis.indexedDB || !navigator.locks) {
                    reject(new Error(
                        'กรุณาเปิดเว็บผ่าน HTTPS ในเบราว์เซอร์ที่รองรับคิวงาน'
                    ));
                    return;
                }

                const req = indexedDB.open(DB_NAME, 1);

                req.onupgradeneeded = () => {
                    req.result.createObjectStore('jobs', {
                        keyPath: 'id'
                    });

                    req.result.createObjectStore('images', {
                        keyPath: 'id'
                    });
                };

                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);

                req.onblocked = () => reject(new Error(
                    'กรุณาปิดแท็บเว็บเก่าแล้วลองใหม่'
                ));
            });
        }

        return dbPromise;
    }

    async function transaction(mode, operation) {
        const db = await database();

        return new Promise((resolve, reject) => {
            const tx = db.transaction(['jobs', 'images'], mode);
            let result;

            tx.oncomplete = () => resolve(result);

            tx.onabort = () => reject(
                tx.error || new Error('เก็บงานในเครื่องไม่สำเร็จ')
            );

            tx.onerror = () => {};

            try {
                operation(
                    tx.objectStore('jobs'),
                    value => {
                        result = value;
                    },
                    tx.objectStore('images')
                );
            } catch (error) {
                tx.abort();
                reject(error);
            }
        });
    }

    const list = () => transaction('readonly', (store, done) => {
        store.getAll().onsuccess = event => {
            done(
                event.target.result
                    .filter(job => job.endpoint === endpoint)
                    .sort((a, b) =>
                        a.createdAt - b.createdAt ||
                        a.id.localeCompare(b.id)
                    )
            );
        };
    });

    const get = id => transaction('readonly', (store, done) => {
        store.get(id).onsuccess = event => {
            done(event.target.result);
        };
    });

    const put = job => transaction(
        'readwrite',
        (store, done, images) => {
            store.put(job);

            if (['done', 'cancelled'].includes(job.state)) {
                images.delete(job.id);
            }
        }
    );

    const getImage = id => transaction(
        'readonly',
        (store, done, images) => {
            images.get(id).onsuccess = event => {
                done(event.target.result);
            };
        }
    );

    const putImage = image => transaction(
        'readwrite',
        (store, done, images) => {
            images.put(image);
        }
    );

    function signal() {
        channel?.postMessage('changed');
        void render();
    }

    const entity = payload =>
        ['update', 'delete', 'sell'].includes(payload.action)
            ? 'card:' + payload.id
            : payload.action === 'saveBinderSettings'
                ? 'binder:' + payload.setName
                : payload.action === 'updateSaleDelivery'
                    ? 'sale:' + payload.saleId
                    : '';

    async function enqueue(payload, extra = {}) {
        if (!adminPin) {
            throw new Error('กรุณาเข้าสู่ระบบผู้ดูแลก่อน');
        }

        const clean = JSON.parse(JSON.stringify(payload));

        delete clean.pin;
        delete clean.requestId;

        const id = 'REQ-' + crypto.randomUUID();
        const {blob, ...metadata} = extra;

        const job = {
            id,
            endpoint,
            createdAt: Date.now(),
            state: 'queued',
            stage: 'รอคิว',
            attempts: 0,
            nextAt: 0,
            entity: entity(clean),
            label: titles[clean.action] + ' · ' + (
                clean.name ||
                clean.setName ||
                clean.id ||
                clean.saleId ||
                extra.fileName ||
                ''
            ),
            payload: {
                ...clean,
                requestId: id,
                syncSchemaVersion: 1,
                responseMode: 'ack'
            },
            ...metadata
        };

        if (job.imageTaskId) {
            job.stage = 'รอรูปภาพก่อนบันทึกการ์ด';
        }

        // ตรวจงานซ้ำและบันทึกภายใน transaction เดียวกัน
        await transaction('readwrite', (store, done, images) => {
            store.getAll().onsuccess = event => {
                const conflict = event.target.result.some(existing =>
                    existing.endpoint === endpoint &&
                    job.entity &&
                    existing.entity === job.entity &&
                    active(existing)
                );

                if (conflict) {
                    done(false);
                    return;
                }

                store.add(job);

                if (blob) {
                    images.add({id, blob});
                }

                done(true);
            };
        }).then(accepted => {
            if (!accepted) {
                throw new Error(
                    'รายการนี้มีงานค้างอยู่แล้ว กรุณารอหรือตรวจแถบงานก่อน'
                );
            }
        });

        signal();
        kick(20);

        return {
            status: 'queued',
            taskId: id
        };
    }

    async function enqueueMutation(payload) {
        let dependency = '';

        if (['add', 'update'].includes(payload.action)) {
            const selected = currentImageTask;
            const pendingImage = imageReady;

            if (selected) {
                dependency = selected.startsWith('local-')
                    ? await pendingImage
                    : selected;
            }
        }

        return enqueue(payload, {
            imageTaskId: dependency
        });
    }

    function clearImage() {
        currentImageTask = '';
        imageReady = Promise.resolve();

        if (previewURL) {
            URL.revokeObjectURL(previewURL);
        }

        previewURL = '';
    }

    function chooseImage(event) {
        const file = event.target.files?.[0];

        if (!file) return;

        if (!adminPin) {
            showToast('กรุณาเข้าสู่ระบบก่อน', 'error');
            return;
        }

        if (
            !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
            file.size > 20 * 1024 * 1024
        ) {
            showToast(
                'เลือกรูป JPG, PNG หรือ WebP ขนาดไม่เกิน 20 MB ค่ะ',
                'error'
            );

            event.target.value = '';
            return;
        }

        clearImage();

        const session = 'local-' + crypto.randomUUID();

        currentImageTask = session;
        previewURL = URL.createObjectURL(file);

        document.getElementById('modal-image-preview').src = previewURL;
        document.getElementById('form-image').value = '';

        imageReady = enqueue(
            {action: 'uploadImage'},
            {blob: file, fileName: file.name}
        ).then(result => {
            if (currentImageTask === session) {
                currentImageTask = result.taskId;
            }

            showToast(
                'รับรูปเข้าคิวแล้ว กรอกข้อมูลและกดบันทึกต่อได้ค่ะ'
            );

            return result.taskId;
        }).catch(error => {
            showToast(
                'ยังเก็บรูปไม่สำเร็จ: ' + error.message,
                'error'
            );

            throw error;
        });

        void imageReady.catch(() => {});
    }

    async function prepareImage(blob) {
        const bitmap = await createImageBitmap(blob);

        try {
            const scale = Math.min(
                1,
                1400 / Math.max(bitmap.width, bitmap.height)
            );

            const canvas = document.createElement('canvas');

            canvas.width = Math.max(
                1,
                Math.round(bitmap.width * scale)
            );

            canvas.height = Math.max(
                1,
                Math.round(bitmap.height * scale)
            );

            const ctx = canvas.getContext('2d');

            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

            const jpg = await new Promise(resolve => {
                canvas.toBlob(resolve, 'image/jpeg', 0.82);
            });

            if (!jpg || jpg.size > 1800000) {
                throw new Error(
                    'รูปยังใหญ่เกินไป กรุณาเลือกรูปขนาดเล็กลง'
                );
            }

            return await new Promise((resolve, reject) => {
                const reader = new FileReader();

                reader.onload = () => {
                    resolve(String(reader.result).split(',')[1]);
                };

                reader.onerror = () => {
                    reject(new Error('อ่านรูปไม่สำเร็จ'));
                };

                reader.readAsDataURL(jpg);
            });
        } finally {
            bitmap.close();
        }
    }

    async function complete(job, result = {}) {
        job.state = 'done';
        job.stage = 'ยืนยันสำเร็จ';
        job.result = result;
        job.completedAt = Date.now();
        job.error = '';

        delete job.blob;

        if (job.payload.action === 'uploadImage') {
            delete job.payload.base64;
        }

        await put(job);
        signal();

        showToast('✅ ' + job.label + ' สำเร็จ');
    }

    async function runJob(job) {
        let networkStarted = false;

        try {
            if (['sending', 'checking'].includes(job.state)) {
                job.state = 'checking';
                job.stage = 'กำลังตรวจผลเดิม';

                await put(job);
                signal();

                const reply = await requestApi({
                    action: 'mutationStatus',
                    requestId: job.id,
                    pin: adminPin,
                    responseMode: 'ack'
                }, {
                    timeout: 30000
                });

                if (reply.backgroundSchemaVersion !== 1) {
                    throw syncApiError(
                        'ปลายทางเปลี่ยนเวอร์ชัน กรุณา Deploy รุ่นคิวงานก่อนตรวจต่อ',
                        'CONFIG',
                        true
                    );
                }

                if (reply.requestId !== job.id) {
                    throw syncApiError(
                        'รหัสผลตรวจไม่ตรงกัน',
                        'RESPONSE',
                        true
                    );
                }

                if (reply.mutationState === 'done') {
                    await complete(job, reply.result || {});
                    return true;
                }

                if (reply.mutationState !== 'not_found') {
                    job.stage = 'รอยืนยันจากเซิร์ฟเวอร์ · ยังไม่ส่งซ้ำ';
                    job.nextAt = Date.now() + 30000;

                    await put(job);
                    return false;
                }

                // ส่งซ้ำด้วย requestId และข้อมูลเดิมเท่านั้น
                job.state = 'queued';
            }

            if (job.imageTaskId && !job.imageResolved) {
                const image = await get(job.imageTaskId);

                if (
                    !image ||
                    image.state !== 'done' ||
                    !image.result?.url
                ) {
                    job.stage = 'รอรูปภาพ · ตรวจงานรูปในแถบงาน';
                    job.nextAt = Date.now() + 5000;

                    await put(job);
                    return false;
                }

                const imageField =
                    job.payload.action === 'saveBinderSettings'
                        ? 'coverImage'
                        : 'image';

                job.payload[imageField] = image.result.url;
                job.imageResolved = true;
            }

            let media;

            if (job.payload.action === 'uploadImage') {
                media = await getImage(job.id);

                if (!media) {
                    throw new Error(
                        'ไม่พบรูปที่เก็บไว้ กรุณายกเลิกงานแล้วเลือกรูปใหม่'
                    );
                }
            }

            if (media && !media.base64) {
                job.stage = 'กำลังย่อรูป';

                await put(job);
                signal();

                media = {
                    id: job.id,
                    base64: await prepareImage(media.blob)
                };

                await putImage(media);
            }

            if (media) {
                job.payload.mimeType = 'image/jpeg';
                job.payload.fileName = job.id + '.jpg';
            }

            job.state = 'sending';
            job.attempts++;
            job.error = '';

            job.stage = job.payload.action === 'uploadImage'
                ? 'กำลังส่งรูปและรอลิงก์'
                : 'กำลังส่งและรอยืนยัน';

            // เก็บสถานะก่อนส่งข้อมูลจริงเสมอ
            await put(job);
            signal();

            networkStarted = true;

            const body = {
                ...job.payload,
                pin: adminPin
            };

            if (media) {
                body.base64 = media.base64;
            }

            const reply = await requestApi(body, {
                timeout: 60000
            });

            if (
                reply.backgroundSchemaVersion !== 1 ||
                reply.requestId !== job.id ||
                reply.committed !== true
            ) {
                throw syncApiError(
                    'ยังไม่ยืนยันผลบันทึก',
                    'RESPONSE',
                    true
                );
            }

            await complete(job, reply.result || {});
            return true;
        } catch (error) {
            // ถ้าเซิร์ฟเวอร์ยืนยันแล้ว แต่เก็บผลในเครื่องไม่สำเร็จ
            // ให้ตรวจ receipt จากสถานะ sending ที่เก็บไว้ในรอบถัดไป
            if (job.state === 'done') throw error;

            const uncertain =
                error.uncertain ||
                error.code === 'UNCERTAIN' ||
                job.state === 'checking';

            const temporary = [
                'BUSY',
                'OFFLINE',
                'NETWORK',
                'TIMEOUT',
                'HTTP',
                'RESPONSE'
            ].includes(error.code);

            job.state = uncertain
                ? 'checking'
                : temporary
                    ? 'queued'
                    : 'failed';

            if (!networkStarted && !uncertain && !temporary) {
                job.state = 'failed';
            }

            job.stage = job.state === 'checking'
                ? 'รอตรวจผลเดิม'
                : job.state === 'failed'
                    ? 'ต้องตรวจข้อมูล'
                    : 'รอลองใหม่';

            job.error = error.message;

            job.nextAt = Date.now() + Math.min(
                60000,
                5000 * Math.pow(2, Math.min(job.attempts, 4))
            );

            await put(job);
            signal();

            return false;
        }
    }

    function kick(delay = 1000) {
        clearTimeout(timer);
        timer = setTimeout(() => void pump(), delay);
    }

    async function pump() {
        if (busy) return;

        busy = true;
        let pausedReads = false;

        try {
            const jobs = await list();

            if (!jobs.some(job =>
                active(job) && job.state !== 'failed'
            )) {
                return;
            }

            if (
                !adminPin ||
                navigator.onLine === false ||
                syncState.pending ||
                syncState.writing
            ) {
                return;
            }

            await navigator.locks.request(
                'tcg-outbox:' + endpoint,
                {ifAvailable: true},
                async lock => {
                    if (!lock) return;

                    if (
                        !protocolOK &&
                        lastProtocolCheck &&
                        Date.now() - lastProtocolCheck < 30000
                    ) {
                        return;
                    }

                    if (
                        !protocolOK ||
                        Date.now() - lastProtocolCheck > 300000
                    ) {
                        const snapshot = await requestApi(null, {
                            force: true
                        });

                        applySnapshot(snapshot);

                        lastProtocolCheck = Date.now();
                        protocolOK =
                            snapshot.backgroundSchemaVersion === 1;

                        if (!protocolOK) {
                            fatalMessage =
                                'กรุณา Deploy หลังบ้านรุ่นคิวงานก่อน';
                            return;
                        }
                    }

                    fatalMessage = '';
                    let committed = 0;

                    for (let count = 0; count < 4; count++) {
                        if (
                            !adminPin ||
                            navigator.onLine === false ||
                            syncState.pending ||
                            syncState.writing
                        ) {
                            break;
                        }

                        const fresh = await list();
                        const byId = new Map(
                            fresh.map(job => [job.id, job])
                        );

                        const job = fresh.find(item =>
                            ['queued', 'sending', 'checking']
                                .includes(item.state) &&
                            (!item.nextAt || item.nextAt <= Date.now()) &&
                            (
                                item.state !== 'queued' ||
                                !item.imageTaskId ||
                                item.imageResolved ||
                                byId.get(item.imageTaskId)?.state === 'done'
                            )
                        );

                        if (!job) break;

                        syncState.writing = true;
                        pausedReads = true;

                        stopReadsForWrite();
                        updateSyncStatus();

                        try {
                            if (await runJob(job)) committed++;
                        } finally {
                            syncState.writing = false;
                            updateSyncStatus();
                        }
                    }

                    if (committed) {
                        await loadData({
                            silent: true,
                            force: true
                        });
                    }
                }
            );
        } catch (error) {
            fatalMessage = error.message || 'คิวงานหยุดชั่วคราว';
        } finally {
            busy = false;

            void render();
            kick(5000);

            // ไม่เลื่อนเวลาซิงก์ออกไปเรื่อย ๆ ตอนคิวว่าง
            if (pausedReads && !syncState.readPromise) {
                scheduleDataSync();
            }
        }
    }

    let taskDockTimer = null;
    let taskDockDoneKey = '';

    function updateTaskDockVisibility(host, live, recent, hasError) {
        if (live.length || hasError) {
            taskDockDoneKey = '';

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

        const version = ++renderVersion;
        let jobs;

        try {
            jobs = await list();
        } catch (error) {
            if (version !== renderVersion) return;

            host.hidden = false;
            host.classList.remove('task-fade-out');
            host.textContent = error.message;

            return;
        }

        if (version !== renderVersion) return;

        const live = jobs.filter(active);

        const recent = jobs.filter(job =>
            job.state === 'done' &&
            Date.now() - job.completedAt < 300000
        );

        const shown = [
            ...live,
            ...recent.slice(-4)
        ];

        const visible = updateTaskDockVisibility(
            host,
            live,
            recent,
            !!fatalMessage
        );

        const image = jobs.find(job =>
            job.id === currentImageTask &&
            job.state === 'done'
        );

        if (image?.result?.url) {
            document.getElementById('form-image').value =
                image.result.url;

            document.getElementById('modal-image-preview').src =
                getSafeImageUrl(image.result.url);

            clearImage();
        }

        if (!visible) return;

        if (expanded) {
            host.classList.add('task-expanded');
        } else {
            host.classList.remove('task-expanded');
        }

        const status = fatalMessage || (
            navigator.onLine === false
                ? 'ออฟไลน์ · เก็บงานไว้ในเครื่องแล้ว'
                : !adminPin
                    ? 'เข้าสู่ระบบเพื่อส่งงานต่อ'
                    : syncState.pending
                        ? 'ตรวจผลรายการเก่าในแถบซิงก์ก่อน'
                        : live.length
                            ? 'งานค้าง ' + live.length + ' รายการ'
                            : 'งานล่าสุดเสร็จแล้ว'
        );

        const done = recent.length;
        const total = done + live.length;

        host.innerHTML = `
            <button
                type="button"
                class="task-heading"
                aria-expanded="${expanded}"
                onclick="TcgTasks.toggle()"
            >
                <span>☁️ ${escapeHtml(status)}</span>
                <span>${expanded ? '▾' : '▴'}</span>
            </button>

            <progress
                max="${Math.max(1, total)}"
                value="${done}"
                aria-label="จำนวนงานที่เสร็จแล้ว"
            ></progress>

            <small>
                เสร็จ ${done}/${total} งานล่าสุด · กดเพื่อดูรายละเอียด
            </small>

            ${expanded ? `
                <div class="task-items">
                    ${shown.map(job => `
                        <article>
                            <strong>${escapeHtml(job.label)}</strong>
                            <p>${escapeHtml(job.stage)}</p>

                            ${job.error ? `
                                <p class="task-error">
                                    ${escapeHtml(job.error)}
                                </p>
                            ` : ''}

                            ${job.state === 'failed' ? `
                                <button onclick="TcgTasks.retry('${job.id}')">
                                    ลองใหม่
                                </button>
                            ` : ''}

                            ${['queued', 'failed'].includes(job.state) ? `
                                <button onclick="TcgTasks.cancel('${job.id}')">
                                    ยกเลิกงาน
                                </button>
                            ` : ''}

                            ${job.state !== 'done' ? `
                                <button onclick="TcgTasks.copy('${job.id}')">
                                    คัดลอกข้อมูลที่กรอก
                                </button>
                            ` : ''}

                            ${job.result?.url ? `
                                <button onclick="TcgTasks.copy('${job.id}')">
                                    คัดลอกลิงก์รูป
                                </button>
                            ` : ''}
                        </article>
                    `).join('')}
                </div>
            ` : ''}
        `;
    }

    async function changeJob(id, cancel) {
        await navigator.locks.request(
            'tcg-outbox:' + endpoint,
            {ifAvailable: true},
            async lock => {
                if (!lock) {
                    showToast(
                        'กำลังส่งงานอยู่ รอสักครู่แล้วลองใหม่ค่ะ',
                        'error'
                    );
                    return;
                }

                const job = await get(id);

                if (
                    !job ||
                    job.endpoint !== endpoint ||
                    !['queued', 'failed'].includes(job.state)
                ) {
                    return;
                }

                if (cancel) {
                    if (!confirm(
                        'ยกเลิกงานนี้และงานที่รอรูปนี้? ข้อมูลยังไม่ได้บันทึกสำเร็จ'
                    )) {
                        return;
                    }

                    job.state = 'cancelled';

                    delete job.blob;
                    delete job.payload.base64;

                    const children = (await list()).filter(child =>
                        child.imageTaskId === id &&
                        ['queued', 'failed'].includes(child.state)
                    );

                    for (const child of children) {
                        child.state = 'cancelled';
                        await put(child);
                    }

                    if (currentImageTask === id) {
                        clearImage();
                    }
                } else {
                    job.state = 'queued';
                    job.nextAt = 0;
                    job.error = '';
                }

                await put(job);
                signal();
            }
        );

        kick(20);
    }

    async function copy(id) {
        try {
            const job = await get(id);

            if (!job || job.endpoint !== endpoint) return;

            const data = {...job.payload};
            delete data.base64;

            await navigator.clipboard.writeText(
                job.result?.url || JSON.stringify(data, null, 2)
            );

            showToast('คัดลอกแล้ว');
        } catch {
            showToast(
                'คัดลอกไม่สำเร็จ กรุณาอนุญาตคลิปบอร์ด',
                'error'
            );
        }
    }

    function ensureTaskDock() {
        if (!document.getElementById('task-dock')) {
            const host = document.createElement('aside');

            host.id = 'task-dock';
            host.hidden = true;
            host.setAttribute('aria-label', 'สถานะงานเบื้องหลัง');

            document.body.appendChild(host);
        }

        if (document.getElementById('tcg-task-dock-style')) return;

        const style = document.createElement('style');
        style.id = 'tcg-task-dock-style';

        style.textContent = `
            #task-dock {
                position: fixed;
                right: 12px;
                bottom: calc(80px + env(safe-area-inset-bottom, 0px));
                z-index: 110;
                width: min(300px, calc(100vw - 24px));
                padding: 8px 10px;
                border: 1px solid #d1d5db;
                border-radius: 12px;
                background: #fff;
                color: #334155;
                box-shadow: 0 4px 18px #0002;
                font-size: 11px;
                opacity: 1;
                transform: translateY(0);
                transition: opacity .3s, transform .3s;
            }

            #task-dock[hidden] {
                display: none !important;
            }

            #task-dock .task-heading {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                width: 100%;
                padding: 0;
                border: 0;
                background: transparent;
                color: inherit;
                font: inherit;
                font-weight: 600;
                text-align: left;
                cursor: pointer;
            }

            #task-dock .task-heading > span:first-child {
                min-width: 0;
                overflow: hidden;
                white-space: nowrap;
                text-overflow: ellipsis;
            }

            #task-dock > progress,
            #task-dock > small {
                display: none;
            }

            #task-dock.task-expanded > progress {
                display: block;
                width: 100%;
                height: 4px;
                margin: 7px 0;
                accent-color: #10b981;
            }

            #task-dock.task-expanded > small {
                display: block;
                font-size: 10px;
                color: #64748b;
            }

            #task-dock .task-items {
                max-height: min(35vh, 300px);
                overflow: auto;
                margin-top: 6px;
            }

            #task-dock article {
                border-top: 1px solid #e5e7eb;
                padding: 8px 0;
                overflow-wrap: anywhere;
            }

            #task-dock article button {
                margin: 5px 5px 0 0;
                border: 1px solid #d1d5db;
                border-radius: 6px;
                padding: 4px 7px;
                background: #fff;
                color: #334155;
            }

            #task-dock .task-error {
                color: #b45309;
            }

            #task-dock.task-fade-out {
                opacity: 0;
                transform: translateY(6px);
                pointer-events: none;
            }

            @media (prefers-reduced-motion: reduce) {
                #task-dock {
                    transition: none;
                }
            }
        `;

        document.head.appendChild(style);
    }

    function start() {
        if (started) return;

        started = true;
        ensureTaskDock();

        if ('BroadcastChannel' in globalThis) {
            channel = new BroadcastChannel('tcg-background');

            channel.onmessage = () => {
                void render();
                kick();
            };
        }

        for (const event of ['online', 'focus', 'pageshow']) {
            window.addEventListener(event, () => {
                void render();
                kick(20);
            });
        }

        window.addEventListener('offline', () => void render());

        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                void render();
                kick(20);
            }
        });

        document.getElementById('form-image')
            ?.addEventListener('input', clearImage);

        void render();
        kick(20);
    }

    // นำเข้าการ์ดจากตัวสแกน พร้อมรูปของแต่ละใบ
    async function enqueueScannedCards(items) {
        if (!adminPin) {
            throw new Error('กรุณาเข้าสู่ระบบผู้ดูแลก่อน');
        }

        if (
            !Array.isArray(items) ||
            !items.length ||
            items.length > 30
        ) {
            throw new Error('ส่งครั้งละ 1–30 รายการ');
        }

        const seen = new Set();

        const jobsToStore = items.map((item, index) => {
            if (
                !/^[a-f0-9-]{36}$/i.test(item.draftId) ||
                seen.has(item.draftId)
            ) {
                throw new Error('รหัสรายการสแกนไม่ถูกต้องหรือซ้ำ');
            }

            seen.add(item.draftId);

            const p = item.payload;

            if (
                !p ||
                p.action !== 'add' ||
                !String(p.name || '').trim() ||
                !String(p.set || '').trim()
            ) {
                throw new Error('กรอกชื่อการ์ดและ Set ให้ครบ');
            }

            if (
                !Number.isSafeInteger(Number(p.qty)) ||
                Number(p.qty) < 1 ||
                String(p.price ?? '').trim() === '' ||
                !Number.isFinite(Number(p.price)) ||
                Number(p.price) < 0 ||
                (
                    String(p.buyPrice ?? '').trim() !== '' &&
                    (
                        !Number.isFinite(Number(p.buyPrice)) ||
                        Number(p.buyPrice) < 0
                    )
                )
            ) {
                throw new Error('ตรวจจำนวน ราคา และต้นทุนอีกครั้ง');
            }

            if (
                !(item.blob instanceof Blob) ||
                !['image/jpeg', 'image/png', 'image/webp']
                    .includes(item.blob.type) ||
                !item.blob.size ||
                item.blob.size > 20 * 1024 * 1024
            ) {
                throw new Error(
                    'ไม่พบรูปการ์ด หรือรูปใหญ่เกิน 20 MB'
                );
            }

            const clean = {
                action: 'add',
                id: '',
                rowIndex: '',
                expectedVersion: '',
                isWishlist: false,
                name: String(p.name).trim(),
                set: String(p.set).trim(),
                setCode: String(p.setCode || '').trim(),
                cardNumber: String(p.cardNumber || '').trim(),
                rarity: String(p.rarity || '-'),
                language: String(p.language || 'TH'),
                condition: String(p.condition || 'NM'),
                qty: Number(p.qty),
                price: Number(p.price),
                buyPrice: String(p.buyPrice ?? '').trim() === ''
                    ? ''
                    : Number(p.buyPrice),
                tags: String(p.tags || ''),
                image: '',
                gradeCompany: '',
                gradeScore: '',
                certNumber: ''
            };

            const fingerprint = JSON.stringify(clean);
            const id = 'SCAN-card-' + item.draftId;
            const imageId = 'SCAN-image-' + item.draftId;

            const base = {
                endpoint,
                createdAt: Date.now() + index * 2,
                state: 'queued',
                attempts: 0,
                nextAt: 0,
                entity: ''
            };

            return {
                id,
                imageId,
                fingerprint,
                blob: item.blob,

                imageJob: {
                    ...base,
                    id: imageId,
                    label: 'อัปโหลดรูป · ' + clean.name,
                    stage: 'รอคิว',
                    payload: {
                        action: 'uploadImage',
                        requestId: imageId,
                        syncSchemaVersion: 1,
                        responseMode: 'ack'
                    }
                },

                cardJob: {
                    ...base,
                    id,
                    createdAt: base.createdAt + 1,
                    label: 'เพิ่มการ์ด · ' + clean.name,
                    stage: 'รอรูปภาพก่อนบันทึกการ์ด',
                    imageTaskId: imageId,
                    scannerFingerprint: fingerprint,
                    payload: {
                        ...clean,
                        requestId: id,
                        syncSchemaVersion: 1,
                        responseMode: 'ack'
                    }
                }
            };
        });

        // เก็บรูปและรายการทุกใบใน transaction เดียวกัน
        const result = await transaction(
            'readwrite',
            (store, done, images) => {
                store.getAll().onsuccess = event => {
                    const existing = new Map(
                        event.target.result.map(job => [job.id, job])
                    );

                    for (const item of jobsToStore) {
                        const old = existing.get(item.id);

                        if (
                            old &&
                            (
                                old.endpoint !== endpoint ||
                                old.scannerFingerprint !== item.fingerprint ||
                                old.state === 'cancelled'
                            )
                        ) {
                            done({
                                error: 'รายการนี้เคยส่งเข้าคิวแล้ว ให้ตรวจแถบงานก่อน อย่าสร้างรายการเดิมซ้ำ'
                            });
                            return;
                        }

                        if (!old && existing.has(item.imageId)) {
                            done({
                                error: 'พบงานรูปเดิมที่ไม่ครบคู่ กรุณาตรวจแถบงาน'
                            });
                            return;
                        }
                    }

                    const accepted = [];

                    for (const item of jobsToStore) {
                        if (!existing.has(item.id)) {
                            store.add(item.imageJob);

                            images.add({
                                id: item.imageId,
                                blob: item.blob
                            });

                            store.add(item.cardJob);
                        }

                        accepted.push({
                            draftId: item.id.slice('SCAN-card-'.length),
                            taskId: item.id
                        });
                    }

                    done({accepted});
                };
            }
        );

        if (result.error) {
            throw new Error(result.error);
        }

        signal();
        kick(20);

        return {
            status: 'queued',
            items: result.accepted
        };
    }

    // บันทึกปกแฟ้ม พร้อมอัปโหลดรูปที่เลือกเอง
    async function enqueueBinderSettings(payload, file = null) {
        if (!adminPin) {
            throw new Error('กรุณาเข้าสู่ระบบผู้ดูแลก่อน');
        }

        if (payload.action !== 'saveBinderSettings') {
            throw new Error('คำสั่งแต่งปกไม่ถูกต้อง');
        }

        if (!file) {
            return enqueue(payload);
        }

        if (
            !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
            file.size > 20 * 1024 * 1024
        ) {
            throw new Error(
                'รูปต้องเป็น JPG, PNG หรือ WebP ไม่เกิน 20 MB'
            );
        }

        const clean = JSON.parse(JSON.stringify(payload));

        delete clean.pin;
        delete clean.requestId;

        clean.coverImage = '';
        clean.coverCardId = '';

        const imageId = 'REQ-' + crypto.randomUUID();
        const id = 'REQ-' + crypto.randomUUID();
        const createdAt = Date.now();

        const base = {
            endpoint,
            createdAt,
            state: 'queued',
            attempts: 0,
            nextAt: 0
        };

        const imageJob = {
            ...base,
            id: imageId,
            entity: '',
            stage: 'รออัปโหลดปก',
            label: 'อัปโหลดปก · ' + clean.setName,
            fileName: file.name || 'binder.jpg',
            payload: {
                action: 'uploadImage',
                requestId: imageId,
                syncSchemaVersion: 1,
                responseMode: 'ack'
            }
        };

        const binderJob = {
            ...base,
            id,
            entity: entity(clean),
            stage: 'รอรูปหน้าปก',
            label: 'แต่งปกแฟ้ม · ' + clean.setName,
            imageTaskId: imageId,
            payload: {
                ...clean,
                requestId: id,
                syncSchemaVersion: 1,
                responseMode: 'ack'
            }
        };

        const accepted = await transaction(
            'readwrite',
            (store, done, images) => {
                store.getAll().onsuccess = event => {
                    const conflict = event.target.result.some(job =>
                        job.endpoint === endpoint &&
                        job.entity === binderJob.entity &&
                        active(job)
                    );

                    if (conflict) {
                        done(false);
                        return;
                    }

                    store.add(imageJob);

                    images.add({
                        id: imageId,
                        blob: file
                    });

                    store.add(binderJob);
                    done(true);
                };
            }
        );

        if (!accepted) {
            throw new Error(
                'แฟ้มนี้มีงานค้างอยู่แล้ว กรุณารอหรือตรวจแถบงานก่อน'
            );
        }

        signal();
        kick(20);

        return {
            status: 'queued',
            taskId: id
        };
    }

    return {
        start,
        enqueueMutation,
        enqueueBinderSettings,
        enqueueScannedCards,
        chooseImage,
        clearImage,
        copy,

        toggle() {
            expanded = !expanded;
            void render();
        },

        retry: id => changeJob(id, false).catch(error => {
            showToast(error.message, 'error');
        }),

        cancel: id => changeJob(id, true).catch(error => {
            showToast(error.message, 'error');
        })
    };
})();

TcgTasks.start();
