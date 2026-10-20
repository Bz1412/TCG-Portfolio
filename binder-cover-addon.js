/* Load once AFTER the main app and background-tasks.js. */
(() => {
    'use strict';
    const $ = id => document.getElementById(id);
    let file = null, previewURL = '', saving = false;
    const modal = $('binder-style-modal');
    const cardGroup = $('binder-cover-select').parentElement;
    const sourceGroup = document.createElement('div');
    sourceGroup.innerHTML = `<label for="binder-cover-source" class="text-sm font-bold">รูปแบบหน้าปก</label>
        <select id="binder-cover-source" class="w-full mt-1 border rounded-xl p-3 text-sm">
            <option value="card">เลือกการ์ดในคลัง / ไอคอนแฟ้ม</option>
            <option value="upload">อัปโหลดรูปเอง</option>
        </select>
        <label id="binder-upload-box" class="mt-3 text-sm" style="display:none" hidden>
            เลือกรูป JPG, PNG หรือ WebP (ไม่เกิน 20 MB)
            <input id="binder-cover-file" type="file" accept="image/jpeg,image/png,image/webp" class="block w-full mt-2 text-xs">
            <span id="binder-upload-note" class="block mt-2 text-xs text-gray-500"></span>
        </label>`;
    cardGroup.before(sourceGroup);
    $('binder-cover-source').addEventListener('change', () => previewBinderCover());
    $('binder-cover-file').addEventListener('change', event => {
        const selected = event.target.files?.[0];
        if (!selected) return;
        if (!['image/jpeg','image/png','image/webp'].includes(selected.type) || selected.size > 20*1024*1024) {
            event.target.value='';showToast('เลือกรูป JPG, PNG หรือ WebP ไม่เกิน 20 MB ค่ะ','error');return;
        }
        if (previewURL) URL.revokeObjectURL(previewURL);
        file=selected;previewURL=URL.createObjectURL(selected);previewBinderCover();
    });
    function cleanup() {
        if(previewURL) URL.revokeObjectURL(previewURL);
        previewURL='';file=null;$('binder-cover-file').value='';
    }
    modal.addEventListener('close',cleanup);
    modal.addEventListener('cancel',event=>{if(saving)event.preventDefault();});
    const previousOpen=openBinderStyle;
    openBinderStyle=function(setName) {
        if(saving)return;
        cleanup();previousOpen(setName);
        if(!adminPin||!editingBinderStyle)return;
        $('binder-cover-source').value=editingBinderStyle.coverImage?'upload':'card';
        previewBinderCover();
    };
    previewBinderCover=function() {
        const uploading=$('binder-cover-source').value==='upload';
        cardGroup.hidden=uploading;$('binder-upload-box').hidden=!uploading;
        $('binder-upload-box').style.display=uploading?'block':'none';
        const card=allCards.find(c=>String(c.id)===$('binder-cover-select').value && String(c.set||'').trim()===editingBinderStyle?.setName);
        const url=uploading?(previewURL||editingBinderStyle?.coverImage||''):(card?.image||'');
        const image=$('binder-cover-preview');image.classList.toggle('hidden',!url);
        if(url){image.onerror=function(){this.onerror=null;this.src=CARD_PLACEHOLDER;};image.src=previewURL&&url===previewURL?url:getSafeImageUrl(url);}
        else image.removeAttribute('src');
        $('binder-upload-note').textContent=file?`${file.name} · จะอัปโหลดเมื่อกดบันทึก`:editingBinderStyle?.coverImage?'ใช้รูปที่อัปโหลดไว้ หรือเลือกรูปใหม่':'เลือกรูปก่อนกดบันทึก';
    };
    saveBinderStyle=async function(event) {
        event.preventDefault();if(saving||!editingBinderStyle||!adminPin)return;
        const uploading=$('binder-cover-source').value==='upload';
        if(uploading&&!file&&!editingBinderStyle.coverImage){showToast('เลือกรูปหน้าปกก่อนค่ะ','error');return;}
        if(typeof TcgTasks.enqueueBinderSettings!=='function'){showToast('เพิ่ม enqueueBinderSettings ใน background-tasks.js ก่อนค่ะ','error');return;}
        const payload={action:'saveBinderSettings',setName:editingBinderStyle.setName,expectedVersion:editingBinderStyle.settingsVersion,
            coverCardId:uploading?'':$('binder-cover-select').value,
            coverImage:uploading?(editingBinderStyle.coverImage||''):'',color:$('binder-color').value,pinned:$('binder-pinned').checked};
        const selected=uploading?file:null;
        const controls=[...modal.querySelectorAll('button,input,select')],disabled=controls.map(c=>c.disabled);
        saving=true;controls.forEach(c=>c.disabled=true);
        const button=event.target.querySelector('button[type="submit"]'),text=button.textContent;button.textContent='กำลังเก็บเข้าคิว…';
        try {
            await TcgTasks.enqueueBinderSettings(payload,selected);
            modal.close();showToast('☁️ รับงานแต่งปกเข้าคิวแล้ว รูปจะเปลี่ยนหลังบันทึกและซิงก์สำเร็จ');
        } catch(error){showToast(error.message,'error');}
        finally{saving=false;controls.forEach((c,i)=>c.disabled=disabled[i]);button.textContent=text;}
    };
    function ownedQty(cards) {
        return cards.reduce((sum,c)=>{const qty=Number(c.qty);return sum+(String(c.isWishlist).toLowerCase()!=='true'&&Number.isFinite(qty)&&qty>0?qty:0);},0);
    }
    function shelfGroups() {
        const groups=new Map();
        for(const card of allCards){const name=String(card.set||'').trim();if(name){if(!groups.has(name))groups.set(name,[]);groups.get(name).push(card);}}
        for(const style of allBinderSettings){const name=String(style.setName||'').trim();if(name&&!groups.has(name))groups.set(name,[]);}
        return [...groups].map(([name,cards])=>({name,cards,qty:ownedQty(cards),style:getBinderStyle(name)}))
            .sort((a,b)=>Number(b.qty>0)-Number(a.qty>0)||Number(b.style.pinned===true)-Number(a.style.pinned===true)||a.name.localeCompare(b.name,'th'));
    }
    renderBinderShelf=function() {
        const groups=shelfGroups();
        $('binder-shelf-grid').innerHTML=groups.map(({name,cards,qty,style})=>{
            const color=/^#[0-9a-f]{6}$/i.test(style.color)?style.color:'#065f46';
            const card=cards.find(c=>String(c.id)===String(style.coverCardId));
            const url=style.coverImage||card?.image||'';
            return `<div class="binder-shelf-item">
                <button type="button" class="set-binder" style="background:${color};border-left-color:#0005" data-set="${escapeHtml(name)}" onclick="openBinderFromShelf(this.dataset.set)">
                    ${url?`<img class="binder-cover-image" src="${escapeHtml(getSafeImageUrl(url))}" alt="${escapeHtml(name)}" loading="lazy" onerror="this.onerror=null;this.src=CARD_PLACEHOLDER">`:'<span class="binder-cover-icon" aria-hidden="true">📁</span>'}
                    <span class="set-binder-name" style="color:white;text-shadow:0 1px 3px #000">${style.pinned?'📌 ':''}${escapeHtml(name)}</span>
                    <span class="set-binder-count" style="color:white;background:#0006;padding:3px 8px;border-radius:8px">${qty>0?`มีแล้ว ${qty.toLocaleString()} ใบ`:'ยังไม่มีการ์ด'}</span>
                    <span class="block text-xs mt-4" style="color:white;text-shadow:0 1px 3px #000">เปิดแฟ้ม →</span>
                </button>
                <button type="button" class="binder-edit-button" data-set="${escapeHtml(name)}" onclick="openBinderStyle(this.dataset.set)">🎨 แต่งปก</button>
            </div>`;
        }).join('')||'<p class="col-span-full text-center text-sm text-gray-400 py-10">ยังไม่มี Set ในคลัง</p>';
    };
    const previousOpenShelf=openBinderFromShelf;
    openBinderFromShelf=function(setName) {
        const select=$('binder-set-select');
        if(![...select.options].some(option=>option.value===setName) && shelfGroups().some(group=>group.name===setName)) {
            const option=document.createElement('option');option.value=setName;option.textContent=setName;select.append(option);
        }
        previousOpenShelf(setName);
    };
    renderBinderShelf();
})();
