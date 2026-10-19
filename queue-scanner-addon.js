/* Paste INSIDE the TcgTasks IIFE, immediately before its final return {...}. */
async function enqueueScannedCards(items) {
    if (!adminPin) throw new Error('กรุณาเข้าสู่ระบบผู้ดูแลก่อน');
    if (!Array.isArray(items) || !items.length || items.length > 30) {
        throw new Error('ส่งครั้งละ 1–30 รายการ');
    }
    const seen = new Set();
    const jobsToStore = items.map((item, index) => {
        if (!/^[a-f0-9-]{36}$/i.test(item.draftId) || seen.has(item.draftId)) {
            throw new Error('รหัสรายการสแกนไม่ถูกต้องหรือซ้ำ');
        }
        seen.add(item.draftId);
        const p = item.payload;
        if (!p || p.action !== 'add' || !String(p.name || '').trim() || !String(p.set || '').trim()) {
            throw new Error('กรอกชื่อการ์ดและ Set ให้ครบ');
        }
        if (!Number.isSafeInteger(Number(p.qty)) || Number(p.qty) < 1 ||
            String(p.price ?? '').trim() === '' || !Number.isFinite(Number(p.price)) || Number(p.price) < 0 ||
            (String(p.buyPrice ?? '').trim() !== '' && (!Number.isFinite(Number(p.buyPrice)) || Number(p.buyPrice) < 0))) {
            throw new Error('ตรวจจำนวน ราคา และต้นทุนอีกครั้ง');
        }
        if (!(item.blob instanceof Blob) || !['image/jpeg','image/png','image/webp'].includes(item.blob.type) ||
            !item.blob.size || item.blob.size > 20 * 1024 * 1024) {
            throw new Error('ไม่พบรูปการ์ด หรือรูปใหญ่เกิน 20 MB');
        }
        // Whitelist fields: scanner imports always create a new collection record.
        const clean = {action:'add', id:'', rowIndex:'', expectedVersion:'', isWishlist:false,
            name:String(p.name).trim(), set:String(p.set).trim(), setCode:String(p.setCode || '').trim(),
            cardNumber:String(p.cardNumber || '').trim(), rarity:String(p.rarity || '-'),
            language:String(p.language || 'TH'), condition:String(p.condition || 'NM'),
            qty:Number(p.qty), price:Number(p.price), buyPrice:String(p.buyPrice ?? '').trim() === '' ? '' : Number(p.buyPrice),
            tags:String(p.tags || ''), image:'', gradeCompany:'', gradeScore:'', certNumber:''};
        const fingerprint = JSON.stringify(clean);
        const id = 'SCAN-card-' + item.draftId;
        const imageId = 'SCAN-image-' + item.draftId;
        const base = {endpoint, createdAt:Date.now() + index * 2, state:'queued', attempts:0, nextAt:0, entity:''};
        return {id, imageId, fingerprint, blob:item.blob,
            imageJob:{...base, id:imageId, label:'อัปโหลดรูป · '+clean.name, stage:'รอคิว',
                payload:{action:'uploadImage', requestId:imageId, syncSchemaVersion:1, responseMode:'ack'}},
            cardJob:{...base, id, createdAt:base.createdAt+1, label:'เพิ่มการ์ด · '+clean.name,
                stage:'รอรูปภาพก่อนบันทึกการ์ด', imageTaskId:imageId, scannerFingerprint:fingerprint,
                payload:{...clean, requestId:id, syncSchemaVersion:1, responseMode:'ack'}}};
    });
    // All images + cards are committed locally in ONE transaction before any network request.
    // Stable draft IDs also protect a retry after a page reload during enqueue.
    const result = await transaction('readwrite', (store, done, images) => {
        store.getAll().onsuccess = e => {
            const existing = new Map(e.target.result.map(j => [j.id, j]));
            for (const item of jobsToStore) {
                const old = existing.get(item.id);
                if (old && (old.endpoint !== endpoint || old.scannerFingerprint !== item.fingerprint || old.state === 'cancelled')) {
                    done({error:'รายการนี้เคยส่งเข้าคิวแล้ว ให้ตรวจแถบงานก่อน อย่าสร้างรายการเดิมซ้ำ'});
                    return;
                }
                if (!old && existing.has(item.imageId)) {
                    done({error:'พบงานรูปเดิมที่ไม่ครบคู่ กรุณาตรวจแถบงาน'});
                    return;
                }
            }
            const accepted = [];
            for (const item of jobsToStore) {
                if (!existing.has(item.id)) {
                    store.add(item.imageJob);
                    images.add({id:item.imageId, blob:item.blob});
                    store.add(item.cardJob);
                }
                accepted.push({draftId:item.id.slice('SCAN-card-'.length), taskId:item.id});
            }
            done({accepted});
        };
    });
    if (result.error) throw new Error(result.error);
    signal(); kick(20);
    return {status:'queued', items:result.accepted};
}

// Also add enqueueScannedCards to the IIFE's final returned object:
// return {start, enqueueMutation, enqueueScannedCards, chooseImage, clearImage, copy, ...};
